import { SorsaUser, ScoreResult, ProjectClassification } from './types';
import { SCORE_KEYWORDS } from './config';

/**
 * Placeholder scoring for a newly-followed account.
 *
 * This is intentionally simple for the MVP — it produces a rough relevance
 * score from three signals:
 *   - follower count (log-scaled so whales don't dominate)
 *   - verified flag
 *   - bio keyword matches (solana, crypto, web3, ai, nft, memecoin, defi)
 *
 * Tune the weights later once real data is flowing.
 */
export function scoreUser(user: SorsaUser): ScoreResult {
  const matchedKeywords = matchKeywords(user.bio);

  // log10(followers) caps the contribution: ~1k -> 3, ~1M -> 6.
  const followerPoints =
    user.followersCount > 0 ? Math.log10(user.followersCount) : 0;
  const verifiedPoints = user.verified ? 5 : 0;
  const keywordPoints = matchedKeywords.length * 2;

  const score = Math.round((followerPoints + verifiedPoints + keywordPoints) * 10) / 10;

  return {
    score,
    verified: user.verified,
    followersCount: user.followersCount,
    matchedKeywords,
  };
}

export function matchKeywords(bio: string): string[] {
  if (!bio) return [];
  const lower = bio.toLowerCase();
  return SCORE_KEYWORDS.filter((kw) => {
    // Word-boundary-ish match so "ai" doesn't match inside "chain".
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(kw)}([^a-z0-9]|$)`, 'i');
    return re.test(lower);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Project-vs-person classification
// ---------------------------------------------------------------------------

/** Positive signals — words that suggest a project/protocol/app account. */
export const PROJECT_KEYWORDS = [
  'crypto', 'web3', 'solana', 'ai', 'defi', 'nft', 'protocol', 'launch',
  'app', 'chain', 'labs', 'studio', 'foundation', 'dao', 'agent', 'infra',
  'mainnet', 'testnet', 'token',
];

/** Negative signals — words that suggest an individual/personal account. */
export const PERSONAL_KEYWORDS = [
  'founder', 'trader', 'investor', 'angel', 'degen', 'shitposter',
  'opinions', 'views are my own', 'building at', 'prev', 'intern',
];

/** Alert thresholds (also referenced by the worker). */
export const PROJECT_ALERT_THRESHOLD = 70;
export const PROJECT_HIGH_SIGNAL_THRESHOLD = 85;

/** Extra context the worker can supply but scoring shouldn't have to fetch. */
export interface ClassificationContext {
  /**
   * How many watched influencers are known to follow this account.
   * Corroboration across multiple influencers is a strong project signal.
   */
  corroborationCount?: number;
}

/** True if `text` contains `kw` as a standalone word (e.g. "ai" not inside "email"). */
function hasWord(text: string, kw: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(kw)}([^a-z0-9]|$)`, 'i');
  return re.test(text);
}

function matchProjectKeywords(user: SorsaUser): string[] {
  const text = `${user.displayName ?? ''} ${user.bio}`.toLowerCase();
  const username = user.username.toLowerCase();
  const found = new Set<string>();
  for (const kw of PROJECT_KEYWORDS) {
    // Word-boundary match in name/bio; substring match in the (spaceless)
    // username, but only for longer keywords to avoid noise like "ai" in "dailyx".
    if (hasWord(text, kw) || (kw.length >= 4 && username.includes(kw))) {
      found.add(kw);
    }
  }
  return [...found];
}

function matchPersonalKeywords(user: SorsaUser): string[] {
  // Substring match so multi-word phrases ("views are my own") are caught.
  const text = `${user.displayName ?? ''} ${user.bio}`.toLowerCase();
  return PERSONAL_KEYWORDS.filter((kw) => text.includes(kw));
}

function hasWebsite(user: SorsaUser): boolean {
  if (user.url && user.url.trim() !== '') return true;
  return /\bhttps?:\/\//i.test(user.bio);
}

/** Rough "Firstname Lastname" detector for the human-name negative signal. */
function looksLikeHumanName(displayName?: string): boolean {
  if (!displayName) return false;
  return /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(displayName.trim());
}

/**
 * Classify a newly-followed account as project / personal / unknown with a
 * 0-100 projectScore. Deliberately heuristic — tune weights as real data lands.
 */
export function classifyAccount(
  user: SorsaUser,
  ctx: ClassificationContext = {}
): ProjectClassification {
  const reasons: string[] = [];
  let score = 50; // neutral baseline

  // --- positive signals ---
  const projectKw = matchProjectKeywords(user);
  if (projectKw.length > 0) {
    const pts = Math.min(projectKw.length * 8, 32);
    score += pts;
    reasons.push(`project keywords: ${projectKw.join(', ')} (+${pts})`);
  }

  if (hasWebsite(user)) {
    score += 10;
    reasons.push('has website/url (+10)');
  }

  if (user.followersCount >= 500 && user.followersCount <= 150_000) {
    score += 10;
    reasons.push('followers in 500-150k range (+10)');
  }

  const corroboration = ctx.corroborationCount ?? 0;
  if (corroboration >= 2) {
    score += 20;
    reasons.push(`followed by ${corroboration} watched influencers (+20)`);
  }

  // --- negative signals ---
  const personalKw = matchPersonalKeywords(user);
  if (personalKw.length > 0) {
    const pts = Math.min(personalKw.length * 12, 36);
    score -= pts;
    reasons.push(`personal keywords: ${personalKw.join(', ')} (-${pts})`);
  }

  if (user.followersCount > 500_000) {
    score -= 25;
    reasons.push('followers over 500k (-25)');
  }

  if (!user.bio.trim() && !hasWebsite(user)) {
    score -= 20;
    reasons.push('no bio and no website (-20)');
  }

  // Only penalise a human-name pattern when nothing else looks project-y,
  // so "Magic Eden"-style names with project bios aren't punished.
  if (projectKw.length === 0 && looksLikeHumanName(user.displayName)) {
    score -= 15;
    reasons.push('looks like a personal name (-15)');
  }

  const projectScore = Math.max(0, Math.min(100, Math.round(score)));

  let category: ProjectClassification['category'];
  if (projectScore >= 60) category = 'project';
  else if (projectScore <= 40) category = 'personal';
  else category = 'unknown';

  if (reasons.length === 0) reasons.push('no strong signals');

  return { projectScore, category, reasons };
}
