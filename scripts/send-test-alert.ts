/**
 * Sends a TEST follow alert to the configured Discord webhook so the rendered
 * card can be eyeballed in the real channel. Uses the production send path
 * (DiscordAlerter.sendNewFollow -> renderCard -> webhook).
 *
 * Usage:
 *   npx ts-node scripts/send-test-alert.ts          # high + green
 *   npx ts-node scripts/send-test-alert.ts high     # high only
 *   npx ts-node scripts/send-test-alert.ts green     # green/normal only
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { NewFollow } from '../src/types';
import { scoreUser, classifyAccount } from '../src/scoring';
import { DiscordAlerter } from '../src/alerts/discord';
import { closeCardBrowser } from '../src/alerts/card';

// Sanitized test data — neutral placeholder handles, no real accounts. The CA
// in the high-priority bio is the well-known sample pump address used in unit
// tests (drives the HIGH PRIORITY rule), not a live token.
function makeEvent(high: boolean): NewFollow {
  const followed = {
    id: '111',
    username: 'sample_project',
    displayName: 'Sample',
    followersCount: high ? 128000 : 24000,
    verified: false,
    bio: high
      ? '[TEST] sample project on solana. CA: HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump'
      : '[TEST] sample community project on solana.',
    url: undefined as string | undefined,
    profileImageUrl: undefined as string | undefined,
  };
  return {
    influencer: { username: 'tracker_test', imageUrl: undefined },
    influencerId: '999',
    followed,
    score: scoreUser(followed),
    classification: classifyAccount(followed),
    detectedAt: '2026-06-05T03:24:00.000Z',
    influencerImageUrl: undefined,
  };
}

async function main(): Promise<void> {
  const which = (process.argv[2] || 'both').toLowerCase();
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set in .env');

  const alerter = new DiscordAlerter(url);
  const targets: boolean[] =
    which === 'high' ? [true] : which === 'green' || which === 'normal' ? [false] : [true, false];

  for (const high of targets) {
    const ev = makeEvent(high);
    const isHigh = ev.classification.highPriority;
    console.log(`sending ${high ? 'HIGH PRIORITY' : 'GREEN/NORMAL'} test alert (highPriority=${isHigh}) ...`);
    await alerter.sendNewFollow(ev);
    console.log('  ✓ delivered to Discord');
  }
  await closeCardBrowser();
}

main().catch((err) => {
  console.error('send failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
