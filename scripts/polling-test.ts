/**
 * Offline unit test for tiered polling logic (no DB, no network).
 *
 * Exercises tier resolution, effective intervals, due/not-due decisions, and
 * the credit cost estimate. Exits non-zero on any failure so it can gate a
 * build / pre-commit.
 *
 * Usage:
 *   npx ts-node scripts/polling-test.ts
 */
import { WatchedInfluencer } from '../src/types';
import {
  effectiveTier,
  effectiveIntervalMinutes,
  isDue,
  estimateCost,
  TIER_INTERVAL_MINUTES,
  CREDITS_PER_POLL,
} from '../src/polling';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('ok  -', msg);
  } else {
    console.error('FAIL:', msg);
    failures++;
  }
}

// A fixed "now" so the test is deterministic.
const NOW = Date.parse('2026-06-03T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

// --- tier resolution ---
assert(effectiveTier({ username: 'a' }) === 'normal', 'missing tier defaults to normal');
assert(effectiveTier({ username: 'a', tier: 'vip' }) === 'vip', 'explicit tier is respected');

// --- effective interval ---
assert(effectiveIntervalMinutes({ username: 'a', tier: 'vip' }) === TIER_INTERVAL_MINUTES.vip, 'vip -> tier default');
assert(effectiveIntervalMinutes({ username: 'a' }) === TIER_INTERVAL_MINUTES.normal, 'normal -> tier default');
assert(effectiveIntervalMinutes({ username: 'a', tier: 'slow' }) === TIER_INTERVAL_MINUTES.slow, 'slow -> 60m');
assert(effectiveIntervalMinutes({ username: 'a', tier: 'disabled' }) === null, 'disabled -> null (never)');
assert(
  effectiveIntervalMinutes({ username: 'a', tier: 'normal', pollIntervalMinutes: 5 }) === 5,
  'explicit pollIntervalMinutes overrides tier default'
);

// --- due / not-due ---
assert(isDue(null, 30, NOW) === true, 'never-checked account is always due');
assert(isDue('not-a-date', 30, NOW) === true, 'unparseable timestamp is treated as due');
assert(isDue(minsAgo(40), 30, NOW) === true, 'checked 40m ago, 30m interval -> due');
assert(isDue(minsAgo(20), 30, NOW) === false, 'checked 20m ago, 30m interval -> NOT due');
assert(isDue(minsAgo(30), 30, NOW) === true, 'exactly at interval -> due (>=)');
assert(isDue(minsAgo(9), 10, NOW) === false, 'vip checked 9m ago, 10m interval -> NOT due');
assert(isDue(minsAgo(11), 10, NOW) === true, 'vip checked 11m ago, 10m interval -> due');

// --- cost estimate ---
// 1 vip, 2 normal (n2 has no tier -> normal), 1 disabled (0). Interval-agnostic:
// expected spend is derived from TIER_INTERVAL_MINUTES so it tracks tier tuning.
const list: WatchedInfluencer[] = [
  { username: 'vip1', tier: 'vip' },
  { username: 'n1', tier: 'normal' },
  { username: 'n2' }, // missing -> normal
  { username: 'off', tier: 'disabled' },
];
const est = estimateCost(list);
const vipCredits = (1440 / TIER_INTERVAL_MINUTES.vip) * CREDITS_PER_POLL;
const normalCredits = 2 * (1440 / TIER_INTERVAL_MINUTES.normal) * CREDITS_PER_POLL;
assert(est.totalCreditsPerDay === vipCredits + normalCredits, `daily credits = ${vipCredits + normalCredits}`);
assert(est.totalCreditsPerMonth === est.totalCreditsPerDay * 30, 'monthly = daily * 30');
const disabledTier = est.perTier.find((t) => t.tier === 'disabled');
assert(!!disabledTier && disabledTier.count === 1 && disabledTier.creditsPerDay === 0, 'disabled tier costs 0 credits');

if (failures > 0) {
  console.error(`\n${failures} polling assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll polling tests passed.');
