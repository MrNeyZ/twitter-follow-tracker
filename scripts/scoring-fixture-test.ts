/**
 * Golden-fixture test for the project-vs-person classifier.
 *
 * Loads tests/scoring-fixtures.json, runs classifyAccount() on each case, and
 * compares the resulting category / alert / high-signal decision against the
 * fixture's expectations. Prints a pass/fail table and exits non-zero on any
 * failure so it can gate a build / pre-commit.
 *
 * Usage:
 *   npx ts-node scripts/scoring-fixture-test.ts
 *
 * Note: fixtures are evaluated WITHOUT corroboration context (per-account
 * heuristic only); the multi-influencer signal is exercised by smoke-test.js.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SorsaUser } from '../src/types';
import {
  classifyAccount,
  PROJECT_ALERT_THRESHOLD,
  PROJECT_HIGH_SIGNAL_THRESHOLD,
} from '../src/scoring';

interface Fixture {
  name: string;
  note?: string;
  username: string;
  displayName: string;
  bio: string;
  url: string;
  followersCount: number;
  verified: boolean;
  /** Optional: how many watched influencers follow this account (corroboration). */
  corroborationCount?: number;
  expectedCategory: 'project' | 'personal' | 'unknown';
  shouldAlert: boolean;
  shouldHighSignal: boolean;
}

function loadFixtures(): Fixture[] {
  const file = path.resolve('tests/scoring-fixtures.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Fixtures not found at ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture[];
}

function toUser(f: Fixture): SorsaUser {
  return {
    id: f.username,
    username: f.username,
    displayName: f.displayName || undefined,
    followersCount: f.followersCount,
    verified: f.verified,
    bio: f.bio,
    url: f.url || undefined,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function main(): void {
  const fixtures = loadFixtures();
  let failures = 0;

  console.log(
    pad('fixture', 30),
    pad('corr', 5),
    pad('score', 6),
    pad('category', 18),
    pad('alert', 14),
    pad('high', 14),
    'result'
  );
  console.log('-'.repeat(105));

  for (const f of fixtures) {
    const c = classifyAccount(toUser(f), {
      corroborationCount: f.corroborationCount,
    });
    const alert = c.projectScore >= PROJECT_ALERT_THRESHOLD;
    const high = c.projectScore >= PROJECT_HIGH_SIGNAL_THRESHOLD;

    const catOk = c.category === f.expectedCategory;
    const alertOk = alert === f.shouldAlert;
    const highOk = high === f.shouldHighSignal;
    const ok = catOk && alertOk && highOk;
    if (!ok) failures++;

    const mark = (got: string, exp: string, good: boolean) =>
      good ? got : `${got}!=${exp}`;

    console.log(
      pad(f.name, 30),
      pad(String(f.corroborationCount ?? 0), 5),
      pad(String(c.projectScore), 6),
      pad(mark(c.category, f.expectedCategory, catOk), 18),
      pad(mark(String(alert), String(f.shouldAlert), alertOk), 14),
      pad(mark(String(high), String(f.shouldHighSignal), highOk), 14),
      ok ? 'PASS' : 'FAIL'
    );
    if (!ok) {
      console.log(`    reasons: ${c.reasons.join(' | ')}`);
    }
  }

  console.log('-'.repeat(100));
  const total = fixtures.length;
  console.log(`${total - failures}/${total} passed`);
  if (failures > 0) {
    console.error(`\n${failures} fixture(s) failed.`);
    process.exit(1);
  }
  console.log('All scoring fixtures passed.');
}

main();
