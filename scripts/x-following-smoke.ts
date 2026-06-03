/**
 * EXPERIMENTAL — scrape an X/Twitter "following" page using a saved session.
 *
 * Reuses the persistent profile created by `scripts/x-login.ts` (data/x-profile).
 * Opens https://x.com/<username>/following, scrolls slowly a few times, and
 * collects followed-account handles from profile links. Saves raw HTML + a
 * screenshot to data/debug/ for inspection.
 *
 * This is a READ-ONLY validation tool: it NEVER sends alerts and never writes
 * to the app database. Purpose is to judge whether scraping is reliable enough
 * to consider replacing Sorsa.
 *
 * Usage:
 *   npx ts-node scripts/x-following-smoke.ts ansem
 *
 * Defensive by design: random delays, no parallelism, clear errors if the
 * login session is missing or expired.
 */
import * as path from 'path';
import * as fs from 'fs';
import { chromium, BrowserContext, Page } from 'playwright';

const PROFILE_DIR = path.resolve('data/x-profile');
const DEBUG_DIR = path.resolve('data/debug');

// Paths under x.com that are NOT user handles — used to filter profile links.
const RESERVED = new Set([
  'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose',
  'search', 'hashtag', 'login', 'logout', 'signup', 'tos', 'privacy', 'about',
  'following', 'followers', 'verified_followers', 'lists', 'bookmarks', 'jobs',
  'communities', 'premium', 'intent', 'share', 'status', 'help', 'account',
]);

/** Sleep for a random duration in [minMs, maxMs] — keeps behaviour un-botlike. */
function randomDelay(minMs: number, maxMs: number): Promise<void> {
  // Deterministic-ish jitter without Math.random to keep things simple and safe.
  const span = Math.max(0, maxMs - minMs);
  const jitter = span > 0 ? (Date.now() % (span + 1)) : 0;
  return new Promise((resolve) => setTimeout(resolve, minMs + jitter));
}

function ensureSession(): void {
  // Persistent context stores cookies in this SQLite file once logged in.
  const cookies = path.join(PROFILE_DIR, 'Default', 'Cookies');
  const cookiesAlt = path.join(PROFILE_DIR, 'Cookies');
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new Error(
      `No login session found at ${PROFILE_DIR}. Run "npx ts-node scripts/x-login.ts" first.`
    );
  }
  if (!fs.existsSync(cookies) && !fs.existsSync(cookiesAlt)) {
    console.warn(
      'Warning: profile exists but no Cookies store found yet — session may be incomplete.'
    );
  }
}

/** Detect the common "you got bounced to login" states. */
async function assertLoggedIn(page: Page, username: string): Promise<void> {
  const url = page.url();
  if (/\/(login|i\/flow\/login)/.test(url) || /\/account\/access/.test(url)) {
    throw new Error(
      `Redirected to "${url}" — login session is missing or expired. Re-run scripts/x-login.ts.`
    );
  }
  // A logged-out following page typically shows a sign-in wall.
  const bodyText = (await page.textContent('body').catch(() => '')) ?? '';
  if (/Sign in to X|Don.?t miss what.?s happening|New to X\?/i.test(bodyText) &&
      !bodyText.includes('@')) {
    throw new Error(
      `Following page for @${username} rendered a logged-out sign-in wall — session likely expired.`
    );
  }
}

async function collectHandles(page: Page): Promise<string[]> {
  const hrefs = await page.$$eval('a[role="link"][href^="/"], a[href^="/"]', (anchors) =>
    // `anchors` are Element nodes in the page context; getAttribute is enough,
    // so we avoid naming DOM lib types (the worker tsconfig has no DOM lib).
    anchors.map((a) => a.getAttribute('href') || '')
  );
  const handles = new Set<string>();
  for (const href of hrefs) {
    // Profile links look like "/handle" — single path segment, valid handle chars.
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
    if (m) handles.add(m[1]);
  }
  return [...handles];
}

async function main(): Promise<void> {
  const username = process.argv[2];
  if (!username) {
    throw new Error('Usage: ts-node scripts/x-following-smoke.ts <username>');
  }
  ensureSession();
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const headless = (process.env.X_HEADLESS || 'false').toLowerCase() === 'true';
  const handle = username.replace(/^@/, '');

  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = context.pages()[0] ?? (await context.newPage());

    const target = `https://x.com/${encodeURIComponent(handle)}/following`;
    console.log(`Opening ${target} ...`);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await randomDelay(2500, 4500);

    await assertLoggedIn(page, handle);

    // Wait for the timeline/user cells to appear; tolerate slow renders.
    await page
      .waitForSelector('[data-testid="UserCell"], [data-testid="primaryColumn"]', {
        timeout: 30_000,
      })
      .catch(() => console.warn('UserCell/primaryColumn not detected — continuing anyway.'));

    // Collect across a few slow scrolls. No parallelism, deliberate pacing.
    const collected = new Set<string>();
    const SCROLLS = 6;
    for (let i = 0; i < SCROLLS; i++) {
      for (const h of await collectHandles(page)) {
        if (h.toLowerCase() !== handle.toLowerCase() && !RESERVED.has(h.toLowerCase())) {
          collected.add(h);
        }
      }
      console.log(`  scroll ${i + 1}/${SCROLLS}: ${collected.size} handles so far`);
      await page.mouse.wheel(0, 1600);
      await randomDelay(2000, 4000);
    }

    // Save debug artifacts for inspection.
    const safe = handle.replace(/[^A-Za-z0-9_]/g, '_');
    const htmlPath = path.join(DEBUG_DIR, `${safe}-following.html`);
    const shotPath = path.join(DEBUG_DIR, `${safe}-following.png`);
    fs.writeFileSync(htmlPath, await page.content(), 'utf8');
    await page.screenshot({ path: shotPath, fullPage: false }).catch(() => undefined);

    const handles = [...collected];
    console.log('\n=== result ===');
    console.log('username checked :', handle);
    console.log('count collected  :', handles.length);
    console.log('first 20 handles :');
    handles.slice(0, 20).forEach((h, i) => console.log(`  ${i + 1}. @${h}`));
    console.log(`\ndebug HTML  : ${htmlPath}`);
    console.log(`debug shot  : ${shotPath}`);
    console.log('\nNote: experimental scraper — no alerts sent, no DB writes.');
  } finally {
    if (context) await context.close();
  }
}

main().catch((err) => {
  console.error('x-following-smoke failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
