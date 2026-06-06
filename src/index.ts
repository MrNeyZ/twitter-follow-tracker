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
} from './scoring';
import { AppConfig, WatchedInfluencer, SorsaUser, NewFollow, FollowProvider } from './types';
import {
  effectiveTier,
  effectiveIntervalMinutes,
  isDue,
  estimateCost,
  formatCostEstimate,
  CREDITS_PER_POLL,
  GATE_CREDITS,
} from './polling';
import {
  loadInfluencerImages,
  getInfluencerImageUrl,
  INFLUENCER_IMAGES_FILENAME,
} from './influencer-images';
import * as path from 'path';

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

/** Per-cycle API spend tally, used to log the count-gate savings. */
export interface CycleStats {
  /** Due influencers actually processed this cycle. */
  polls: number;
  /** Count-gate (user/info) reads performed. */
  gateCalls: number;
  /** Followings (user/followings) fetches performed. */
  fetchCalls: number;
  /** Polls where the gate let us skip the followings fetch. */
  skips: number;
}

export function newCycleStats(): CycleStats {
  return { polls: 0, gateCalls: 0, fetchCalls: 0, skips: 0 };
}

/** Process a single influencer. Errors are caught by the caller per-influencer. */
export async function processInfluencer(
  inf: WatchedInfluencer,
  cfg: AppConfig,
  db: Db,
  provider: FollowProvider,
  telegram: TelegramAlerter,
  discord: DiscordAlerter,
  nowMs: number,
  stats: CycleStats
): Promise<void> {
  const label = inf.label ?? inf.username;

  // 1. Resolve username -> provider user id if not already provided.
  // Best-effort influencer avatar for the alert banner's left side. Precedence:
  // config imageUrl -> startup-loaded image cache (data/influencer-images.json)
  // -> pfp from the username resolution (Sorsa only). We never make an EXTRA
  // call just for the avatar inside the polling loop.
  let influencerId = inf.userId;
  let influencerImageUrl = inf.imageUrl ?? getInfluencerImageUrl(inf.username);
  if (!influencerId) {
    const resolved = await provider.getUserByUsername(inf.username);
    influencerId = resolved.id;
    influencerImageUrl = influencerImageUrl ?? resolved.profileImageUrl;
    if (!influencerId) {
      throw new Error(`Could not resolve user id for @${inf.username}`);
    }
  }

  db.upsertWatchedAccount(influencerId, inf);

  // Derive the timestamp from nowMs (the cycle clock) so the re-baseline timer
  // and stored times share one clock — in production nowMs is Date.now().
  const isoTime = new Date(nowMs).toISOString();
  const hasBaseline = db.hasBaseline(influencerId);
  const gateEnabled =
    cfg.twitterApiCountGateEnabled && typeof provider.getFollowingCount === 'function';

  // 2. Count gate (cost control): read the cheap profile `following` count and
  //    skip the 60-credit followings fetch when it hasn't moved — unless a daily
  //    full re-baseline is due. Providers without getFollowingCount, or with the
  //    gate disabled, always fetch (currentCount stays null).
  let currentCount: number | null = null;
  if (gateEnabled) {
    stats.gateCalls++;
    try {
      currentCount = await provider.getFollowingCount!(influencerId);
    } catch (err) {
      errLog(`  ${label}: count gate read failed (fail-open to fetch):`, asMessage(err));
      currentCount = null;
    }
  }

  if (gateEnabled && hasBaseline && currentCount !== null) {
    const storedCount = db.getFollowingCount(influencerId);
    const rebaselineDue = isDue(
      db.getLastFullFollowingsCheckAt(influencerId),
      cfg.twitterApiFullRebaselineHours * 60,
      nowMs
    );
    if (storedCount !== null && currentCount === storedCount && !rebaselineDue) {
      db.markChecked(influencerId, isoTime);
      stats.skips++;
      log(`  ${label}: COUNT_UNCHANGED_SKIP (following=${currentCount})`);
      return;
    }
    if (storedCount !== null && currentCount === storedCount && rebaselineDue) {
      log(
        `  ${label}: FULL_REBASELINE_FETCH (following=${currentCount}, ` +
          `≥${cfg.twitterApiFullRebaselineHours}h since last full fetch)`
      );
    } else {
      log(`  ${label}: COUNT_CHANGED_FETCH (following ${storedCount ?? '∅'} -> ${currentCount})`);
    }
  } else if (gateEnabled && hasBaseline && currentCount === null) {
    log(`  ${label}: COUNT_CHANGED_FETCH (gate read failed — fail-open fetch)`);
  }

  // 3. Fetch current following list (baseline / count changed / re-baseline /
  //    gating disabled). After any full fetch we record the profile count we
  //    gated on and reset the re-baseline timer.
  const following = await provider.getFollowing(influencerId);
  stats.fetchCalls++;
  log(`  ${label}: following count = ${following.length}`);

  const persistGateState = (): void => {
    if (!gateEnabled) return;
    if (currentCount !== null) db.setFollowingCount(influencerId, currentCount);
    db.markFullFollowingsCheck(influencerId, isoTime);
  };

  // 4. First successful run -> save baseline, do NOT alert.
  if (!hasBaseline) {
    db.replaceFollowingSnapshot(influencerId, following, isoTime);
    db.markBaselineDone(influencerId);
    persistGateState();
    db.markChecked(influencerId, isoTime);
    log(`  ${label}: baseline saved (${following.length} accounts), no alerts sent`);
    return;
  }

  // 5. Subsequent runs -> diff against stored snapshot.
  const knownIds = db.getCurrentFollowingIds(influencerId);
  const newlyFollowed: SorsaUser[] = following.filter(
    (u) => u.id && !knownIds.has(u.id)
  );

  log(`  ${label}: new follows = ${newlyFollowed.length}`);

  // Keep the snapshot fresh so these aren't re-detected next cycle.
  db.addToFollowingSnapshot(influencerId, newlyFollowed, isoTime);
  persistGateState();
  db.markChecked(influencerId, isoTime);

  // 6. Record + score + classify each new follow, dedupe via follow_events,
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
        detectedAt: isoTime,
        influencerImageUrl,
      };

      // Alert rule: below the threshold we keep the event but stay quiet.
      if (classification.projectScore < PROJECT_ALERT_THRESHOLD) {
        log(
          `  ${label}: saved (no alert) @${followed.username} ` +
            `[${classification.category}, projectScore=${classification.projectScore}]`
        );
        continue;
      }

      // HIGH PRIORITY is driven by a contract-address signal, not projectScore.
      const highPriority = classification.highPriority;
      await dispatchAlerts(event, telegram, discord, cfg);
      db.markEventAlerted(influencerId, followed.id);
      log(
        `  ${label}: alerted${highPriority ? ' [HIGH PRIORITY]' : ''} @${followed.username} ` +
          `[${classification.category}, projectScore=${classification.projectScore}, ` +
          `score=${score.score}, verified=${score.verified}] ` +
          `reasons=[${classification.reasons.join('; ')}]`
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
  discord: DiscordAlerter,
  cfg: AppConfig
): Promise<void> {
  // Only dispatch to enabled channels; a disabled channel is never called (so
  // placeholder creds can't fail). Enabled channels still run concurrently and
  // a failure in one doesn't block the other (Promise.allSettled).
  const channels: { label: string; send: Promise<void> }[] = [];
  if (cfg.alertTelegramEnabled) channels.push({ label: 'telegram', send: telegram.sendNewFollow(event) });
  if (cfg.alertDiscordEnabled) channels.push({ label: 'discord', send: discord.sendNewFollow(event) });
  if (channels.length === 0) return;

  const results = await Promise.allSettled(channels.map((c) => c.send));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      errLog(`    alert via ${channels[i].label} failed:`, asMessage(r.reason));
    }
  });
}

export async function runCycle(
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

  const stats = newCycleStats();

  // Tiered polling: the worker ticks on a fixed schedule, but each account is
  // only polled once its own tier interval has elapsed since last_checked_at.
  const nowMs = Date.now();
  for (const inf of cfg.influencers) {
    const label = inf.label ?? inf.username;
    const tier = effectiveTier(inf);

    if (tier === 'disabled') {
      log(`SKIP_DISABLED @${inf.username} (${label})`);
      continue;
    }

    const intervalMinutes = effectiveIntervalMinutes(inf) as number; // non-null: not disabled
    const lastChecked = db.getLastCheckedAtByUsername(inf.username);
    if (!isDue(lastChecked, intervalMinutes, nowMs)) {
      log(
        `SKIP_NOT_DUE @${inf.username} (tier=${tier}, interval=${intervalMinutes}m, ` +
          `last_checked=${lastChecked})`
      );
      continue;
    }

    try {
      log(
        `Processing @${inf.username}${inf.label ? ` (${inf.label})` : ''} ` +
          `[tier=${tier}, interval=${intervalMinutes}m]`
      );
      stats.polls++;
      await processInfluencer(inf, cfg, db, provider, telegram, discord, nowMs, stats);
    } catch (err) {
      // Isolate failures so one bad influencer never crashes the worker.
      errLog(`Influencer "${label}" failed:`, asMessage(err));
    }
  }

  for (const line of formatCycleSpend(stats)) log(line);
  log(`=== cycle end ===`);
}

/**
 * Per-cycle credit accounting: what we actually spent (gate reads + followings
 * fetches) vs. the ungated baseline (every processed poll fetching followings),
 * and the savings the count-gate produced this cycle.
 */
export function formatCycleSpend(stats: CycleStats): string[] {
  const actual = stats.gateCalls * GATE_CREDITS + stats.fetchCalls * CREDITS_PER_POLL;
  const ungated = stats.polls * CREDITS_PER_POLL;
  const saved = ungated - actual;
  const pct = ungated > 0 ? Math.round((saved / ungated) * 100) : 0;
  return [
    `credits: ${stats.gateCalls} gate×${GATE_CREDITS} + ${stats.fetchCalls} fetch×${CREDITS_PER_POLL} ` +
      `= ${actual} (${stats.skips} skipped); ungated baseline = ${ungated}; ` +
      `saved = ${saved} (${pct}%)`,
  ];
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
  // Load the influencer image cache once at startup (no per-cycle fetches).
  const imagesPath = path.join(path.dirname(cfg.dbPath), INFLUENCER_IMAGES_FILENAME);
  const cachedImages = loadInfluencerImages(imagesPath);
  log(`Influencer image cache: ${cachedImages} cached avatar(s) from ${imagesPath}`);
  for (const line of formatCostEstimate(estimateCost(cfg.influencers))) log(line);
  const telegram = new TelegramAlerter(cfg.telegramBotToken, cfg.telegramChatId);
  const discord = new DiscordAlerter(cfg.discordWebhookUrl);
  log(
    `Alerts: telegram=${cfg.alertTelegramEnabled ? 'on' : 'off'}, ` +
      `discord=${cfg.alertDiscordEnabled ? 'on' : 'off'}`
  );

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

// Only auto-run the worker when executed directly (`node dist/index.js`), so the
// module can be imported by tests/dry-runs without starting the polling loop.
if (require.main === module) {
  main().catch((err) => {
    errLog('Fatal error:', asMessage(err));
    process.exit(1);
  });
}
