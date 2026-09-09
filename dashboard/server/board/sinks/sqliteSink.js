import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Primary durable sink: a single local SQLite file.
 *
 * Databricks can't hold this role. Free Edition gates compute at its own
 * discretion — the workspace went INACTIVE for two days in Sept 2026 with
 * no warning — so a feed that depends on it for durability silently loses
 * every posting across a restart in that window.
 *
 * SQLite has no daemon, no install (node:sqlite is in core since Node 22),
 * no network, and native ON CONFLICT, which is a closer fit for this
 * workload than a MERGE against Delta. The board now survives restarts
 * whether or not Databricks is awake.
 */

const DB_PATH = process.env.BOARD_DB_PATH || "./data/board.sqlite";

let db;

function connect() {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);

  // WAL so a long read (the boot seed) can't block the poller's write.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS postings (
      posting_id   TEXT PRIMARY KEY,
      title        TEXT,
      company      TEXT,
      location     TEXT,
      job_url      TEXT,
      posted_at    TEXT,
      -- Absolute time derived from the detail page's "40 minutes ago".
      -- The board shows this; posted_at is date-only and rounds to midnight.
      posted_at_precise TEXT,
      applicants   INTEGER,
      retrieved_at TEXT NOT NULL,
      source       TEXT
    )
  `);

  // The seed reads a window ordered by arrival; without this it's a full
  // scan plus a sort on every boot.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_postings_retrieved ON postings(retrieved_at DESC)"
  );

  return db;
}

export const sqliteSink = {
  name: "sqlite",
  primary: true,

  persist(postings) {
    const conn = connect();
    const stmt = conn.prepare(`
      INSERT INTO postings
        (posting_id, title, company, location, job_url, posted_at,
         posted_at_precise, applicants, retrieved_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(posting_id) DO NOTHING
    `);

    // One transaction per batch: 25 individual commits would each fsync.
    conn.exec("BEGIN");
    try {
      for (const p of postings) {
        stmt.run(
          p.posting_id,
          p.title ?? null,
          p.company ?? null,
          p.location ?? null,
          p.job_url ?? null,
          p.posted_at ?? null,
          p.posted_at_precise ?? null,
          p.applicants ?? null,
          p.retrieved_at,
          p.source ?? null
        );
      }
      conn.exec("COMMIT");
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  },

  /** Rehydrates the in-memory store at boot. Local, so no cold start. */
  recent(windowHours, limit) {
    const cutoff = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    return connect()
      .prepare(
        `SELECT posting_id, title, company, location, job_url,
                posted_at, posted_at_precise, applicants, retrieved_at, source
         FROM postings
         WHERE retrieved_at >= ?
         ORDER BY retrieved_at DESC
         LIMIT ?`
      )
      .all(cutoff, limit)
      .map((r) => ({ ...r }));
  },

  /**
   * Drops rows that have aged out of the window. The board only ever shows
   * the window, and Delta holds the long-term copy, so unbounded growth
   * here would be pure waste.
   */
  prune(windowHours) {
    const cutoff = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    connect().prepare("DELETE FROM postings WHERE retrieved_at < ?").run(cutoff);
  },
};
