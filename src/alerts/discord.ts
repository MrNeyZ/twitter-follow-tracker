import { NewFollow } from '../types';
import { findContractAddress } from '../scoring';
import { buildCardModel } from './card-model';
import { renderCard } from './card';

// Embed accent colour (the rendered PNG carries the real styling).
const COLOR_HIGH = 0xe7335a; // HIGH PRIORITY (contract address present)
const COLOR_VERIFIED = 0x1d9bf0; // verified normal follow
const COLOR_NORMAL = 0x2ecc71; // normal follow

/** Filename the generated card is attached under (referenced by embed.image). */
const CARD_FILENAME = 'card.png';

/** Sends alerts to a Discord channel via an incoming webhook. */
export class DiscordAlerter {
  constructor(private readonly webhookUrl: string) {}

  async sendNewFollow(ev: NewFollow): Promise<void> {
    // Render the full card PNG locally; if it fails, still send the (clickable)
    // wrapper embed without an image.
    let card: Buffer | null = null;
    try {
      card = await renderCard(buildCardModel(ev));
    } catch {
      card = null;
    }

    const payload = {
      username: 'Follow Tracker',
      embeds: [buildEmbed(ev, card !== null)],
    };

    let res: Response;
    if (card) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      form.append('files[0]', new Blob([card], { type: 'image/png' }), CARD_FILENAME);
      res = await fetch(this.webhookUrl, { method: 'POST', body: form });
    } else {
      res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Discord webhook failed: ${res.status} — ${body.slice(0, 300)}`);
    }
  }
}

/** Embed bar accent colour for an event. */
export function cardColor(ev: NewFollow): number {
  if (ev.classification.highPriority) return COLOR_HIGH;
  return ev.followed.verified ? COLOR_VERIFIED : COLOR_NORMAL;
}

/**
 * Minimal Discord embed — a thin wrapper around the rendered card PNG. All
 * information lives in the image; the embed exists only to (a) attach the image
 * and (b) carry the clickable links Discord can't put on an image:
 *   - influencer handle  -> x.com profile
 *   - followed handle    -> x.com profile
 *   - token short addr   -> Solscan  (high priority only)
 *
 * `withCard` controls whether embed.image points at the attached card (false
 * when rendering failed, so we don't reference a missing file).
 */
export function buildEmbed(ev: NewFollow, withCard = true): Record<string, unknown> {
  const inf = ev.influencer.username;
  const fol = ev.followed.username;

  const parts = [`[@${inf}](${profileUrl(inf)}) → [@${fol}](${profileUrl(fol)})`];
  const token = ev.classification.highPriority ? caLink(ev) : null;
  if (token) parts.push(token);

  const embed: Record<string, unknown> = {
    description: parts.join('  ·  '),
    color: cardColor(ev),
  };
  if (withCard) embed.image = { url: `attachment://${CARD_FILENAME}` };
  return embed;
}

/** Clickable short CA → Solscan, or null if no contract address. */
function caLink(ev: NewFollow): string | null {
  const addr = findContractAddress(ev.followed);
  if (!addr) return null;
  const short = `${addr.slice(0, 4)}…${addr.slice(-4)}`;
  const url =
    ev.classification.caSignal === 'launchpad'
      ? `https://solscan.io/token/${addr}`
      : `https://solscan.io/account/${addr}`;
  return `[${short}](${url})`;
}

function profileUrl(username: string): string {
  return `https://x.com/${encodeURIComponent(username)}`;
}
