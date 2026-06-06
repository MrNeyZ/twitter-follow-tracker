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
  /** Profile website/url, if the provider returns one. */
  url?: string;
  /** Profile picture URL, if the provider returns one (used in alert cards). */
  profileImageUrl?: string;
  /** Profile banner/header image URL, if available (large image in cards). */
  bannerUrl?: string;
}

/**
 * Common shape every follow-data provider must expose. Both SorsaProvider and
 * TwitterApiIoProvider satisfy this structurally, so the worker can swap
 * between them via config without code changes.
 */
export interface FollowProvider {
  getUserByUsername(username: string): Promise<SorsaUser>;
  getFollowing(userId: string): Promise<SorsaUser[]>;
  /**
   * Optional cheap profile read returning the account's *following* count, used
   * to gate the (more expensive) getFollowing call: if the count hasn't moved
   * since last cycle we can skip the followings fetch. Returns null if the count
   * can't be determined. Providers that don't implement this are never gated
   * (the worker always fetches followings for them).
   */
  getFollowingCount?(userId: string): Promise<number | null>;
}

/**
 * Polling tier for a watched account (cost control). Intervals in src/polling.ts:
 *   super_vip = 2 min (manual-only — assign by hand for a hot account),
 *   vip = 5 min, normal = 15 min, slow = 60 min, disabled = never poll.
 * A missing tier is treated as 'normal'.
 */
export type InfluencerTier = 'super_vip' | 'vip' | 'normal' | 'slow' | 'disabled';

/** An influencer we watch, loaded from config. */
export interface WatchedInfluencer {
  /** Twitter username/handle without the leading @. */
  username: string;
  /** Optional pre-resolved Sorsa/Twitter user id to skip username resolution. */
  userId?: string;
  /** Optional human label for logs/alerts. */
  label?: string;
  /** Polling tier (cost control). Missing -> 'normal'. */
  tier?: InfluencerTier;
  /** Explicit per-account poll interval in minutes; overrides the tier default. */
  pollIntervalMinutes?: number;
  /**
   * Optional profile-picture URL for this influencer, used as the author icon
   * in alert cards. Best-effort: the polling path does not fetch it (would cost
   * an extra API call), so set it here if you want the follower's avatar shown.
   */
  imageUrl?: string;
}

/** A detected new-follow event, after scoring. */
export interface NewFollow {
  influencer: WatchedInfluencer;
  influencerId: string;
  followed: SorsaUser;
  score: ScoreResult;
  classification: ProjectClassification;
  /** ISO timestamp the follow was detected (used for the HH:MM UTC in cards). */
  detectedAt?: string;
  /**
   * Best-effort profile-picture URL for the influencer who followed (author
   * icon in cards). May be undefined when the polling path doesn't fetch the
   * influencer's profile — see WatchedInfluencer.imageUrl.
   */
  influencerImageUrl?: string;
}

/** Output of the placeholder scoring step. */
export interface ScoreResult {
  score: number;
  verified: boolean;
  followersCount: number;
  matchedKeywords: string[];
}

/**
 * Project-vs-person classification of a newly-followed account.
 * Drives the alert decision (see scoring.ts for thresholds).
 */
export interface ProjectClassification {
  /** 0-100. Higher = more likely a project/protocol account. */
  projectScore: number;
  category: 'project' | 'personal' | 'unknown';
  /** Human-readable signals that contributed to the score. */
  reasons: string[];
  /**
   * Solana contract-address signal found in the account's text fields:
   *   'launchpad' = address with a pump/bonk launchpad suffix,
   *   'ca'        = a plain contract address,
   *   null        = none.
   */
  caSignal: 'launchpad' | 'ca' | null;
  /**
   * True iff a contract address is present (caSignal !== null). This — NOT the
   * projectScore — is what drives the HIGH PRIORITY label/colour in alerts.
   */
  highPriority: boolean;
}

export type ProviderName = 'twitterapiio' | 'sorsa';

export interface AppConfig {
  provider: ProviderName;
  sorsaApiKey: string;
  sorsaBaseUrl: string;
  twitterApiIoKey: string;
  twitterApiIoBaseUrl: string;
  twitterApiPageSize: number;
  /** Gate the followings fetch behind a cheap profile following-count check. */
  twitterApiCountGateEnabled: boolean;
  /** Force a full followings fetch at least every N hours per influencer. */
  twitterApiFullRebaselineHours: number;
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
  /** Per-channel alert toggles (Telegram defaults off, Discord defaults on). */
  alertTelegramEnabled: boolean;
  alertDiscordEnabled: boolean;
  pollIntervalMinutes: number;
  runOnce: boolean;
  dbPath: string;
  influencers: WatchedInfluencer[];
}
