import { SorsaUser, FollowProvider } from '../types';

/**
 * twitterapi.io provider — drop-in alternative to SorsaProvider.
 *
 * Docs: https://docs.twitterapi.io/  (base https://api.twitterapi.io, auth via
 * the `X-API-Key` header). The followings endpoint is username-based, so this
 * provider never needs to resolve a numeric user id — which also means a normal
 * polling cycle costs nothing extra beyond the single followings page fetch.
 */
export class TwitterApiIoProvider implements FollowProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.twitterapi.io',
    /** Page size for routine polling (first-page only — see getFollowing). */
    private readonly pageSize: number = 100
  ) {}

  private async request(pathname: string, params: Record<string, string>): Promise<any> {
    const url = new URL(this.baseUrl.replace(/\/$/, '') + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-API-Key': this.apiKey,
        Accept: 'application/json',
      },
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `twitterapi.io ${pathname} failed: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`
      );
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`twitterapi.io ${pathname} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  /**
   * "Resolve" a username. twitterapi.io's followings endpoint accepts the
   * username directly, so we deliberately DO NOT call the user-info endpoint
   * here — doing so would spend a credit on every polling cycle for no benefit.
   * We return a lightweight user whose `id` IS the (normalized) username; the
   * worker stores that as the influencer id and hands it back to getFollowing,
   * which uses it as the `userName` param. Resolving the real numeric id via
   * GET /twitter/user/info is left as future work if it's ever needed.
   */
  async getUserByUsername(username: string): Promise<SorsaUser> {
    const handle = stripAt(username);
    return {
      id: handle,
      username: handle,
      followersCount: 0,
      verified: false,
      bio: '',
    };
  }

  /**
   * Fetch the accounts the given user follows.
   *
   * MVP: returns only the FIRST page. The followings endpoint returns
   * newest-followed-first, so a single page reliably surfaces brand-new follows
   * for change detection. We intentionally do NOT paginate the full list every
   * cycle (cost scales with following count). A periodic full re-baseline
   * (paginate until has_next_page=false) is future work — see README.
   *
   * Note: `userIdOrUsername` is treated as a twitterapi.io userName, which is
   * what getUserByUsername returns as the id for this provider.
   */
  async getFollowing(userIdOrUsername: string): Promise<SorsaUser[]> {
    const userName = stripAt(userIdOrUsername);
    const data = await this.request('/twitter/user/followings', {
      userName,
      pageSize: String(this.pageSize),
    });
    const list = Array.isArray(data?.followings) ? data.followings : [];
    return list.map(normalizeUser);
  }
}

function stripAt(s: string): string {
  return String(s).replace(/^@/, '').trim();
}

/** Normalize a twitterapi.io user object into our SorsaUser shape. */
export function normalizeUser(raw: any): SorsaUser {
  const id = String(raw?.id ?? raw?.id_str ?? raw?.rest_id ?? '');
  const username = String(raw?.userName ?? raw?.screen_name ?? '');
  const displayName = raw?.name ?? raw?.display_name;
  const followersCount = Number(raw?.followers_count ?? raw?.followers ?? 0);
  const verified = Boolean(raw?.verified ?? raw?.is_blue_verified ?? false);
  const bio = String(raw?.description ?? raw?.bio ?? '');
  const url = raw?.url ? String(raw.url) : undefined;

  return {
    id,
    username,
    displayName: displayName ? String(displayName) : undefined,
    followersCount: Number.isFinite(followersCount) ? followersCount : 0,
    verified,
    bio,
    url,
  };
}
