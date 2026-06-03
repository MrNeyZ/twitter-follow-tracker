/**
 * Live Sorsa API sanity check — run BEFORE wiring the real influencer list.
 *
 * Verifies the real endpoint paths and response shapes against a live key.
 * Reuses the existing SorsaProvider for normalized output, and also makes
 * raw calls to dump the response envelope keys for debugging.
 *
 * Usage:
 *   SORSA_API_KEY=... npx ts-node scripts/sorsa-smoke.ts <username>
 *   # or after `cp .env.example .env` and filling SORSA_API_KEY:
 *   npx ts-node scripts/sorsa-smoke.ts elonmusk
 */
import * as dotenv from 'dotenv';
import { SorsaProvider } from '../src/providers/sorsa';

dotenv.config();

function topKeys(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value && typeof value === 'object') return Object.keys(value).join(', ');
  return typeof value;
}

/** Raw GET that mirrors the provider's auth, used only for shape debugging. */
async function rawGet(
  baseUrl: string,
  apiKey: string,
  pathname: string,
  params: Record<string, string>
): Promise<unknown> {
  const url = new URL(baseUrl.replace(/\/$/, '') + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { ApiKey: apiKey, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${pathname} -> ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${pathname} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.SORSA_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('Missing SORSA_API_KEY (set it in .env or the environment).');
  }
  const baseUrl = (process.env.SORSA_BASE_URL || 'https://api.sorsa.io/v3').trim();

  const username = process.argv[2];
  if (!username) {
    throw new Error('Usage: ts-node scripts/sorsa-smoke.ts <username>');
  }

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Username: ${username}\n`);

  const sorsa = new SorsaProvider(apiKey.trim(), baseUrl);

  // --- /info ---
  console.log('=== /info ===');
  const rawInfo = await rawGet(baseUrl, apiKey.trim(), '/info', {
    username: username.replace(/^@/, ''),
  });
  console.log('raw top-level keys:', topKeys(rawInfo));

  const user = await sorsa.getUserByUsername(username);
  console.log('resolved id      :', user.id);
  console.log('username         :', user.username);
  console.log('display name     :', user.displayName ?? '(none)');
  console.log('followers count  :', user.followersCount);
  console.log('verified         :', user.verified);
  console.log('bio              :', user.bio ? user.bio.slice(0, 120) : '(empty)');

  if (!user.id) {
    throw new Error('Could not resolve a user id — check the /info response shape above.');
  }

  // --- /follows ---
  console.log('\n=== /follows ===');
  const rawFollows = await rawGet(baseUrl, apiKey.trim(), '/follows', {
    user_id: user.id,
    count: '200',
  });
  console.log('raw top-level keys:', topKeys(rawFollows));
  // Peek at the first item's keys to confirm field names for normalization.
  const firstRawItem =
    (Array.isArray(rawFollows) && rawFollows[0]) ||
    (rawFollows as any)?.users?.[0] ||
    (rawFollows as any)?.following?.[0] ||
    (rawFollows as any)?.follows?.[0] ||
    (rawFollows as any)?.data?.[0] ||
    (rawFollows as any)?.data?.users?.[0];
  console.log('first item keys   :', firstRawItem ? topKeys(firstRawItem) : '(none found)');

  const following = await sorsa.getFollowing(user.id);
  console.log('following count returned:', following.length);
  console.log('first 5 followed accounts:');
  following.slice(0, 5).forEach((u, i) => {
    console.log(
      `  ${i + 1}. @${u.username || '(no username)'} ` +
        `(id=${u.id}, followers=${u.followersCount}, verified=${u.verified})`
    );
  });

  console.log('\nSmoke check complete.');
}

main().catch((err) => {
  console.error('Sorsa smoke check failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
