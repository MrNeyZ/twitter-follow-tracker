// Per-account tiered polling + cost estimation (cost control).
//
// The worker wakes on a fixed scheduler tick (POLL_INTERVAL_MINUTES) but only
// polls accounts whose own tier interval has elapsed since last_checked_at.
// All logic here is pure (no DB, no clock) so it can be unit-tested offline.

import { WatchedInfluencer, InfluencerTier } from './types';

/** Every followings poll bills 60 credits (20 users x 3 credits — the floor). */
export const CREDITS_PER_POLL = 60;

/**
 * A profile (`/twitter/user/info`) read bills 18 credits ($0.18 / 1k profiles).
 * This is the cost of the count-gate check that can skip a 60-credit followings
 * fetch when the account's following count hasn't moved.
 */
export const GATE_CREDITS = 18;

/** Default poll interval (minutes) per tier. 'disabled' never polls. */
export const TIER_INTERVAL_MINUTES: Record<Exclude<InfluencerTier, 'disabled'>, number> = {
  vip: 10,
  normal: 30,
  slow: 60,
};

/** Resolve an influencer's effective tier (a missing tier means 'normal'). */
export function effectiveTier(inf: WatchedInfluencer): InfluencerTier {
  return inf.tier ?? 'normal';
}

/**
 * Effective poll interval in minutes for an influencer, or null if the account
 * is disabled (never poll). An explicit positive `pollIntervalMinutes` overrides
 * the tier default.
 */
export function effectiveIntervalMinutes(inf: WatchedInfluencer): number | null {
  if (effectiveTier(inf) === 'disabled') return null;
  if (inf.pollIntervalMinutes && inf.pollIntervalMinutes > 0) {
    return inf.pollIntervalMinutes;
  }
  return TIER_INTERVAL_MINUTES[effectiveTier(inf) as Exclude<InfluencerTier, 'disabled'>];
}

/**
 * Is an account due for polling? An account that has never been checked
 * (null/unparseable last_checked_at) is always due.
 */
export function isDue(
  lastCheckedAtIso: string | null | undefined,
  intervalMinutes: number,
  nowMs: number
): boolean {
  if (!lastCheckedAtIso) return true;
  const last = Date.parse(lastCheckedAtIso);
  if (Number.isNaN(last)) return true;
  const elapsedMinutes = (nowMs - last) / 60000;
  return elapsedMinutes >= intervalMinutes;
}

export interface TierCost {
  tier: InfluencerTier;
  count: number;
  /** Tier default interval (minutes), or null for disabled. */
  intervalMinutes: number | null;
  creditsPerDay: number;
}

export interface CostEstimate {
  perTier: TierCost[];
  totalCreditsPerDay: number;
  totalCreditsPerMonth: number;
}

/**
 * Estimate credit spend from the configured tiers, assuming every due account
 * is polled exactly on its interval and each poll costs CREDITS_PER_POLL.
 * Month is modeled as 30 days. Per-account pollIntervalMinutes overrides are
 * honored in the totals (and folded into their tier's creditsPerDay).
 */
export function estimateCost(influencers: WatchedInfluencer[]): CostEstimate {
  const order: InfluencerTier[] = ['vip', 'normal', 'slow', 'disabled'];
  const perTier: TierCost[] = order.map((tier) => {
    const members = influencers.filter((i) => effectiveTier(i) === tier);
    let creditsPerDay = 0;
    for (const inf of members) {
      const interval = effectiveIntervalMinutes(inf);
      if (interval === null) continue; // disabled: no spend
      const pollsPerDay = 1440 / interval;
      creditsPerDay += pollsPerDay * CREDITS_PER_POLL;
    }
    const intervalMinutes = tier === 'disabled' ? null : TIER_INTERVAL_MINUTES[tier];
    return { tier, count: members.length, intervalMinutes, creditsPerDay };
  });

  const totalCreditsPerDay = perTier.reduce((sum, t) => sum + t.creditsPerDay, 0);
  return {
    perTier,
    totalCreditsPerDay,
    totalCreditsPerMonth: totalCreditsPerDay * 30,
  };
}

/** Render the cost estimate as human-readable log lines. */
export function formatCostEstimate(est: CostEstimate): string[] {
  const lines: string[] = [];
  lines.push(`Cost estimate (${CREDITS_PER_POLL} credits/poll, 30-day month):`);
  for (const t of est.perTier) {
    const every = t.intervalMinutes === null ? 'never' : `every ${t.intervalMinutes}m`;
    lines.push(
      `  ${t.tier.padEnd(8)} x${t.count} (${every}): ` +
        `${Math.round(t.creditsPerDay)} credits/day`
    );
  }
  lines.push(
    `  TOTAL: ${Math.round(est.totalCreditsPerDay)} credits/day, ` +
      `${Math.round(est.totalCreditsPerMonth)} credits/month`
  );
  return lines;
}
