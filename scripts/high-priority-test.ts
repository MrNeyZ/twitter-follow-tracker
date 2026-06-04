/**
 * Offline unit test for the HIGH PRIORITY rule.
 *
 * HIGH PRIORITY is driven SOLELY by a Solana contract-address signal in the
 * account's text (plain CA or a pump/bonk launchpad-suffixed address) — NOT by
 * projectScore. This test pins that contract:
 *   - raw contract address            -> high priority TRUE
 *   - pump.fun launchpad address       -> high priority TRUE
 *   - bonk launchpad address           -> high priority TRUE
 *   - bare "$BONK" ticker only         -> high priority FALSE
 *   - high projectScore but no CA      -> high priority FALSE
 *
 * Both isHighPriority(user) and classifyAccount(user).highPriority are checked,
 * since the worker/alerts read the classification field.
 *
 * Usage: npx ts-node scripts/high-priority-test.ts
 */
import { SorsaUser } from '../src/types';
import { isHighPriority, classifyAccount } from '../src/scoring';

function user(partial: Partial<SorsaUser> & { username: string }): SorsaUser {
  return {
    id: partial.username,
    username: partial.username,
    displayName: partial.displayName,
    followersCount: partial.followersCount ?? 10000,
    verified: partial.verified ?? false,
    bio: partial.bio ?? '',
    url: partial.url,
  };
}

interface Case {
  name: string;
  user: SorsaUser;
  expected: boolean;
  /** Expected caSignal classification (sanity check alongside highPriority). */
  expectedSignal: 'launchpad' | 'ca' | null;
}

const cases: Case[] = [
  {
    name: 'raw contract address in bio',
    user: user({
      username: 'stealthdrop',
      bio: 'new drop 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      followersCount: 8000,
    }),
    expected: true,
    expectedSignal: 'ca',
  },
  {
    name: 'pump.fun launchpad address',
    user: user({
      username: 'freshmint',
      bio: 'CA: HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
      followersCount: 5000,
    }),
    expected: true,
    expectedSignal: 'launchpad',
  },
  {
    name: 'bonk launchpad address',
    user: user({
      username: 'barker',
      bio: 'ca CDBdbNqmrLu1PcgjrFG52yxg71QnFhBZcUE6PSFdbonk',
      followersCount: 5000,
    }),
    expected: true,
    expectedSignal: 'launchpad',
  },
  {
    name: 'bare $BONK ticker only (no address)',
    user: user({
      username: 'bonkfan',
      bio: '$BONK to the moon',
      followersCount: 5000,
    }),
    expected: false,
    expectedSignal: null,
  },
  {
    name: 'high projectScore but no CA (legit protocol)',
    user: user({
      username: 'aerodromefi',
      displayName: 'Aerodrome Finance',
      bio: 'The central liquidity hub and DeFi protocol on Base.',
      url: 'https://aerodrome.finance',
      followersCount: 95000,
      verified: true,
    }),
    expected: false,
    expectedSignal: null,
  },
];

function main(): void {
  let failures = 0;
  console.log('-- HIGH PRIORITY rule --\n');

  for (const c of cases) {
    const hp = isHighPriority(c.user);
    const cls = classifyAccount(c.user);
    const ok =
      hp === c.expected &&
      cls.highPriority === c.expected &&
      cls.caSignal === c.expectedSignal;
    if (!ok) failures++;

    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${c.name}\n` +
        `      highPriority=${hp} (expected ${c.expected}), ` +
        `caSignal=${cls.caSignal} (expected ${c.expectedSignal}), ` +
        `projectScore=${cls.projectScore}`
    );
  }

  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  if (failures > 0) {
    console.error(`${failures} high-priority case(s) failed.`);
    process.exit(1);
  }
  console.log('All high-priority cases passed.');
}

main();
