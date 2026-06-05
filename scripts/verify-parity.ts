/**
 * Parity proof: render the ORIGINAL reference templates and the PRODUCTION
 * renderer with identical data + identical (deterministic) avatars, then diff.
 *
 * Outputs (data/parity/):
 *   high-reference.png    normal-reference.png
 *   high-production.png   normal-production.png
 *   diff-high.png         diff-normal.png          (amplified abs-diff)
 *   cmp-high.png          cmp-normal.png           (reference | production)
 *
 * Usage: npx ts-node scripts/verify-parity.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { renderCard, closeCardBrowser } from '../src/alerts/card';
import { loadAvatar } from '../src/alerts/banner';
import { CardModel } from '../src/alerts/card-model';

const W = 1280;
const H = 900;
const OUT = path.resolve(__dirname, '../data/parity');
const REF_FILE: Record<string, string> = {
  high: path.resolve(__dirname, '../banner-template.html'),
  normal: path.resolve(__dirname, '../banner-template-normal.html'),
};

async function avatarDataUri(seed: string, size: number): Promise<string> {
  const buf = await loadAvatar(undefined, seed);
  const png = await sharp(buf).resize(size, size, { fit: 'cover' }).png().toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}

/** Sample data mirroring each reference file's built-in sample. */
function model(kind: 'high' | 'normal'): CardModel {
  if (kind === 'high') {
    return {
      high: true,
      badge: 'HIGH PRIORITY',
      timestamp: '3:24 AM',
      watcher: 'cobratate',
      followed: 'aethermind_ai',
      projectName: 'Aethermind',
      tagLine: 'Project · Unverified',
      scoreValue: 100,
      relevance: '9.1',
      followers: '128k',
      metrics: [],
      chips: ['project keywords: solana, ai', 'followers in 1k–250k range', 'launchpad token address in bio'],
      token: { short: 'HgBR…pump', url: '' },
      influencerImageUrl: undefined,
      followedImageUrl: undefined,
    };
  }
  return {
    high: false,
    badge: 'NEW FOLLOW',
    timestamp: '1:48 PM',
    watcher: 'crypto-watch',
    followed: 'Mnilax',
    projectName: 'MNIMIY',
    tagLine: 'Project · Unverified',
    scoreValue: 73,
    relevance: '5.9',
    followers: '7.2k',
    metrics: [],
    chips: ['project keywords: ai', 'followers in 1k–250k range'],
    token: null,
    influencerImageUrl: undefined,
    followedImageUrl: undefined,
  };
}

/** Render the ORIGINAL reference template with controlled data + avatars. */
async function renderReference(
  browser: import('playwright').Browser,
  kind: 'high' | 'normal',
  m: CardModel,
  tAva: string,
  wAva: string
): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  try {
    await page.goto('file://' + REF_FILE[kind], { waitUntil: 'load' });
    await page.evaluate(
      (d) => (globalThis as unknown as { renderBanner: (x: unknown) => void }).renderBanner(d),
      {
        kind,
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
      }
    );
    await page
      .waitForFunction(() => (globalThis as unknown as { bannerReady?: boolean }).bannerReady === true, null, {
        timeout: 8000,
      })
      .catch(() => undefined);
    const el = await page.$('#bn');
    const png = el ? await el.screenshot({ type: 'png' }) : await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
    return png as Buffer;
  } finally {
    await page.close();
  }
}

/** Amplified absolute-difference image + mismatch %. */
async function diff(aPng: Buffer, bPng: Buffer): Promise<{ img: Buffer; pct: number; maxd: number }> {
  const a = await sharp(aPng).resize(W, H).removeAlpha().raw().toBuffer();
  const b = await sharp(bPng).resize(W, H).removeAlpha().raw().toBuffer();
  const n = Math.min(a.length, b.length);
  const out = Buffer.alloc(n);
  let changed = 0;
  let maxd = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxd) maxd = d;
    if (d > 12) changed++;
    out[i] = Math.min(255, d * 6); // amplify for visibility
  }
  const img = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const pct = (changed / n) * 100;
  return { img, pct, maxd };
}

async function sideBySide(a: Buffer, b: Buffer, out: string): Promise<void> {
  const gap = 24;
  const [ab, bb] = await Promise.all([sharp(a).resize(W, H).toBuffer(), sharp(b).resize(W, H).toBuffer()]);
  await sharp({ create: { width: W * 2 + gap, height: H, channels: 3, background: '#1a1b1e' } })
    .composite([{ input: ab, left: 0, top: 0 }, { input: bb, left: W + gap, top: 0 }])
    .png()
    .toFile(out);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const kind of ['high', 'normal'] as const) {
      const m = model(kind);
      // deterministic avatars shared by both renders
      const [tAva, wAva] = await Promise.all([avatarDataUri(m.followed, 400), avatarDataUri(m.watcher, 200)]);

      const ref = await renderReference(browser, kind, m, tAva, wAva);
      const prod = await renderCard(m);

      fs.writeFileSync(path.join(OUT, `${kind}-reference.png`), ref);
      fs.writeFileSync(path.join(OUT, `${kind}-production.png`), prod);

      const { img, pct, maxd } = await diff(ref, prod);
      fs.writeFileSync(path.join(OUT, `diff-${kind}.png`), img);
      await sideBySide(ref, prod, path.join(OUT, `cmp-${kind}.png`));

      console.log(`${kind}: mismatch ${pct.toFixed(3)}% of subpixels (>12/255), max delta ${maxd}/255`);
    }
  } finally {
    await browser.close();
    await closeCardBrowser();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
