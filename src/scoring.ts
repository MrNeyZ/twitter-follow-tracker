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

// Base58 alphabet (Bitcoin/Solana) — excludes 0, O, I, l. A Solana token mint
// address is a 32-44 char base58 string. We tokenize on non-base58 characters,
// so short tickers like "$BONK"/"$WIF" and ordinary words (and the bare label
// "ca") never reach the 32-char minimum and can't match.
const SOL_ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/**
 * Detect a Solana token contract address in the account's text fields.
 * Returns 'launchpad' if any address ends with a launchpad suffix (pump/bonk),
 * 'ca' for a plain contract address, or null if none is present. The label
 * "CA:"/"ca" is not required — a raw address-looking string is enough — and the
 * label alone (without an address) never triggers.
 */
export function detectContractAddress(user: SorsaUser): 'launchpad' | 'ca' | null {
  const text = `${user.username} ${user.displayName ?? ''} ${user.bio} ${user.url ?? ''}`;
  const tokens = text.match(SOL_ADDRESS_RE);
  if (!tokens) return null;
  if (tokens.some((t) => /(?:pump|bonk)$/.test(t))) return 'launchpad';
  return 'ca';
}

/**
 * Return the actual Solana contract address detected in the account's text
 * (the launchpad-suffixed token if present, else the first address-looking
 * token), or null if none. Used to build the Solscan link in alerts; does not
 * affect scoring. Mirrors detectContractAddress's text composition.
 */
export function findContractAddress(user: SorsaUser): string | null {
  const text = `${user.username} ${user.displayName ?? ''} ${user.bio} ${user.url ?? ''}`;
  const tokens = text.match(SOL_ADDRESS_RE);
  if (!tokens) return null;
  return tokens.find((t) => /(?:pump|bonk)$/.test(t)) ?? tokens[0];
}

/**
 * HIGH PRIORITY = a Solana contract address (plain or launchpad-suffixed) is
 * present in the account's text. This is deliberately decoupled from
 * projectScore: a high score alone (keywords, website, corroboration) does NOT
 * make an alert high priority — only a real CA / launchpad token address does.
 * Short tickers like "$BONK" and the bare label "ca" never qualify (see
 * detectContractAddress).
 */
export function isHighPriority(user: SorsaUser): boolean {
  return detectContractAddress(user) !== null;
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
  // Weights tuned against tests/scoring-fixtures.json (golden cases).
  const projectKw = matchProjectKeywords(user);
  if (projectKw.length > 0) {
    const pts = Math.min(projectKw.length * 11, 33);
    score += pts;
    reasons.push(`project keywords: ${projectKw.join(', ')} (+${pts})`);
  }

  const website = hasWebsite(user);
  if (website) {
    score += 12;
    reasons.push('has website/url (+12)');
  }

  // Reward the "newish project" follower band; whales are handled below.
  if (user.followersCount >= 1_000 && user.followersCount <= 250_000) {
    score += 12;
    reasons.push('followers in 1k-250k range (+12)');
  }

  const corroboration = ctx.corroborationCount ?? 0;
  if (corroboration >= 2) {
    score += 20;
    reasons.push(`followed by ${corroboration} watched influencers (+20)`);
  }

  // Token contract address is a strong project signal; a launchpad-suffixed
  // address (pump.fun / bonk) is stronger still. The same signal also drives
  // the HIGH PRIORITY label (see highPriority in the return value).
  const contract = detectContractAddress(user);
  if (contract === 'launchpad') {
    score += 30;
    reasons.push('launchpad token address in bio (+30)');
  } else if (contract === 'ca') {
    score += 25;
    reasons.push('contract address in bio (+25)');
  }

  // --- negative signals ---
  const personalKw = matchPersonalKeywords(user);
  if (personalKw.length > 0) {
    const pts = Math.min(personalKw.length * 13, 39);
    score -= pts;
    reasons.push(`personal keywords: ${personalKw.join(', ')} (-${pts})`);
  }

  const hugeFollowing = user.followersCount > 500_000;
  if (hugeFollowing) {
    score -= 25;
    reasons.push('followers over 500k (-25)');
  }

  if (!user.bio.trim() && !website) {
    score -= 18;
    reasons.push('no bio and no website (-18)');
  }

  // Unproven placeholder: tiny following AND no web presence. On its own this
  // shouldn't clear the alert bar on keywords alone — it needs corroboration
  // (multiple watched influencers) to surface.
  if (user.followersCount < 1_000 && !website) {
    score -= 15;
    reasons.push('very low followers and no website (-15)');
  }

  // Only penalise a human-name pattern when nothing else looks project-y,
  // so "Magic Eden"-style names with project bios aren't punished.
  const humanName = projectKw.length === 0 && looksLikeHumanName(user.displayName);
  if (humanName) {
    score -= 18;
    reasons.push('looks like a personal name (-18)');
  }

  const projectScore = Math.max(0, Math.min(100, Math.round(score)));

  // Category is not purely numeric: an account is only "personal" when there
  // is actual personal evidence (personal keywords, whale following, or a human
  // name). A low score with no such evidence is "unknown", not "personal" —
  // e.g. an empty low-info account is genuinely undetermined.
  const personalEvidence = personalKw.length > 0 || hugeFollowing || humanName;
  let category: ProjectClassification['category'];
  if (projectScore >= 65) category = 'project';
  else if (projectScore <= 40 && personalEvidence) category = 'personal';
  else category = 'unknown';

  if (reasons.length === 0) reasons.push('no strong signals');

  return {
    projectScore,
    category,
    reasons,
    caSignal: contract,
    highPriority: contract !== null,
  };
}
