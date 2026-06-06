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

/** Separator between the followed account and the token CA — space + ・ + space. */
const SEPARATOR = ' ・ ';

/**
 * Minimal Discord embed — a thin wrapper around the rendered card PNG. All
 * information lives in the image; the embed text above it carries only the
 * clickable links Discord can't put on an image:
 *   - followed handle -> x.com profile  (bold)
 *   - shortened CA    -> Solscan        (bold; only when a CA exists)
 *
 * Note: the Discord label shows a shortened CA (first 11 + last 11 chars, see
 * shortenCa) but the link still targets the full address; the card image shows
 * its own short "CA: HgBR…pump" form (unchanged).
 *
 * The watcher account is intentionally omitted here — it already appears inside
 * the card image. Layout: `**@followed**` or `**@followed** ・ **<ca>**`.
 *
 * `withCard` controls whether embed.image points at the attached card (false
 * when rendering failed, so we don't reference a missing file).
 */
export function buildEmbed(ev: NewFollow, withCard = true): Record<string, unknown> {
  const fol = ev.followed.username;

  let description = `**[@${fol}](${profileUrl(fol)})**`;
  const token = caLink(ev);
  if (token) description += `${SEPARATOR}**${token}**`;

  const embed: Record<string, unknown> = {
    description,
    color: cardColor(ev),
  };
  if (withCard) embed.image = { url: `attachment://${CARD_FILENAME}` };
  return embed;
}

/** Clickable shortened CA → Solscan (full URL), or null if no contract address. */
function caLink(ev: NewFollow): string | null {
  const addr = findContractAddress(ev.followed);
  if (!addr) return null;
  const url =
    ev.classification.caSignal === 'launchpad'
      ? `https://solscan.io/token/${addr}`
      : `https://solscan.io/account/${addr}`;
  // Visible label only is shortened; the hyperlink target stays the full addr.
  return `[${shortenCa(addr)}](${url})`;
}

/**
 * Shorten a CA for the visible Discord label: the first 11 and last 11
 * characters concatenated directly — no ellipsis, dots, or separator of any
 * kind. Addresses of 22 chars or fewer are returned unchanged (shortening can't
 * help and would overlap). The hyperlink still points at the full address.
 */
function shortenCa(addr: string): string {
  if (addr.length <= 22) return addr;
  return addr.slice(0, 11) + addr.slice(-11);
}

function profileUrl(username: string): string {
  return `https://x.com/${encodeURIComponent(username)}`;
}
