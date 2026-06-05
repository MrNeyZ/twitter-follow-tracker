import { NewFollow } from '../types';
import { findContractAddress } from '../scoring';

/** Structured, presentation-ready data for the rendered PNG card (pure/testable). */
export interface CardModel {
  high: boolean;
  badge: string; // "HIGH PRIORITY" | "NEW FOLLOW"
  timestamp: string; // "3:24 AM" (no UTC suffix; template appends it). Empty if none.
  watcher: string; // influencer handle (no @)
  followed: string; // followed handle (no @)
  projectName: string; // display name or handle
  tagLine: string; // "PROJECT · UNVERIFIED" (category · verified)
  scoreValue: number; // projectScore (the big gradient number)
  relevance: string;
  followers: string;
  metrics: Array<{ label: string; value: string; mono?: boolean }>;
  chips: string[]; // all classification reasons, cleaned of score annotations
  token: { short: string; url: string } | null;
  influencerImageUrl?: string;
  followedImageUrl?: string;
}

export function buildCardModel(ev: NewFollow): CardModel {
  const f = ev.followed;
  const c = ev.classification;
  const high = c.highPriority;

  const addr = findContractAddress(f);
  const token = addr
    ? {
        short: `${addr.slice(0, 4)}…${addr.slice(-4)}`,
        url:
          c.caSignal === 'launchpad'
            ? `https://solscan.io/token/${addr}`
            : `https://solscan.io/account/${addr}`,
      }
    : null;

  return {
    high,
    badge: high ? 'HIGH PRIORITY' : 'NEW FOLLOW',
    timestamp: formatTimestamp(ev.detectedAt),
    watcher: ev.influencer.username,
    followed: f.username,
    projectName: f.displayName ?? f.username,
    tagLine: `${titleCase(c.category).toUpperCase()} · ${f.verified ? 'VERIFIED' : 'UNVERIFIED'}`,
    scoreValue: c.projectScore,
    relevance: String(ev.score.score),
    followers: compactNumber(f.followersCount),
    metrics: [
      { label: 'SCORE', value: `${c.projectScore}/100`, mono: true },
      { label: 'RELEVANCE', value: String(ev.score.score), mono: true },
      { label: 'FOLLOWERS', value: compactNumber(f.followersCount), mono: true },
      { label: 'CATEGORY', value: titleCase(c.category) },
      { label: 'VERIFIED', value: f.verified ? 'Yes' : 'No' },
      { label: 'KEYWORDS', value: ev.score.matchedKeywords.length ? ev.score.matchedKeywords.join(', ') : '—' },
    ],
    chips: c.reasons.map(cleanReason).filter((r) => r && r !== 'no strong signals'),
    token,
    influencerImageUrl: ev.influencerImageUrl,
    followedImageUrl: f.profileImageUrl,
  };
}

/** Strip the "(+12)" / "(-18)" score annotation from a reason string. */
function cleanReason(reason: string): string {
  return reason.replace(/\s*\([+-]\d+\)\s*$/, '').trim();
}

/** "3:24 AM" from an ISO timestamp (no UTC suffix); empty if missing/invalid. */
function formatTimestamp(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }
  const mm = n / 1_000_000;
  return `${mm < 10 ? mm.toFixed(1).replace(/\.0$/, '') : Math.round(mm)}M`;
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
