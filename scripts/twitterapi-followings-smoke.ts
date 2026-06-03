/**
 * Live smoke test for the twitterapi.io "followings" endpoint.
 *
 * Evaluates twitterapi.io as a possible (cheaper) alternative provider BEFORE
 * building anything around it. Read-only: sends no alerts and writes no DB.
 *
 * Endpoint: GET https://api.twitterapi.io/twitter/user/followings
 * Auth:     X-API-Key: $TWITTERAPI_IO_KEY
 * Params:   userName, pageSize, cursor
 *
 * Usage:
 *   cp .env.example .env   # set TWITTERAPI_IO_KEY (never commit it)
 *   npx ts-node scripts/twitterapi-followings-smoke.ts ansem
 */
import * as dotenv from 'dotenv';

dotenv.config();

const ENDPOINT = 'https://api.twitterapi.io/twitter/user/followings';

function topKeys(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value && typeof value === 'object') return Object.keys(value as object).join(', ');
  return typeof value;
}

function truncate(s: unknown, n: number): string {
  const str = s === undefined || s === null ? '' : String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

async function main(): Promise<void> {
  const apiKey = process.env.TWITTERAPI_IO_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('Missing TWITTERAPI_IO_KEY (set it in .env or the environment).');
  }

  const username = process.argv[2];
  if (!username) {
    throw new Error('Usage: ts-node scripts/twitterapi-followings-smoke.ts <username>');
  }
  const userName = username.replace(/^@/, '').trim();

  const url = new URL(ENDPOINT);
  url.searchParams.set('userName', userName);
  url.searchParams.set('pageSize', '20');

  console.log(`Endpoint : ${ENDPOINT}`);
  console.log(`userName : ${userName}`);
  console.log(`pageSize : 20\n`);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-API-Key': apiKey.trim(),
      Accept: 'application/json',
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Request failed: ${res.status} ${res.statusText} — ${text.slice(0, 400)}`
    );
  }

  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 300)}`);
  }

  // twitterapi.io wraps the list under `followings` with paging metadata.
  const followings: any[] = Array.isArray(data?.followings) ? data.followings : [];

  console.log('=== result ===');
  console.log('username checked :', userName);
  console.log('status           :', data?.status ?? '(none)');
  console.log('returned count   :', followings.length);

  console.log('\nfirst 20 followings:');
  followings.slice(0, 20).forEach((u, i) => {
    const handle = u?.userName ?? u?.screen_name ?? '(no username)';
    const name = u?.name ?? '';
    const followers = u?.followers ?? u?.followers_count ?? '?';
    const extra = u?.url || u?.description;
    console.log(
      `  ${String(i + 1).padStart(2)}. @${handle}` +
        `  | name: ${truncate(name, 30)}` +
        `  | followers: ${followers}` +
        (extra ? `  | ${u?.url ? 'url' : 'bio'}: ${truncate(extra, 50)}` : '')
    );
  });

  console.log('\n=== pagination / shape (debug) ===');
  console.log('has_next_page    :', data?.has_next_page ?? '(missing)');
  console.log(
    'next_cursor      :',
    data?.next_cursor ? `present (${truncate(data.next_cursor, 16)})` : 'absent/empty'
  );
  console.log('raw top-level keys:', topKeys(data));
  console.log('first item keys   :', followings[0] ? topKeys(followings[0]) : '(no items)');

  console.log('\nNote: read-only smoke test — no alerts sent, no DB writes, provider not wired in.');
}

main().catch((err) => {
  console.error(
    'twitterapi-followings-smoke failed:',
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
