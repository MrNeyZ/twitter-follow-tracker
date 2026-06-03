import { SorsaUser } from '../types';

/**
 * Thin client for the Sorsa X/Twitter API.
 *
 * Docs: https://docs.sorsa.io/  (base url https://api.sorsa.io/v3, auth via "ApiKey" header)
 *
 * The response schemas are normalized defensively because Sorsa (like most
 * Twitter data providers) exposes several aliases for the same field across
 * endpoints/versions. If the real payload differs, adjust `normalizeUser` and
 * the field lookups in one place rather than scattering them.
 */
export class SorsaProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.sorsa.io/v3'
  ) {}

  private async request(pathname: string, params: Record<string, string>): Promise<any> {
    const url = new URL(this.baseUrl.replace(/\/$/, '') + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        ApiKey: this.apiKey,
        Accept: 'application/json',
      },
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Sorsa ${pathname} failed: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`
      );
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Sorsa ${pathname} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  /** Resolve a username/handle to a full normalized user (incl. numeric id). */
  async getUserByUsername(username: string): Promise<SorsaUser> {
    const data = await this.request('/info', { username: stripAt(username) });
    const raw = unwrapUser(data);
    if (!raw) {
      throw new Error(`Sorsa /info returned no user for "${username}"`);
    }
    return normalizeUser(raw);
  }

  /**
   * Fetch the full following list (accounts the given user follows).
   * Pages through cursors until exhausted or `maxPages` is hit.
   */
  async getFollowing(userId: string, maxPages = 50): Promise<SorsaUser[]> {
    const out: SorsaUser[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = { user_id: userId, count: '200' };
      if (cursor) params.cursor = cursor;

      const data = await this.request('/follows', params);
      const users = extractUserList(data).map(normalizeUser);
      for (const u of users) {
        if (u.id && !seen.has(u.id)) {
          seen.add(u.id);
          out.push(u);
        }
      }

      cursor = extractNextCursor(data);
      // Stop when there's no further cursor or the page was empty.
      if (!cursor || users.length === 0) break;
    }

    return out;
  }
}

function stripAt(username: string): string {
  return username.replace(/^@/, '').trim();
}

/** Pull a single user object out of a variety of envelope shapes. */
function unwrapUser(data: any): any {
  if (!data || typeof data !== 'object') return undefined;
  return (
    data.user ??
    data.data?.user ??
    data.data ??
    data.result ??
    (data.id || data.rest_id || data.id_str || data.screen_name ? data : undefined)
  );
}

/** Pull a list of user objects out of a variety of envelope shapes. */
function extractUserList(data: any): any[] {
  if (Array.isArray(data)) return data;
  const candidates = [
    data?.users,
    data?.following,
    data?.follows,
    data?.data?.users,
    data?.data,
    data?.results,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function extractNextCursor(data: any): string | undefined {
  const c =
    data?.next_cursor ??
    data?.nextCursor ??
    data?.cursor ??
    data?.next ??
    data?.data?.next_cursor;
  if (c === undefined || c === null) return undefined;
  const s = String(c);
  // Twitter-style "0" / "-1" cursors mean "no more pages".
  if (s === '' || s === '0' || s === '-1') return undefined;
  return s;
}

/** Normalize a raw provider user object into our SorsaUser shape. */
export function normalizeUser(raw: any): SorsaUser {
  const id = String(
    raw?.id_str ?? raw?.rest_id ?? raw?.user_id ?? raw?.id ?? ''
  );
  const username = String(
    raw?.username ?? raw?.screen_name ?? raw?.handle ?? ''
  );
  const displayName = raw?.name ?? raw?.display_name ?? raw?.displayName;
  const followersCount = Number(
    raw?.followers_count ?? raw?.followersCount ?? raw?.public_metrics?.followers_count ?? 0
  );
  const verified = Boolean(
    raw?.verified ?? raw?.is_blue_verified ?? raw?.isBlueVerified ?? raw?.is_verified ?? false
  );
  const bio = String(raw?.description ?? raw?.bio ?? raw?.profile_bio ?? '');

  return {
    id,
    username,
    displayName: displayName ? String(displayName) : undefined,
    followersCount: Number.isFinite(followersCount) ? followersCount : 0,
    verified,
    bio,
  };
}
