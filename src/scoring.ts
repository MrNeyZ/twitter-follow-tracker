import { SorsaUser, ScoreResult } from './types';
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
