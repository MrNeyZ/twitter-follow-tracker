import { NewFollow } from '../types';

/** Sends alerts to a Telegram chat via the Bot API. */
export class TelegramAlerter {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string
  ) {}

  async sendNewFollow(ev: NewFollow): Promise<void> {
    await this.send(formatMessage(ev));
  }

  private async send(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram sendMessage failed: ${res.status} — ${body.slice(0, 300)}`);
    }
  }
}

function formatMessage(ev: NewFollow): string {
  const inf = ev.influencer.label ?? ev.influencer.username;
  const f = ev.followed;
  const kw = ev.score.matchedKeywords.length
    ? ev.score.matchedKeywords.join(', ')
    : '—';
  const verified = f.verified ? '✅' : '—';
  const lines: (string | null)[] = [
    `🔔 <b>New follow</b>`,
    ``,
    `<b>${escapeHtml(inf)}</b> (@${escapeHtml(ev.influencer.username)}) just followed:`,
    `➡️ <b>@${escapeHtml(f.username)}</b>`,
    f.displayName ? `   ${escapeHtml(f.displayName)}` : null,
    ``,
    `👥 Followers: ${f.followersCount.toLocaleString('en-US')}`,
    `🔵 Verified: ${verified}`,
    `🏷️ Keywords: ${escapeHtml(kw)}`,
    `⭐ Score: ${ev.score.score}`,
    ``,
    `https://x.com/${encodeURIComponent(f.username)}`,
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
