import { NewFollow } from '../types';
import { generateFollowBanner } from './banner';

// Card colours (embed bar + banner accent).
const COLOR_HIGH = 0xe7335a; // hot pink/red — HIGH PRIORITY (contract address present)
const COLOR_VERIFIED = 0x1d9bf0; // X blue — verified normal follow
const COLOR_NORMAL = 0x2ecc71; // green — normal follow

/** Filename the generated banner is attached under (referenced by embed.image). */
const BANNER_FILENAME = 'follow.png';

/** Sends alerts to a Discord channel via an incoming webhook. */
export class DiscordAlerter {
  constructor(private readonly webhookUrl: string) {}

  async sendNewFollow(ev: NewFollow): Promise<void> {
    // Generate the banner locally; if it fails, still send a banner-less card.
    let banner: Buffer | null = null;
    try {
      banner = await generateFollowBanner({
        influencerImageUrl: ev.influencerImageUrl,
        followedImageUrl: ev.followed.profileImageUrl,
        influencerSeed: ev.influencer.username,
        followedSeed: ev.followed.username,
      });
    } catch {
      banner = null;
    }

    const payload = {
      username: 'Follow Tracker',
      embeds: [buildEmbed(ev, banner !== null)],
    };

    let res: Response;
    if (banner) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      form.append('files[0]', new Blob([banner], { type: 'image/png' }), BANNER_FILENAME);
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

/** Embed bar / banner accent colour for an event. */
export function cardColor(ev: NewFollow): number {
  if (ev.classification.highPriority) return COLOR_HIGH;
  return ev.followed.verified ? COLOR_VERIFIED : COLOR_NORMAL;
}

/**
 * Build the minimal Discord embed for a follow event. The generated banner is
 * the primary visual — the embed carries only a few lines of text. Exported so
 * the offline preview / tests can render the payload without the network.
 *
 * `withBanner` controls whether embed.image points at the attached banner
 * (false when banner generation failed, so we don't reference a missing file).
 */
export function buildEmbed(ev: NewFollow, withBanner = true): Record<string, unknown> {
  const f = ev.followed;
  const c = ev.classification;
  const high = c.highPriority;

  const infName = ev.influencer.label ?? ev.influencer.username;
  const folName = f.displayName ?? f.username;
  const hhmm = formatHhmmUtc(ev.detectedAt);

  // Sparse, spaced body (no field grid): the event lives in the title; the
  // description is just the time and two minimal stat lines, separated by blank
  // lines for whitespace.
  const event = `${infName} → ${folName}`;
  const title = `${high ? '🚨 HIGH PRIORITY' : '🔔 NEW FOLLOW'} · ${event}`;

  const stats = high
    ? [c.caSignal === 'launchpad' ? '🚀 Launchpad CA detected' : '🟢 CA detected', `Score ${c.projectScore}`]
    : [`Score ${c.projectScore}`, `${compactNumber(f.followersCount)} followers`];

  // Blocks joined with a blank line; lines within a block by a single break.
  const blocks: string[] = [];
  if (hhmm) blocks.push(`${hhmm} UTC`);
  blocks.push(stats.join('\n'));

  const embed: Record<string, unknown> = {
    title,
    url: profileUrl(f.username),
    description: blocks.join('\n\n'),
    color: cardColor(ev),
    footer: { text: hhmm ? `Follow Tracker · ${hhmm} UTC` : 'Follow Tracker' },
  };

  if (withBanner) embed.image = { url: `attachment://${BANNER_FILENAME}` };

  return embed;
}

function profileUrl(username: string): string {
  return `https://x.com/${encodeURIComponent(username)}`;
}

/** Extract "HH:MM" in UTC from an ISO timestamp; undefined if missing/invalid. */
function formatHhmmUtc(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 5400 -> "5.4k", 95000 -> "95k", 1200000 -> "1.2M". */
function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`;
}
