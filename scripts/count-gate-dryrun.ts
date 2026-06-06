/**
 * Offline dry run for count-gated polling. Drives the REAL processInfluencer()
 * over a temp DB with a MOCK provider (no live API, no credits, no alerts) and a
 * synthetic clock, exercising every gate path and printing the savings line:
 *
 *   baseline  -> fetch          (first run)
 *   unchanged -> COUNT_UNCHANGED_SKIP
 *   changed   -> COUNT_CHANGED_FETCH
 *   24h stale -> FULL_REBASELINE_FETCH
 *
 * Also verifies the DB migration is idempotent. Asserts the expected gate/fetch
 * tallies and exits non-zero on mismatch (doubles as a test).
 *
 * Usage: npx ts-node scripts/count-gate-dryrun.ts
 */
import * as fs from 'fs';
import { Db } from '../src/db';
import { TelegramAlerter } from '../src/alerts/telegram';
import { DiscordAlerter } from '../src/alerts/discord';
import {
  processInfluencer,
  newCycleStats,
  formatCycleSpend,
} from '../src/index';
import { AppConfig, FollowProvider, SorsaUser, WatchedInfluencer } from '../src/types';

const DB_PATH = '/tmp/count-gate-dryrun.db';

/** Scriptable provider: the driver sets `count` and `following` per poll. */
class MockProvider implements FollowProvider {
  count = 0;
  following: SorsaUser[] = [];
  infoCalls = 0;
  followingCalls = 0;

  async getUserByUsername(username: string): Promise<SorsaUser> {
    return { id: username, username, followersCount: 0, verified: false, bio: '' };
  }
  async getFollowing(_id: string): Promise<SorsaUser[]> {
    this.followingCalls++;
    return this.following;
  }
  async getFollowingCount(_id: string): Promise<number | null> {
    this.infoCalls++;
    return this.count;
  }
}

function user(n: number): SorsaUser {
  return { id: `u${n}`, username: `u${n}`, followersCount: 100, verified: false, bio: 'hello' };
}

function baseConfig(inf: WatchedInfluencer): AppConfig {
  return {
    provider: 'twitterapiio',
    sorsaApiKey: '',
    sorsaBaseUrl: '',
    twitterApiIoKey: 'x',
    twitterApiIoBaseUrl: 'https://api.twitterapi.io',
    twitterApiPageSize: 20,
    twitterApiCountGateEnabled: true,
    twitterApiFullRebaselineHours: 24,
    telegramBotToken: 'x',
    telegramChatId: 'x',
    discordWebhookUrl: 'x',
    alertTelegramEnabled: false, // alerts OFF — dry run never sends
    alertDiscordEnabled: false,
    pollIntervalMinutes: 10,
    runOnce: true,
    dbPath: DB_PATH,
    influencers: [inf],
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

async function main(): Promise<void> {
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(DB_PATH + '-wal', { force: true });
  fs.rmSync(DB_PATH + '-shm', { force: true });

  // Idempotent-migration check: construct twice, then assert new columns exist.
  new Db(DB_PATH).close();
  const db = new Db(DB_PATH);
  const cols = (db as unknown as { db: any }).db
    .prepare(`PRAGMA table_info(watched_accounts)`)
    .all()
    .map((c: { name: string }) => c.name);
  for (const need of ['following_count', 'last_full_followings_check_at']) {
    if (!cols.includes(need)) throw new Error(`migration missing column: ${need}`);
  }
  console.log('migration OK (idempotent): columns =', cols.join(', '), '\n');

  const inf: WatchedInfluencer = { username: 'demo', label: 'demo', tier: 'vip' };
  const cfg = baseConfig(inf);
  const provider = new MockProvider();
  const telegram = new TelegramAlerter('x', 'x');
  const discord = new DiscordAlerter('x');
  const stats = newCycleStats();

  // 20-account following set; the "changed" poll appends one new follow.
  provider.following = Array.from({ length: 20 }, (_v, i) => user(i + 1));
  provider.count = 100;

  // Synthetic timeline: 12 polls, 11 min apart; poll 7 changes the count, poll
  // 12 is unchanged-but-stale (jump +25h) to trip the daily re-baseline.
  let t = Date.UTC(2026, 5, 6, 12, 0, 0);
  const plan: Array<{ n: number; note: string; mutate?: () => void; jumpHours?: number }> = [
    { n: 1, note: 'baseline (first run -> fetch)' },
    { n: 2, note: 'unchanged -> expect SKIP' },
    { n: 3, note: 'unchanged -> expect SKIP' },
    { n: 4, note: 'unchanged -> expect SKIP' },
    { n: 5, note: 'unchanged -> expect SKIP' },
    { n: 6, note: 'unchanged -> expect SKIP' },
    {
      n: 7,
      note: 'count 100 -> 101 -> expect COUNT_CHANGED_FETCH',
      mutate: () => {
        provider.count = 101;
        provider.following = [...provider.following, user(21)];
      },
    },
    { n: 8, note: 'unchanged -> expect SKIP' },
    { n: 9, note: 'unchanged -> expect SKIP' },
    { n: 10, note: 'unchanged -> expect SKIP' },
    { n: 11, note: 'unchanged -> expect SKIP' },
    { n: 12, note: 'unchanged but +25h -> expect FULL_REBASELINE_FETCH', jumpHours: 25 },
  ];

  for (const step of plan) {
    if (step.mutate) step.mutate();
    t += (step.jumpHours ? step.jumpHours * HOUR : 11 * MIN);
    console.log(`--- poll ${step.n}: ${step.note}  [t=${new Date(t).toISOString()}] ---`);
    stats.polls++;
    await processInfluencer(inf, cfg, db, provider, telegram, discord, t, stats);
  }

  console.log('\n=== cycle spend (aggregated over the 12 polls) ===');
  for (const line of formatCycleSpend(stats)) console.log(line);
  console.log(
    `provider calls: user/info=${provider.infoCalls}, user/followings=${provider.followingCalls}`
  );

  // Assertions (12 gate reads, 3 fetches: baseline + changed + rebaseline, 9 skips).
  const expect = { polls: 12, gateCalls: 12, fetchCalls: 3, skips: 9 };
  const got = { polls: stats.polls, gateCalls: stats.gateCalls, fetchCalls: stats.fetchCalls, skips: stats.skips };
  const ok = (Object.keys(expect) as Array<keyof typeof expect>).every((k) => expect[k] === got[k]);
  console.log('\nexpected:', JSON.stringify(expect));
  console.log('actual  :', JSON.stringify(got));
  db.close();
  if (!ok) {
    console.error('DRY RUN FAILED: gate/fetch tallies did not match expectation.');
    process.exit(1);
  }
  console.log('\nDRY RUN PASSED ✓');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
