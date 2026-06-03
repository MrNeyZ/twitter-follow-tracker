# twitter-follow-tracker

Minimal backend worker that monitors Crypto Twitter (X) influencers' **new follows**
via the [Sorsa API](https://api.sorsa.io/) and pushes alerts to **Telegram** and **Discord**.

This is a standalone MVP — no UI, no external integrations.

## How it works

On each polling cycle the worker:

1. Loads the watched influencer list from `src/config.ts`.
2. For each influencer:
   - resolves the `@username` → Sorsa user id (skipped if a `userId` is configured),
   - fetches the full **following** list via Sorsa.
3. **First successful run** for an influencer: saves a baseline snapshot and sends **no** alerts.
4. **Subsequent runs**: diffs the latest following list against the stored snapshot,
   detects newly followed accounts, records a follow event, and alerts Telegram + Discord.
5. **Duplicate prevention**: each `(influencer_id, followed_user_id)` pair is recorded once
   in `follow_events`, so the same new follow never alerts twice.
6. Each new follow gets a **placeholder score** from follower count, verified flag, and bio
   keyword matches (`solana, crypto, web3, ai, nft, memecoin, defi`).
7. Logs cycle start/end, per-influencer processing, following count, new-follow count, and
   errors — a failure on one influencer (or one alert channel) never crashes the worker.

## Project layout

```
src/
  index.ts            worker entrypoint + polling loop
  config.ts           env + WATCHED_INFLUENCERS list (placeholders)
  db.ts               SQLite layer (better-sqlite3)
  types.ts            shared types
  scoring.ts          placeholder relevance scoring
  providers/sorsa.ts  Sorsa API client (defensive response normalization)
  alerts/telegram.ts  Telegram Bot API alerts
  alerts/discord.ts   Discord webhook alerts
ecosystem.config.js   PM2 process definition
smoke-test.js         offline logic test (no network/keys required)
```

## Database (SQLite)

Tables (auto-created on first run):

- **watched_accounts** — one row per influencer (resolved id, baseline flag, last checked).
- **current_following** — the latest known following set per influencer (the snapshot).
- **follow_events** — one row per detected new follow `(influencer_id, followed_user_id)`,
  with score fields and an `alerted` flag (this is what enforces single-alert dedup).

DB file path defaults to `./data/tracker.db` (override with `DB_PATH`).

## Setup

Requirements: Node.js 18+ (uses the built-in global `fetch`).

```bash
npm install
cp .env.example .env
# edit .env with your real keys (never commit it)
```

### Configure environment

| Variable               | Required | Description                                            |
| ---------------------- | -------- | ------------------------------------------------------ |
| `SORSA_API_KEY`        | yes      | Sorsa API key (sent as the `ApiKey` header).           |
| `SORSA_BASE_URL`       | no       | Defaults to `https://api.sorsa.io/v3`.                 |
| `TELEGRAM_BOT_TOKEN`   | yes      | Bot token from @BotFather.                             |
| `TELEGRAM_CHAT_ID`     | yes      | Target chat/channel id.                                |
| `DISCORD_WEBHOOK_URL`  | yes      | Discord channel incoming-webhook URL.                  |
| `POLL_INTERVAL_MINUTES`| no       | Cycle interval in minutes (default `15`).              |
| `RUN_ONCE`             | no       | `true` runs a single cycle then exits (default `false`).|
| `DB_PATH`              | no       | SQLite file path (default `./data/tracker.db`).        |

### Configure the influencer list

The real list is provided separately. Add entries to `WATCHED_INFLUENCERS` in
[`src/config.ts`](src/config.ts):

```ts
export const WATCHED_INFLUENCERS: WatchedInfluencer[] = [
  { username: 'VitalikButerin', label: 'Vitalik' },
  { username: 'cobie', userId: '123456789' }, // userId skips resolution
];
```

## Run locally

```bash
# one-off single cycle (good for first run / testing)
npm run once          # = RUN_ONCE=true ts-node src/index.ts

# continuous loop in dev (ts-node, no build step)
npm run dev

# or build + run the compiled output
npm run build
npm start
```

The **first** continuous run establishes baselines (no alerts). New follows are alerted
from the second cycle onward.

### Offline logic test

```bash
npm run build
node smoke-test.js    # exercises baseline → diff → dedup → scoring, no network
```

## Run with PM2

```bash
npm run build
pm2 start ecosystem.config.js
pm2 logs twitter-follow-tracker
pm2 restart twitter-follow-tracker
pm2 stop twitter-follow-tracker

# persist across reboots
pm2 save
pm2 startup
```

PM2 runs a single long-lived instance; the worker handles its own polling interval
and restarts on crash (not on a clean exit).

## Notes / next steps

- The Sorsa response parser (`src/providers/sorsa.ts`) normalizes several common field
  aliases defensively. If the live payload differs, adjust `normalizeUser` /
  `extractUserList` / `extractNextCursor` in that one file.
- Scoring is a deliberate placeholder — tune weights in `src/scoring.ts` once real data lands.
