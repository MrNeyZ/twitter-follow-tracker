import sharp from 'sharp';

/**
 * Generates the follow-alert banner locally with Sharp — no browser, no external
 * service, no cloud image generation.
 *
 * Premium "trading terminal" card (Bloomberg / TradingView feel):
 *
 *   [ large square avatar ]   ·····→   [ large square avatar ]
 *
 *   - dark graphite background with a very faint centre illumination + subtle
 *     noise texture (no neon / glow / crypto effects / particles / gradients
 *     everywhere),
 *   - two large square avatars with gently rounded corners (no borders, rings,
 *     shadows or circles),
 *   - a thin, slightly-transparent white arrow, visually centred, with a faint
 *     dotted connection line leading into it.
 *
 * No text is drawn into the image (the host has no fonts, so the optional
 * "FOLLOW" label can't render reliably) — all text lives in the embed.
 */
export const BANNER_WIDTH = 975;
export const BANNER_HEIGHT = 450;

// Full-height avatars, flush to the edges: avatars dominate the banner with a
// tight centre gap so it reads as [BIG]>[BIG], not two tiles in empty space.
const SIDE_MARGIN = 0;
const TOP_MARGIN = 0;
const AVATAR_SIDE = BANNER_HEIGHT - TOP_MARGIN * 2; // 450 = full banner height
const AVATAR_RADIUS = 14; // gently rounded corners
const LEFT_X = SIDE_MARGIN; // 0
const RIGHT_X = BANNER_WIDTH - SIDE_MARGIN - AVATAR_SIDE; // 525
const CY = BANNER_HEIGHT / 2; // 225
const GAP_L = LEFT_X + AVATAR_SIDE; // 450 (right edge of left avatar)
const GAP_R = RIGHT_X; // 525 (left edge of right avatar) — 75px gap (~25% tighter)
const CX = BANNER_WIDTH / 2; // 487.5 (centre of the gap)

export interface BannerOptions {
  influencerImageUrl?: string;
  followedImageUrl?: string;
  /** Stable seeds (handles) used to colour the fallback avatar when no image. */
  influencerSeed: string;
  followedSeed: string;
}

/** Fetch avatars (best-effort) and compose the banner PNG buffer. */
export async function generateFollowBanner(opts: BannerOptions): Promise<Buffer> {
  const [inf, fol] = await Promise.all([
    loadAvatar(opts.influencerImageUrl, opts.influencerSeed),
    loadAvatar(opts.followedImageUrl, opts.followedSeed),
  ]);
  return composeBanner(inf, fol);
}

/**
 * Compose the banner from two already-loaded avatar buffers. Exported so the
 * offline preview / tests can render a banner with no network access.
 */
export async function composeBanner(
  influencerAvatar: Buffer,
  followedAvatar: Buffer
): Promise<Buffer> {
  const roundedMask = (size: number, r: number): Buffer =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
        `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/></svg>`
    );

  // Single high-quality resize pass: Lanczos3 kernel, centre cover-crop, then a
  // mild sharpen to counteract resampling softness. PNG out (lossless — no
  // recompression artifacts).
  const square = async (buf: Buffer): Promise<Buffer> =>
    sharp(buf, { failOn: 'none' })
      .resize(AVATAR_SIDE, AVATAR_SIDE, {
        fit: 'cover',
        position: 'centre',
        kernel: 'lanczos3',
        fastShrinkOnLoad: false,
      })
      .sharpen({ sigma: 1 })
      .composite([{ input: roundedMask(AVATAR_SIDE, AVATAR_RADIUS), blend: 'dest-in' }])
      .png({ compressionLevel: 9 })
      .toBuffer();

  const [left, right] = await Promise.all([square(influencerAvatar), square(followedAvatar)]);

  // Subtle graphite noise texture (very faint).
  const noise = await sharp({
    create: {
      width: BANNER_WIDTH,
      height: BANNER_HEIGHT,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: 'gaussian', mean: 128, sigma: 14 },
    },
  })
    .grayscale()
    .ensureAlpha(0.05)
    .png()
    .toBuffer();

  // Outer rounded corners for the whole card.
  const outerMask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}">` +
      `<rect width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" rx="16" ry="16" fill="#fff"/></svg>`
  );

  return sharp(Buffer.from(backgroundSvg()))
    .composite([
      { input: noise, blend: 'over' },
      { input: left, left: LEFT_X, top: TOP_MARGIN },
      { input: right, left: RIGHT_X, top: TOP_MARGIN },
      { input: outerMask, blend: 'dest-in' },
    ])
    .png()
    .toBuffer();
}

/**
 * Graphite background with a faint centre illumination and a small thin white
 * text-style ">" chevron centred in the gap — a separator, not a graphic.
 */
function backgroundSvg(): string {
  // Small, thin ">" chevron centred in the gap.
  const ax = 7; // horizontal half-width
  const ay = 12; // vertical half-height
  const chevron =
    `<path d="M${CX - ax} ${CY - ay} L${CX + ax} ${CY} L${CX - ax} ${CY + ay}" ` +
    `stroke="#ffffff" stroke-opacity="0.9" stroke-width="3" fill="none" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}">` +
    `<defs>` +
    `<radialGradient id="ill" cx="50%" cy="50%" r="62%">` +
    `<stop offset="0%" stop-color="#23272f"/>` +
    `<stop offset="100%" stop-color="#121419"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" fill="url(#ill)"/>` +
    chevron +
    `</svg>`
  );
}

/**
 * Load an avatar as a buffer. Best-effort: downloads the image bytes (an avatar
 * fetch, NOT a generation service); on any failure or missing URL it falls back
 * to a deterministically-coloured placeholder derived from `seed`.
 */
export async function loadAvatar(url: string | undefined, seed: string): Promise<Buffer> {
  if (url) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await sharp(buf).metadata(); // validate it decodes as an image
        return buf;
      }
    } catch {
      // fall through to placeholder
    }
  }
  return fallbackAvatar(seed);
}

/** A plain square placeholder avatar, muted graphite tone derived from seed. */
function fallbackAvatar(seed: string): Buffer {
  const h = hashHue(seed);
  const s = AVATAR_SIDE;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">` +
    `<rect width="${s}" height="${s}" fill="hsl(${h}, 22%, 26%)"/>` +
    `<circle cx="${s / 2}" cy="${s * 0.4}" r="${s * 0.16}" fill="#ffffff" opacity="0.22"/>` +
    `<rect x="${s * 0.2}" y="${s * 0.62}" width="${s * 0.6}" height="${s * 0.3}" rx="${s * 0.15}" fill="#ffffff" opacity="0.22"/>` +
    `</svg>`;
  return Buffer.from(svg);
}

function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}
