import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { SorsaUser, WatchedInfluencer, ScoreResult } from './types';

/**
 * SQLite persistence layer.
 *
 * Tables:
 *   - watched_accounts:   the influencers we monitor (mirrors config + resolved id)
 *   - current_following:  latest known following set per influencer (the snapshot)
 *   - follow_events:      detected new follows (one row per influencer+followed pair)
 */
export class Db {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watched_accounts (
        influencer_id   TEXT PRIMARY KEY,
        username        TEXT NOT NULL,
        label           TEXT,
        baseline_done   INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS current_following (
        influencer_id    TEXT NOT NULL,
        followed_user_id TEXT NOT NULL,
        username         TEXT,
        first_seen_at    TEXT NOT NULL,
        PRIMARY KEY (influencer_id, followed_user_id)
      );

      CREATE TABLE IF NOT EXISTS follow_events (
        influencer_id    TEXT NOT NULL,
        followed_user_id TEXT NOT NULL,
        followed_username TEXT,
        followers_count  INTEGER,
        verified         INTEGER,
        score            REAL,
        matched_keywords TEXT,
        created_at       TEXT NOT NULL,
        alerted          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (influencer_id, followed_user_id)
      );
    `);
    this.migrate();
  }

  /**
   * Idempotent, additive migrations. SQLite has no `ADD COLUMN IF NOT EXISTS`,
   * so we check PRAGMA table_info and ALTER only when the column is missing.
   * Safe to run on every startup.
   */
  private migrate(): void {
    // Count-gated polling (cost control): remember the last profile following
    // count we acted on, and when we last did a full followings re-baseline.
    this.addColumnIfMissing('watched_accounts', 'following_count', 'INTEGER');
    this.addColumnIfMissing('watched_accounts', 'last_full_followings_check_at', 'TEXT');
  }

  /** Add a column to a table only if it isn't already present (idempotent). */
  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  /** Upsert a watched account row (keyed by resolved influencer id). */
  upsertWatchedAccount(influencerId: string, inf: WatchedInfluencer): void {
    this.db
      .prepare(
        `INSERT INTO watched_accounts (influencer_id, username, label)
         VALUES (@influencer_id, @username, @label)
         ON CONFLICT(influencer_id) DO UPDATE SET
           username = excluded.username,
           label = excluded.label`
      )
      .run({
        influencer_id: influencerId,
        username: inf.username,
        label: inf.label ?? null,
      });
  }

  hasBaseline(influencerId: string): boolean {
    const row = this.db
      .prepare(`SELECT baseline_done FROM watched_accounts WHERE influencer_id = ?`)
      .get(influencerId) as { baseline_done: number } | undefined;
    return !!row && row.baseline_done === 1;
  }

  markBaselineDone(influencerId: string): void {
    this.db
      .prepare(`UPDATE watched_accounts SET baseline_done = 1 WHERE influencer_id = ?`)
      .run(influencerId);
  }

  markChecked(influencerId: string, isoTime: string): void {
    this.db
      .prepare(`UPDATE watched_accounts SET last_checked_at = ? WHERE influencer_id = ?`)
      .run(isoTime, influencerId);
  }

  /**
   * Last poll time (ISO) for a watched account, looked up by username so the
   * due-check can run BEFORE resolving a provider user id (no API call for
   * skipped accounts). Returns null if never checked / not yet stored.
   */
  getLastCheckedAtByUsername(username: string): string | null {
    const row = this.db
      .prepare(`SELECT last_checked_at FROM watched_accounts WHERE username = ?`)
      .get(username) as { last_checked_at: string | null } | undefined;
    return row?.last_checked_at ?? null;
  }

  /**
   * Last profile `following` count we acted on for this influencer (the value
   * the count-gate compares against), or null if not yet recorded.
   */
  getFollowingCount(influencerId: string): number | null {
    const row = this.db
      .prepare(`SELECT following_count FROM watched_accounts WHERE influencer_id = ?`)
      .get(influencerId) as { following_count: number | null } | undefined;
    return row?.following_count ?? null;
  }

  /** Store the profile following count gated on (called after a full fetch). */
  setFollowingCount(influencerId: string, count: number): void {
    this.db
      .prepare(`UPDATE watched_accounts SET following_count = ? WHERE influencer_id = ?`)
      .run(count, influencerId);
  }

  /** When we last did a full followings fetch (re-baseline) for this account. */
  getLastFullFollowingsCheckAt(influencerId: string): string | null {
    const row = this.db
      .prepare(`SELECT last_full_followings_check_at FROM watched_accounts WHERE influencer_id = ?`)
      .get(influencerId) as { last_full_followings_check_at: string | null } | undefined;
    return row?.last_full_followings_check_at ?? null;
  }

  /** Record that a full followings fetch happened (resets the re-baseline timer). */
  markFullFollowingsCheck(influencerId: string, isoTime: string): void {
    this.db
      .prepare(
        `UPDATE watched_accounts SET last_full_followings_check_at = ? WHERE influencer_id = ?`
      )
      .run(isoTime, influencerId);
  }

  /** Returns the set of followed_user_ids currently stored for an influencer. */
  getCurrentFollowingIds(influencerId: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT followed_user_id FROM current_following WHERE influencer_id = ?`)
      .all(influencerId) as { followed_user_id: string }[];
    return new Set(rows.map((r) => r.followed_user_id));
  }

  /**
   * How many distinct watched influencers currently follow this account.
   * Used as a corroboration signal in project scoring. (current_following has
   * a (influencer_id, followed_user_id) primary key, so COUNT(*) == #influencers.)
   */
  countInfluencersFollowing(followedUserId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM current_following WHERE followed_user_id = ?`
      )
      .get(followedUserId) as { c: number };
    return row.c;
  }

  /**
   * Replace the stored following snapshot for an influencer with the given set.
   * Done in a transaction so a crash can't leave a half-written snapshot.
   */
  replaceFollowingSnapshot(
    influencerId: string,
    following: SorsaUser[],
    isoTime: string
  ): void {
    const del = this.db.prepare(`DELETE FROM current_following WHERE influencer_id = ?`);
    const ins = this.db.prepare(
      `INSERT INTO current_following (influencer_id, followed_user_id, username, first_seen_at)
       VALUES (?, ?, ?, ?)`
    );
    const tx = this.db.transaction((users: SorsaUser[]) => {
      del.run(influencerId);
      for (const u of users) {
        ins.run(influencerId, u.id, u.username, isoTime);
      }
    });
    tx(following);
  }

  /** Add new followed ids to the snapshot without wiping existing ones. */
  addToFollowingSnapshot(
    influencerId: string,
    users: SorsaUser[],
    isoTime: string
  ): void {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO current_following (influencer_id, followed_user_id, username, first_seen_at)
       VALUES (?, ?, ?, ?)`
    );
    const tx = this.db.transaction((list: SorsaUser[]) => {
      for (const u of list) ins.run(influencerId, u.id, u.username, isoTime);
    });
    tx(users);
  }

  /** True if we've already recorded (and therefore alerted) this follow event. */
  hasFollowEvent(influencerId: string, followedUserId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM follow_events WHERE influencer_id = ? AND followed_user_id = ?`
      )
      .get(influencerId, followedUserId);
    return !!row;
  }

  /**
   * Insert a follow event if it doesn't already exist.
   * Returns true if a new row was inserted (i.e. this is a brand-new follow).
   */
  insertFollowEvent(
    influencerId: string,
    followed: SorsaUser,
    score: ScoreResult,
    isoTime: string
  ): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO follow_events
           (influencer_id, followed_user_id, followed_username, followers_count,
            verified, score, matched_keywords, created_at, alerted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        influencerId,
        followed.id,
        followed.username,
        followed.followersCount,
        followed.verified ? 1 : 0,
        score.score,
        score.matchedKeywords.join(','),
        isoTime
      );
    return info.changes > 0;
  }

  markEventAlerted(influencerId: string, followedUserId: string): void {
    this.db
      .prepare(
        `UPDATE follow_events SET alerted = 1 WHERE influencer_id = ? AND followed_user_id = ?`
      )
      .run(influencerId, followedUserId);
  }

  close(): void {
    this.db.close();
  }
}
