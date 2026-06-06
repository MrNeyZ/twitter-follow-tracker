import * as dotenv from 'dotenv';
import { AppConfig, WatchedInfluencer } from './types';

dotenv.config();

/**
 * Watched influencer list.
 *
 * `username` is required; `userId` is optional and skips the username -> id
 * resolution step when present (none resolved yet — username-only for now).
 *
 * Example:
 *   { username: 'VitalikButerin', label: 'Vitalik' },
 *   { username: 'cobie', userId: '123456789' },
 */
// `tier` controls per-account polling cost (see src/polling.ts):
//   super_vip = 2m (manual-only), vip = 5m, normal = 15m, slow = 60m,
//   disabled = never. Missing -> normal.
export const WATCHED_INFLUENCERS: WatchedInfluencer[] = [
  { username: '0xuberM', label: 'crypto-watch', tier: 'disabled' },
  { username: 'f1racecar1', label: 'crypto-watch', tier: 'normal' },
  { username: 'reznio_o', label: 'crypto-watch', tier: 'normal' },
  { username: 'diamondARS_', label: 'crypto-watch', tier: 'normal' },
  { username: 'gr3gor14n', label: 'crypto-watch', tier: 'normal' },
  { username: 'airtightfish', label: 'crypto-watch', tier: 'normal' },
  { username: 'astaso1', label: 'crypto-watch', tier: 'normal' },
  { username: 'VictoryHell_', label: 'self-test', tier: 'vip' },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export function loadConfig(): AppConfig {
  // Scheduler tick. Must be <= the smallest tier interval so every tier is
  // polled on time; a larger tick under-polls the tightest tier. Default 1 so
  // the super_vip=2m / vip=5m / normal=15m tiers are honored to the minute
  // (worst-case detection delay == the tier interval). A larger tick rounds
  // detection up to the tick.
  const pollIntervalMinutes = Number(optionalEnv('POLL_INTERVAL_MINUTES', '1'));
  if (!Number.isFinite(pollIntervalMinutes) || pollIntervalMinutes <= 0) {
    throw new Error('POLL_INTERVAL_MINUTES must be a positive number');
  }

  const provider = optionalEnv('TWITTER_PROVIDER', 'twitterapiio').toLowerCase();
  if (provider !== 'twitterapiio' && provider !== 'sorsa') {
    throw new Error(`TWITTER_PROVIDER must be "twitterapiio" or "sorsa" (got "${provider}")`);
  }

  // Followings page size per request (first page only). The twitterapi.io
  // followings endpoint has a minimum pageSize of 20: values below 20 are
  // clamped/floored up to 20. Billing is per returned user, tiered by page
  // size — 20–99 users = 3 credits/user — so the default pageSize=20 costs
  // 60 credits per influencer poll. That is the cheapest useful setting:
  // requesting <20 saves nothing (clamped to 20), and larger pages cost more
  // in total despite a lower per-user rate. Lower POLL_INTERVAL or influencer
  // count to cut spend, not this.
  const twitterApiPageSize = Number(optionalEnv('TWITTERAPI_PAGE_SIZE', '20'));
  if (!Number.isInteger(twitterApiPageSize) || twitterApiPageSize <= 0) {
    throw new Error('TWITTERAPI_PAGE_SIZE must be a positive integer');
  }

  // Count-gated polling (cost control): before the 60-credit followings fetch,
  // read the cheap (18-credit) profile `following` count and skip the fetch when
  // it hasn't moved. A full followings fetch is still forced every
  // TWITTERAPI_FULL_REBASELINE_HOURS to catch same-interval follow+unfollow churn
  // (which leaves the net count unchanged) and to refresh the snapshot.
  const twitterApiCountGateEnabled =
    optionalEnv('TWITTERAPI_COUNT_GATE_ENABLED', 'true').toLowerCase() === 'true';
  const twitterApiFullRebaselineHours = Number(optionalEnv('TWITTERAPI_FULL_REBASELINE_HOURS', '24'));
  if (!Number.isFinite(twitterApiFullRebaselineHours) || twitterApiFullRebaselineHours <= 0) {
    throw new Error('TWITTERAPI_FULL_REBASELINE_HOURS must be a positive number');
  }

  // Only the selected provider's API key is required; the other stays optional
  // so a twitterapi.io-only setup doesn't need a Sorsa key (and vice versa).
  return {
    provider,
    sorsaApiKey:
      provider === 'sorsa' ? requireEnv('SORSA_API_KEY') : optionalEnv('SORSA_API_KEY', ''),
    sorsaBaseUrl: optionalEnv('SORSA_BASE_URL', 'https://api.sorsa.io/v3'),
    twitterApiIoKey:
      provider === 'twitterapiio'
        ? requireEnv('TWITTERAPI_IO_KEY')
        : optionalEnv('TWITTERAPI_IO_KEY', ''),
    twitterApiIoBaseUrl: optionalEnv('TWITTERAPI_IO_BASE_URL', 'https://api.twitterapi.io'),
    twitterApiPageSize,
    twitterApiCountGateEnabled,
    twitterApiFullRebaselineHours,
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    telegramChatId: requireEnv('TELEGRAM_CHAT_ID'),
    discordWebhookUrl: requireEnv('DISCORD_WEBHOOK_URL'),
    // Per-channel alert toggles. Telegram defaults OFF, Discord defaults ON, so
    // a Discord-only setup never trips on placeholder Telegram credentials.
    alertTelegramEnabled: optionalEnv('ALERT_TELEGRAM_ENABLED', 'false').toLowerCase() === 'true',
    alertDiscordEnabled: optionalEnv('ALERT_DISCORD_ENABLED', 'true').toLowerCase() === 'true',
    pollIntervalMinutes,
    runOnce: optionalEnv('RUN_ONCE', 'false').toLowerCase() === 'true',
    dbPath: optionalEnv('DB_PATH', './data/tracker.db'),
    influencers: WATCHED_INFLUENCERS,
  };
}

/** Keywords used by the placeholder scoring step. */
export const SCORE_KEYWORDS = [
  'solana',
  'crypto',
  'web3',
  'ai',
  'nft',
  'memecoin',
  'defi',
];
