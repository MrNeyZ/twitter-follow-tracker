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
export const WATCHED_INFLUENCERS: WatchedInfluencer[] = [
  { username: '0xuberM', label: 'crypto-watch' },
  { username: 'f1racecar1', label: 'crypto-watch' },
  { username: 'reznio_o', label: 'crypto-watch' },
  { username: 'diamondARS_', label: 'crypto-watch' },
  { username: 'gr3gor14n', label: 'crypto-watch' },
  { username: 'airtightfish', label: 'crypto-watch' },
  { username: 'astaso1', label: 'crypto-watch' },
  { username: 'VictoryHell_', label: 'self-test' },
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
  const pollIntervalMinutes = Number(optionalEnv('POLL_INTERVAL_MINUTES', '15'));
  if (!Number.isFinite(pollIntervalMinutes) || pollIntervalMinutes <= 0) {
    throw new Error('POLL_INTERVAL_MINUTES must be a positive number');
  }

  return {
    sorsaApiKey: requireEnv('SORSA_API_KEY'),
    sorsaBaseUrl: optionalEnv('SORSA_BASE_URL', 'https://api.sorsa.io/v3'),
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    telegramChatId: requireEnv('TELEGRAM_CHAT_ID'),
    discordWebhookUrl: requireEnv('DISCORD_WEBHOOK_URL'),
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
