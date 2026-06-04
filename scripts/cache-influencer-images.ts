/**
 * One-time enrichment: fetch each watched influencer's profile picture ONCE and
 * cache the URL to data/influencer-images.json (gitignored). The worker loads
 * this file at startup and uses it for the left avatar of the alert banner — so
 * the normal polling loop NEVER fetches influencer profiles.
 *
 * Safe by design:
 *   - skips influencers that already have a config `imageUrl`, are already
 *     cached, or are tier `disabled`,
 *   - hard cap of MAX_FETCHES profile calls,
 *   - re-runnable: only fetches handles still missing from the cache.
 *
 * Endpoint: GET {base}/twitter/user/info?userName=...  (X-API-Key header)
 *
 * Usage: npx ts-node scripts/cache-influencer-images.ts
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { WATCHED_INFLUENCERS } from '../src/config';

dotenv.config();

const MAX_FETCHES = 7; // hard safety cap on profile fetch calls
const OUT_PATH = path.resolve('data', 'influencer-images.json');

/** Bump Twitter's "_normal" (48px) avatar to "_400x400" for a crisp banner. */
function upscalePfp(url: string): string {
  return url.replace(/_normal(\.[a-z]+)(?:\?.*)?$/i, '_400x400$1');
}

function loadExisting(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.TWITTERAPI_IO_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('Missing TWITTERAPI_IO_KEY (set it in .env or the environment).');
  }
  const base = (process.env.TWITTERAPI_IO_BASE_URL || 'https://api.twitterapi.io').replace(/\/$/, '');

  const cache = loadExisting();
  let calls = 0;
  const fetched: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const inf of WATCHED_INFLUENCERS) {
    const handle = inf.username.replace(/^@/, '').trim();
    if (inf.imageUrl) {
      skipped.push(`${handle} (config imageUrl)`);
      continue;
    }
    if (cache[handle]) {
      skipped.push(`${handle} (already cached)`);
      continue;
    }
    if (inf.tier === 'disabled') {
      skipped.push(`${handle} (disabled)`);
      continue;
    }
    if (calls >= MAX_FETCHES) {
      skipped.push(`${handle} (cap ${MAX_FETCHES} reached)`);
      continue;
    }

    calls++;
    try {
      const url = new URL(`${base}/twitter/user/info`);
      url.searchParams.set('userName', handle);
      const res = await fetch(url.toString(), {
        headers: { 'X-API-Key': apiKey.trim(), Accept: 'application/json' },
      });
      if (!res.ok) {
        failed.push(`${handle} (HTTP ${res.status})`);
        continue;
      }
      const data: any = await res.json();
      const u = data?.data ?? data?.user ?? data;
      const raw = u?.profile_image_url_https ?? u?.profilePicture ?? u?.profileImageUrl;
      if (!raw) {
        failed.push(`${handle} (no image field)`);
        continue;
      }
      cache[handle] = upscalePfp(String(raw));
      fetched.push(handle);
    } catch (err) {
      failed.push(`${handle} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(cache, null, 2) + '\n');

  console.log('=== cache-influencer-images ===');
  console.log(`API calls made : ${calls} (cap ${MAX_FETCHES})`);
  console.log(`fetched        : ${fetched.join(', ') || '(none)'}`);
  console.log(`skipped        : ${skipped.join(', ') || '(none)'}`);
  console.log(`failed         : ${failed.join(', ') || '(none)'}`);
  console.log(`cache file     : ${OUT_PATH}`);
  console.log(`cached handles : ${Object.keys(cache).join(', ') || '(none)'}`);
}

main().catch((err) => {
  console.error('cache-influencer-images failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
