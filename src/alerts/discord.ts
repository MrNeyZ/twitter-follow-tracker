import { NewFollow } from '../types';

/** Sends alerts to a Discord channel via an incoming webhook. */
export class DiscordAlerter {
  constructor(private readonly webhookUrl: string) {}

  async sendNewFollow(ev: NewFollow): Promise<void> {
    const inf = ev.influencer.label ?? ev.influencer.username;
    const f = ev.followed;
    const c = ev.classification;
    const highSignal = c.projectScore >= 85;
    const kw = ev.score.matchedKeywords.length
      ? ev.score.matchedKeywords.join(', ')
      : '—';
    const reasons = c.reasons.length ? c.reasons.map((r) => `• ${r}`).join('\n') : '—';

    const embed = {
      title: `${highSignal ? '🚨 HIGH SIGNAL — ' : '🔔 '}${inf} followed @${f.username}`,
      url: `https://x.com/${encodeURIComponent(f.username)}`,
      description: f.displayName ?? undefined,
      // Red for high-signal, blue for verified, green otherwise.
      color: highSignal ? 0xe74c3c : f.verified ? 0x1da1f2 : 0x2ecc71,
      fields: [
        { name: 'Category', value: c.category, inline: true },
        { name: 'Project score', value: `${c.projectScore}/100`, inline: true },
        { name: 'Relevance', value: String(ev.score.score), inline: true },
        {
          name: 'Followers',
          value: f.followersCount.toLocaleString('en-US'),
          inline: true,
        },
        { name: 'Verified', value: f.verified ? 'Yes' : 'No', inline: true },
        { name: 'Keywords', value: kw, inline: true },
        { name: 'Reasons', value: reasons.slice(0, 1024), inline: false },
      ],
    };

    const res = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Follow Tracker',
        embeds: [embed],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Discord webhook failed: ${res.status} — ${body.slice(0, 300)}`);
    }
  }
}
