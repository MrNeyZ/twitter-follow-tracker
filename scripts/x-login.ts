/**
 * EXPERIMENTAL — manual X/Twitter login to seed a persistent browser profile.
 *
 * Launches a non-headless Chromium with a persistent profile under
 * `data/x-profile`. You log in to x.com BY HAND in the opened window; the
 * session (cookies/localStorage) is persisted in that profile directory and
 * later reused by `scripts/x-following-smoke.ts`.
 *
 * No credentials are stored in code — login is entirely manual.
 *
 * Usage:
 *   npx playwright install chromium   # one-time, downloads the browser binary
 *   npx ts-node scripts/x-login.ts
 *
 * When you've finished logging in (you can see your X home timeline), return
 * to the terminal and press Enter to save the session and close the browser.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { chromium } from 'playwright';

const PROFILE_DIR = path.resolve('data/x-profile');

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function main(): Promise<void> {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`Persistent profile: ${PROFILE_DIR}`);

  // Persistent context => the profile dir IS the session store; nothing to export.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

  console.log('\nA browser window opened. Log in to X manually.');
  console.log('Once you can see your home timeline, come back here.');
  await waitForEnter('\nPress Enter to save the session and close the browser... ');

  await context.close(); // flushes profile state to disk
  console.log('Session saved to data/x-profile. You can now run x-following-smoke.ts.');
}

main().catch((err) => {
  console.error('x-login failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
