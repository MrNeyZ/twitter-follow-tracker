import * as fs from 'fs';

/**
 * In-memory cache of influencer handle -> profile-image URL, loaded ONCE at
 * worker startup from a local gitignored JSON file (data/influencer-images.json,
 * populated by scripts/cache-influencer-images.ts).
 *
 * This is what lets the alert banner show the influencer's real avatar without
 * the polling loop ever calling the provider for it — lookups here are pure
 * in-memory map reads, never network I/O.
 */
let cache: Record<string, string> = {};

/** Default filename (lives alongside the SQLite DB in the data dir). */
export const INFLUENCER_IMAGES_FILENAME = 'influencer-images.json';

/**
 * Load the cache file into memory. Safe to call once at startup; missing or
 * malformed files are tolerated (cache stays empty -> fallback avatars). Returns
 * the number of cached entries.
 */
export function loadInfluencerImages(filePath: string): number {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    cache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
  } catch {
    cache = {}; // missing/unreadable/invalid -> no cached images
  }
  return Object.keys(cache).length;
}

/** Cached profile-image URL for a handle, or undefined if not cached. */
export function getInfluencerImageUrl(username: string): string | undefined {
  const v = cache[username];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
