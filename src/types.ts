// Shared domain types for the follow tracker.

/** A normalized Twitter/X user as returned by the Sorsa provider. */
export interface SorsaUser {
  /** Sorsa / Twitter numeric user id (string to avoid bigint precision loss). */
  id: string;
  username: string;
  displayName?: string;
  followersCount: number;
  verified: boolean;
  bio: string;
}

/** An influencer we watch, loaded from config. */
export interface WatchedInfluencer {
  /** Twitter username/handle without the leading @. */
  username: string;
  /** Optional pre-resolved Sorsa/Twitter user id to skip username resolution. */
  userId?: string;
  /** Optional human label for logs/alerts. */
  label?: string;
}

/** A detected new-follow event, after scoring. */
export interface NewFollow {
  influencer: WatchedInfluencer;
  influencerId: string;
  followed: SorsaUser;
  score: ScoreResult;
}

/** Output of the placeholder scoring step. */
export interface ScoreResult {
  score: number;
  verified: boolean;
  followersCount: number;
  matchedKeywords: string[];
}

export interface AppConfig {
  sorsaApiKey: string;
  sorsaBaseUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
  pollIntervalMinutes: number;
  runOnce: boolean;
  dbPath: string;
  influencers: WatchedInfluencer[];
}
