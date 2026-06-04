/**
 * Offline preview of the banner-first Discord alert — no network calls.
 *
 *  - generates a sample banner from FAKE local avatars (Sharp, no fetch),
 *  - saves it to data/sample-follow-banner.png,
 *  - prints the sanitized embed payloads for one HIGH PRIORITY and one NORMAL
 *    alert (the embed.image references the attached banner).
 *
 * Usage: npx ts-node scripts/discord-card-preview.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { NewFollow } from '../src/types';
import { scoreUser, classifyAccount } from '../src/scoring';
import { buildEmbed } from '../src/alerts/discord';
import {
  composeBanner,
  generateFollowBanner,
  BANNER_WIDTH,
  BANNER_HEIGHT,
} from '../src/alerts/banner';

/** A fake avatar (square SVG buffer) — stands in for a downloaded profile pic. */
function fakeAvatar(c1: string, c2: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>` +
      `</linearGradient></defs>` +
      `<rect width="256" height="256" fill="url(#g)"/>` +
      `<circle cx="128" cy="100" r="46" fill="#ffffff" opacity="0.85"/>` +
      `<rect x="58" y="160" width="140" height="80" rx="40" fill="#ffffff" opacity="0.85"/>` +
      `</svg>`
  );
}

function makeEvent(opts: {
  influencer: string;
  influencerLabel?: string;
  followedUsername: string;
  displayName: string;
  bio: string;
  followers: number;
  verified: boolean;
  url?: string;
  detectedAt: string;
}): NewFollow {
  const followed = {
    id: '111',
    username: opts.followedUsername,
    displayName: opts.displayName,
    followersCount: opts.followers,
    verified: opts.verified,
    bio: opts.bio,
    url: opts.url,
    profileImageUrl: 'https://placehold.co/400x400/png',
  };
  return {
    influencer: {
      username: opts.influencer,
      label: opts.influencerLabel,
      imageUrl: 'https://placehold.co/400x400/png',
    },
    influencerId: '999',
    followed,
    score: scoreUser(followed),
    classification: classifyAccount(followed),
    detectedAt: opts.detectedAt,
    influencerImageUrl: 'https://placehold.co/400x400/png',
  };
}

const high = makeEvent({
  influencer: 'crypto-watch',
  followedUsername: 'exampleproject',
  displayName: 'MO',
  bio: 'stealth launch. CA: HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
  followers: 5400,
  verified: false,
  detectedAt: '2026-06-04T21:07:00.000Z',
});

const normal = makeEvent({
  influencer: 'crypto-watch',
  followedUsername: 'exampleproject',
  displayName: 'MO',
  bio: 'community memecoin on solana.',
  followers: 5400,
  verified: false,
  detectedAt: '2026-06-04T21:07:00.000Z',
});

const wrap = (ev: NewFollow) => ({ username: 'Follow Tracker', embeds: [buildEmbed(ev)] });

async function main(): Promise<void> {
  // Preview the production path: LEFT = a cached influencer image (real, fetched
  // live by the banner generator), RIGHT = real followed image if available,
  // otherwise the fallback placeholder. Falls back to the reference card halves
  // if no cache exists yet.
  const cachePath = path.resolve('data', 'influencer-images.json');
  let cachedInfluencerUrl: string | undefined;
  let cachedHandle = 'crypto-watch';
  if (fs.existsSync(cachePath)) {
    try {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, string>;
      const handle = Object.keys(cache)[0];
      if (handle) {
        cachedHandle = handle;
        cachedInfluencerUrl = cache[handle];
      }
    } catch {
      /* ignore malformed cache */
    }
  }

  let banner: Buffer;
  if (cachedInfluencerUrl) {
    console.log(`Using cached influencer image for @${cachedHandle}`);
    // followedImageUrl is undefined here (no real followed pfp offline) -> the
    // generator falls back to a placeholder for the right avatar.
    banner = await generateFollowBanner({
      influencerImageUrl: cachedInfluencerUrl,
      followedImageUrl: undefined,
      influencerSeed: cachedHandle,
      followedSeed: 'exampleproject',
    });
  } else {
    const refPath = path.resolve('reference-follow-card.png');
    if (fs.existsSync(refPath)) {
      const meta = await sharp(refPath).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      const halfW = Math.floor(w * 0.47);
      const left = await sharp(refPath).extract({ left: 0, top: 0, width: halfW, height: h }).png().toBuffer();
      const right = await sharp(refPath)
        .extract({ left: w - halfW, top: 0, width: halfW, height: h })
        .png()
        .toBuffer();
      banner = await composeBanner(left, right);
    } else {
      banner = await composeBanner(fakeAvatar('#5b8def', '#2b3a67'), fakeAvatar('#f0883e', '#7a3d12'));
    }
  }
  const outDir = path.resolve('data');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'sample-follow-banner.png');
  fs.writeFileSync(outPath, banner);

  console.log(
    `Sample banner saved: ${outPath} (${banner.length} bytes, ${BANNER_WIDTH}x${BANNER_HEIGHT})\n`
  );

  console.log('=== HIGH PRIORITY (contract address in bio) ===');
  console.log(JSON.stringify(wrap(high), null, 2));
  console.log('\n=== NORMAL (legit project, no CA) ===');
  console.log(JSON.stringify(wrap(normal), null, 2));
}

main().catch((err) => {
  console.error('preview failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
