import { loadConfig } from './config';
import { Db } from './db';
import { SorsaProvider } from './providers/sorsa';
import { TwitterApiIoProvider } from './providers/twitterapiio';
import { TelegramAlerter } from './alerts/telegram';
import { DiscordAlerter } from './alerts/discord';
import {
  scoreUser,
  classifyAccount,
  PROJECT_ALERT_THRESHOLD,
  PROJECT_HIGH_SIGNAL_THRESHOLD,
} from './scoring';
import { AppConfig, WatchedInfluencer, SorsaUser, NewFollow, FollowProvider } from './types';

/** Build the follow-data provider selected by config (TWITTER_PROVIDER). */
function createProvider(cfg: AppConfig): FollowProvider {
  if (cfg.provider === 'sorsa') {
    return new SorsaProvider(cfg.sorsaApiKey, cfg.sorsaBaseUrl);
  }
  return new TwitterApiIoProvider(
    cfg.twitterApiIoKey,
    cfg.twitterApiIoBaseUrl,
    cfg.twitterApiPageSize
  );
}

function log(...args: unknown[]): void {
  console.log(`[${nowIso()}]`, ...args);
}
function errLog(...args: unknown[]): void {
  console.error(`[${nowIso()}]`, ...args);
}
function nowIso(): string {
  return new Date().toISOString();
}

/** Process a single influencer. Errors are caught by the caller per-influencer. */
async function processInfluencer(
  inf: WatchedInfluencer,
  cfg: AppConfig,
  db: Db,
  provider: FollowProvider,
  telegram: TelegramAlerter,
  discord: DiscordAlerter
): Promise<void> {
  const label = inf.label ?? inf.username;

  // 1. Resolve username -> provider user id if not already provided.
  let influencerId = inf.userId;
  if (!influencerId) {
    const resolved = await provider.getUserByUsername(inf.username);
    influencerId = resolved.id;
    if (!influencerId) {
      throw new Error(`Could not resolve user id for @${inf.username}`);
    }
  }

  db.upsertWatchedAccount(influencerId, inf);

  // 2. Fetch current following list.
  const following = await provider.getFollowing(influencerId);
  log(`  ${label}: following count = ${following.length}`);

  const isoTime = nowIso();

  // 3. First successful run -> save baseline, do NOT alert.
  if (!db.hasBaseline(influencerId)) {
    db.replaceFollowingSnapshot(influencerId, following, isoTime);
    db.markBaselineDone(influencerId);
    db.markChecked(influencerId, isoTime);
    log(`  ${label}: baseline saved (${following.length} accounts), no alerts sent`);
    return;
  }

  // 4. Subsequent runs -> diff against stored snapshot.
  const knownIds = db.getCurrentFollowingIds(influencerId);
  const newlyFollowed: SorsaUser[] = following.filter(
    (u) => u.id && !knownIds.has(u.id)
  );

  log(`  ${label}: new follows = ${newlyFollowed.length}`);

  // Keep the snapshot fresh so these aren't re-detected next cycle.
  db.addToFollowingSnapshot(influencerId, newlyFollowed, isoTime);
  db.markChecked(influencerId, isoTime);

  // 5 + 6. Record + score + classify each new follow, dedupe via follow_events,
  // then alert only if it looks like a project (projectScore >= threshold).
  for (const followed of newlyFollowed) {
    try {
      const score = scoreUser(followed);
      const corroboration = db.countInfluencersFollowing(followed.id);
      const classification = classifyAccount(followed, {
        corroborationCount: corroboration,
      });

      // insertFollowEvent returns false if the (influencer, followed) pair
      // already exists -> prevents duplicate alerts. The event is saved
      // regardless of score; only the *alert* is gated below.
      const isNew = db.insertFollowEvent(influencerId, followed, score, isoTime);
      if (!isNew) {
        continue;
      }

      const event: NewFollow = {
        influencer: inf,
        influencerId,
        followed,
        score,
        classification,
      };

      // Alert rule: below the threshold we keep the event but stay quiet.
      if (classification.projectScore < PROJECT_ALERT_THRESHOLD) {
        log(
          `  ${label}: saved (no alert) @${followed.username} ` +
            `[${classification.category}, projectScore=${classification.projectScore}]`
        );
        continue;
      }

      const highSignal = classification.projectScore >= PROJECT_HIGH_SIGNAL_THRESHOLD;
      await dispatchAlerts(event, telegram, discord);
      db.markEventAlerted(influencerId, followed.id);
      log(
        `  ${label}: alerted${highSignal ? ' [HIGH SIGNAL]' : ''} @${followed.username} ` +
          `[${classification.category}, projectScore=${classification.projectScore}, ` +
          `score=${score.score}, verified=${score.verified}]`
      );
    } catch (err) {
      // Don't let one bad follow event abort the rest of the influencer's batch.
      errLog(`  ${label}: error handling follow @${followed.username}:`, asMessage(err));
    }
  }
}

async function dispatchAlerts(
  event: NewFollow,
  telegram: TelegramAlerter,
  discord: DiscordAlerter
): Promise<void> {
  // Send to both channels; a failure in one shouldn't block the other.
  const results = await Promise.allSettled([
    telegram.sendNewFollow(event),
    discord.sendNewFollow(event),
  ]);
  const labels = ['telegram', 'discord'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      errLog(`    alert via ${labels[i]} failed:`, asMessage(r.reason));
    }
  });
}

async function runCycle(
  cfg: AppConfig,
  db: Db,
  provider: FollowProvider,
  telegram: TelegramAlerter,
  discord: DiscordAlerter
): Promise<void> {
  log(`=== cycle start: ${cfg.influencers.length} influencer(s) ===`);

  if (cfg.influencers.length === 0) {
    log('No influencers configured. Add entries to WATCHED_INFLUENCERS in src/config.ts.');
  }

  for (const inf of cfg.influencers) {
    const label = inf.label ?? inf.username;
    try {
      log(`Processing @${inf.username}${inf.label ? ` (${inf.label})` : ''}`);
      await processInfluencer(inf, cfg, db, provider, telegram, discord);
    } catch (err) {
      // Isolate failures so one bad influencer never crashes the worker.
      errLog(`Influencer "${label}" failed:`, asMessage(err));
    }
  }

  log(`=== cycle end ===`);
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = new Db(cfg.dbPath);
  const provider = createProvider(cfg);
  log(`Provider: ${cfg.provider}`);
  const telegram = new TelegramAlerter(cfg.telegramBotToken, cfg.telegramChatId);
  const discord = new DiscordAlerter(cfg.discordWebhookUrl);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down...`);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (cfg.runOnce) {
    await runCycle(cfg, db, provider, telegram, discord);
    db.close();
    return;
  }

  const intervalMs = cfg.pollIntervalMinutes * 60 * 1000;
  log(`Worker started. Polling every ${cfg.pollIntervalMinutes} minute(s).`);

  // Run forever: one cycle, sleep, repeat. A thrown cycle is logged, not fatal.
  while (!shuttingDown) {
    try {
      await runCycle(cfg, db, provider, telegram, discord);
    } catch (err) {
      errLog('Cycle crashed unexpectedly:', asMessage(err));
    }
    if (shuttingDown) break;
    await sleep(intervalMs);
  }
}

main().catch((err) => {
  errLog('Fatal error:', asMessage(err));
  process.exit(1);
});
