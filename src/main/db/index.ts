import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { DbMessage, DbSender, DbCategory, DbRule, DbActionLog, DbSyncState, AppSettings } from "../../shared/types";
import { BUILT_IN_CATEGORIES } from "../../shared/categories";

const SCHEMA_VERSION = 1;

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = app.getPath("userData");
  const dbPath = path.join(dataDir, "gmail-cleanup.db");
  _db = new Database(dbPath);
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  const schemaSQL = fs.readFileSync(
    path.join(__dirname, "schema.sql"),
    "utf-8"
  );
  db.exec(schemaSQL);

  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  const current = row?.version ?? 0;

  if (current < 1) {
    // Seed built-in categories
    const insert = db.prepare(`
      INSERT OR IGNORE INTO categories (id, display_name, description, priority, default_action, enabled)
      VALUES (@id, @display_name, @description, @priority, @default_action, @enabled)
    `);
    const insertMany = db.transaction((cats: DbCategory[]) => {
      for (const cat of cats) insert.run(cat);
    });
    insertMany(BUILT_IN_CATEGORIES);

    // Seed default settings
    const defaults: AppSettings = {
      receipts_months: 6,
      attachments_months: 12,
      high_volume_per_month: 20,
      confirm_threshold: 1000,
      llm_enabled: false,
      llm_api_key: null,
      llm_cost_cap_usd: 5,
      session_mutation_cap: 50000,
    };
    const setSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(defaults)) {
      setSetting.run(k, JSON.stringify(v));
    }

    if (current === 0) {
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    } else {
      db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    }
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function getSettings(db: Database.Database): AppSettings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const map: Record<string, unknown> = {};
  for (const row of rows) {
    map[row.key] = JSON.parse(row.value);
  }
  return map as unknown as AppSettings;
}

export function setSettings(db: Database.Database, patch: Partial<AppSettings>): AppSettings {
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  const tx = db.transaction((p: Partial<AppSettings>) => {
    for (const [k, v] of Object.entries(p)) {
      stmt.run(k, JSON.stringify(v));
    }
  });
  tx(patch);
  return getSettings(db);
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function upsertMessages(db: Database.Database, msgs: DbMessage[]): void {
  const stmt = db.prepare(`
    INSERT INTO messages (
      id, thread_id, from_email, from_domain, to_emails, cc_emails,
      subject, snippet, size_bytes, internal_date, labels,
      has_list_unsub, list_id, is_unread, fetched_at
    ) VALUES (
      @id, @thread_id, @from_email, @from_domain, @to_emails, @cc_emails,
      @subject, @snippet, @size_bytes, @internal_date, @labels,
      @has_list_unsub, @list_id, @is_unread, @fetched_at
    )
    ON CONFLICT(id) DO UPDATE SET
      labels       = excluded.labels,
      is_unread    = excluded.is_unread,
      fetched_at   = excluded.fetched_at
  `);
  const tx = db.transaction((rows: DbMessage[]) => {
    for (const row of rows) stmt.run(row);
  });
  tx(msgs);
}

export function updateMessageCategories(
  db: Database.Database,
  assignments: Array<{ id: string; category_id: string; confidence: number }>
): void {
  const stmt = db.prepare(
    "UPDATE messages SET category_id = @category_id, confidence = @confidence WHERE id = @id"
  );
  const tx = db.transaction((rows: typeof assignments) => {
    for (const row of rows) stmt.run(row);
  });
  tx(assignments);
}

// ── Senders ───────────────────────────────────────────────────────────────────

export function rebuildSenders(db: Database.Database, accountEmail: string): void {
  db.exec("DELETE FROM senders");

  // Compute sender stats from messages table
  const rows = db.prepare(`
    SELECT
      from_email AS email,
      from_domain AS domain,
      COUNT(*)                                                   AS total_count,
      SUM(is_unread)                                             AS unread_count,
      MAX(has_list_unsub)                                        AS has_list_unsub,
      MIN(internal_date)                                         AS first_seen,
      MAX(internal_date)                                         AS last_seen
    FROM messages
    GROUP BY from_email
  `).all() as Array<{
    email: string; domain: string; total_count: number;
    unread_count: number; has_list_unsub: number;
    first_seen: number; last_seen: number;
  }>;

  // Count replied threads: threads where I also sent a message
  const repliedEmails = new Set<string>(
    (db.prepare(`
      SELECT DISTINCT m.from_email
      FROM messages m
      WHERE EXISTS (
        SELECT 1 FROM messages me
        WHERE me.thread_id = m.thread_id
          AND me.from_email = ?
      ) AND m.from_email != ?
    `).all(accountEmail, accountEmail) as Array<{ from_email: string }>)
      .map((r) => r.from_email)
  );

  const insert = db.prepare(`
    INSERT OR REPLACE INTO senders
      (email, domain, display_name, total_count, unread_count, replied_count, first_seen, last_seen, has_list_unsub)
    VALUES
      (@email, @domain, NULL, @total_count, @unread_count, @replied_count, @first_seen, @last_seen, @has_list_unsub)
  `);
  const tx = db.transaction(() => {
    for (const row of rows) {
      insert.run({
        ...row,
        replied_count: repliedEmails.has(row.email) ? 1 : 0,
      });
    }
  });
  tx();
}

// ── Sync state ────────────────────────────────────────────────────────────────

export function getSyncState(db: Database.Database, email: string): DbSyncState | null {
  return db.prepare("SELECT * FROM sync_state WHERE account_email = ?").get(email) as DbSyncState | null;
}

export function setSyncState(db: Database.Database, state: DbSyncState): void {
  db.prepare(`
    INSERT OR REPLACE INTO sync_state (account_email, last_history_id, last_full_sync, last_sync)
    VALUES (@account_email, @last_history_id, @last_full_sync, @last_sync)
  `).run(state);
}

// ── Rules ─────────────────────────────────────────────────────────────────────

export function getRules(db: Database.Database): DbRule[] {
  return db.prepare("SELECT * FROM rules ORDER BY id").all() as DbRule[];
}

export function addRule(db: Database.Database, rule: Omit<DbRule, "id">): DbRule {
  const info = db.prepare(
    "INSERT INTO rules (kind, pattern, created_at, note) VALUES (@kind, @pattern, @created_at, @note)"
  ).run(rule);
  return db.prepare("SELECT * FROM rules WHERE id = ?").get(info.lastInsertRowid) as DbRule;
}

export function deleteRule(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM rules WHERE id = ?").run(id);
}

// ── Categories ────────────────────────────────────────────────────────────────

export function getCategorySummaries(db: Database.Database) {
  return db.prepare(`
    SELECT
      c.id,
      c.display_name,
      c.description,
      c.default_action,
      COUNT(m.id)        AS message_count,
      COALESCE(SUM(m.size_bytes), 0) AS total_size_bytes,
      MIN(m.internal_date) AS oldest_date,
      MAX(m.internal_date) AS newest_date
    FROM categories c
    LEFT JOIN messages m ON m.category_id = c.id
    WHERE c.enabled = 1
    GROUP BY c.id
    HAVING message_count > 0
    ORDER BY total_size_bytes DESC
  `).all();
}

// ── Action log ────────────────────────────────────────────────────────────────

export function logAction(
  db: Database.Database,
  entry: Omit<DbActionLog, "id" | "undone" | "undone_at">
): number {
  const info = db.prepare(`
    INSERT INTO action_log (performed_at, category_id, action, message_ids, dry_run, undone, notes)
    VALUES (@performed_at, @category_id, @action, @message_ids, @dry_run, 0, @notes)
  `).run(entry);
  return Number(info.lastInsertRowid);
}

export function markUndone(db: Database.Database, log_id: number): void {
  db.prepare(
    "UPDATE action_log SET undone = 1, undone_at = ? WHERE id = ?"
  ).run(Date.now(), log_id);
}

export function getActionLog(db: Database.Database, limit: number, offset: number) {
  return db.prepare(`
    SELECT
      a.id, a.performed_at, a.category_id, c.display_name AS category_name,
      a.action, a.message_ids, a.dry_run, a.undone, a.undone_at, a.notes
    FROM action_log a
    LEFT JOIN categories c ON c.id = a.category_id
    ORDER BY a.performed_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}
