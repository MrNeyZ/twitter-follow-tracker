import * as path from 'path';
import sharp from 'sharp';
import { chromium, Browser } from 'playwright';
import { CardModel } from './card-model';
import { loadAvatar } from './banner';

/**
 * Renders the follow-alert card from the single reference banner template
 * (assets/templates/banner.html) in a headless Chromium.
 *
 * The template exposes `window.renderBanner(data)` (the design source of truth):
 * it builds the markup, switches accent palette via the `kind` field, and sets
 * `window.bannerReady = true` once fonts + avatar images settle. We screenshot
 * the fixed 1280x900 `#bn` element. One unified template → the green (normal)
 * and high-priority cards share an identical layout; only accent/glow/badge/
 * score colour differ (driven by `.bn.high` / `.bn.normal`). Fonts are embedded
 * (self-hosted) so rendering is deterministic and works offline.
 */
const TEMPLATE = path.resolve(__dirname, '../../assets/templates/banner.html');

// One shared browser, launched lazily and reused across alerts.
let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: ['--no-sandbox'] }).catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

/** Close the shared browser (e.g. on shutdown). Safe to call if never opened. */
export async function closeCardBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close();
  }
}

async function avatarDataUri(url: string | undefined, seed: string, size: number): Promise<string> {
  const buf = await loadAvatar(url, seed);
  const png = await sharp(buf).resize(size, size, { fit: 'cover' }).png().toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}

/** Data contract for the template's window.renderBanner(data). */
interface BannerData {
  kind: 'high' | 'normal';
  watcher: string;
  target: string;
  name: string;
  tag: string;
  score: number | string;
  relevance: string;
  followers: string;
  flags: string[];
  token: string | null;
  time: string;
  wAva: string;
  tAva: string;
}

/** Render the full alert card to a fixed 1280x900 PNG buffer. */
export async function renderCard(m: CardModel): Promise<Buffer> {
  const [tAva, wAva] = await Promise.all([
    avatarDataUri(m.followedImageUrl, m.followed, 400),
    avatarDataUri(m.influencerImageUrl, m.watcher, 200),
  ]);

  const data: BannerData = {
    kind: m.high ? 'high' : 'normal',
    watcher: m.watcher,
    target: m.followed,
    name: m.projectName,
    tag: m.tagLine,
    score: m.scoreValue,
    relevance: m.relevance,
    followers: m.followers,
    flags: m.chips,
    token: m.token ? m.token.short : null,
    time: m.timestamp,
    wAva,
    tAva,
  };

  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  try {
    await page.goto('file://' + TEMPLATE, { waitUntil: 'load' });
    await page.evaluate((d) => (globalThis as unknown as { renderBanner: (x: unknown) => void }).renderBanner(d), data);
    await page
      .waitForFunction(() => (globalThis as unknown as { bannerReady?: boolean }).bannerReady === true, null, {
        timeout: 5000,
      })
      .catch(() => {
        /* fall through to screenshot even if readiness didn't flip */
      });
    const el = await page.$('#bn');
    const png = el
      ? await el.screenshot({ type: 'png' })
      : await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 900 } });
    return png as Buffer;
  } finally {
    await page.close();
  }
}
