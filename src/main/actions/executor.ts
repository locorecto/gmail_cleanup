import type Database from "better-sqlite3";
import type { GmailClient } from "../sync/gmail-client";
import { moveToTrash, archiveMessages, moveOutOfTrash } from "../sync/gmail-client";
import { logAction, markUndone, getSettings } from "../db/index";
import { writeBackup } from "../backup/jsonl";
import type { BatchPreview, DbMessage } from "../../shared/types";

export interface ExecuteOptions {
  category_id: string;
  message_ids?: string[]; // if undefined, use all in category
  action: "trash" | "archive";
  dry_run: boolean;
  gmail: GmailClient;
  accountEmail: string;
}

export async function executeAction(
  db: Database.Database,
  opts: ExecuteOptions
): Promise<{ log_id: number; affected: number }> {
  const settings = getSettings(db);

  // Resolve message IDs
  let ids: string[];
  if (opts.message_ids && opts.message_ids.length > 0) {
    ids = opts.message_ids;
  } else {
    const rows = db
      .prepare("SELECT id FROM messages WHERE category_id = ?")
      .all(opts.category_id) as Array<{ id: string }>;
    ids = rows.map((r) => r.id);
  }

  if (ids.length === 0) {
    const logId = logAction(db, {
      performed_at: Date.now(),
      category_id: opts.category_id,
      action: opts.action,
      message_ids: "[]",
      dry_run: opts.dry_run ? 1 : 0,
      notes: "No messages matched",
    });
    return { log_id: logId, affected: 0 };
  }

  // Session mutation cap check
  if (!opts.dry_run && ids.length > settings.session_mutation_cap) {
    throw new Error(
      `Batch of ${ids.length} exceeds session mutation cap of ${settings.session_mutation_cap}. ` +
      `Adjust the cap in Settings if intentional.`
    );
  }

  // Log BEFORE mutating so we always have a record even on partial failure
  const logId = logAction(db, {
    performed_at: Date.now(),
    category_id: opts.category_id,
    action: opts.action,
    message_ids: JSON.stringify(ids),
    dry_run: opts.dry_run ? 1 : 0,
    notes: null,
  });

  if (opts.dry_run) {
    return { log_id: logId, affected: ids.length };
  }

  // Local backup before mutation
  const msgRows = db
    .prepare(`SELECT * FROM messages WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as DbMessage[];
  await writeBackup(opts.accountEmail, logId, msgRows);

  // Execute against Gmail API
  if (opts.action === "trash") {
    await moveToTrash(opts.gmail, ids);
    // Remove from local cache so they don't reappear in categories
    const stmt = db.prepare("UPDATE messages SET category_id = NULL, labels = json_set(labels, '$[#]', 'TRASH') WHERE id = ?");
    const tx = db.transaction(() => {
      for (const id of ids) stmt.run(id);
    });
    tx();
  } else {
    await archiveMessages(opts.gmail, ids);
    const stmt = db.prepare("UPDATE messages SET category_id = NULL WHERE id = ?");
    const tx = db.transaction(() => {
      for (const id of ids) stmt.run(id);
    });
    tx();
  }

  return { log_id: logId, affected: ids.length };
}

export async function undoAction(
  db: Database.Database,
  gmail: GmailClient,
  logId: number
): Promise<{ restored: number }> {
  const entry = db
    .prepare("SELECT * FROM action_log WHERE id = ?")
    .get(logId) as { id: number; action: string; message_ids: string; undone: number; dry_run: number } | undefined;

  if (!entry) throw new Error(`Action log entry ${logId} not found`);
  if (entry.undone) throw new Error("This action has already been undone");
  if (entry.dry_run) throw new Error("Cannot undo a dry-run");

  const ids: string[] = JSON.parse(entry.message_ids);
  if (ids.length === 0) return { restored: 0 };

  await moveOutOfTrash(gmail, ids);
  markUndone(db, logId);

  return { restored: ids.length };
}

export function getBatchPreview(
  db: Database.Database,
  category_id: string,
  message_ids?: string[]
): BatchPreview {
  let ids: string[];
  if (message_ids && message_ids.length > 0) {
    ids = message_ids;
  } else {
    const rows = db
      .prepare("SELECT id FROM messages WHERE category_id = ?")
      .all(category_id) as Array<{ id: string }>;
    ids = rows.map((r) => r.id);
  }

  if (ids.length === 0) {
    return {
      message_count: 0,
      total_size_bytes: 0,
      oldest_date: null,
      newest_date: null,
      sample_subjects: [],
      excluded_count: 0,
    };
  }

  const placeholders = ids.map(() => "?").join(",");
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS cnt,
      COALESCE(SUM(size_bytes), 0) AS total_size,
      MIN(internal_date) AS oldest,
      MAX(internal_date) AS newest
    FROM messages WHERE id IN (${placeholders})
  `).get(...ids) as { cnt: number; total_size: number; oldest: number; newest: number };

  // 5 oldest + 5 newest subjects for the sample
  const oldest5 = db.prepare(`
    SELECT subject FROM messages WHERE id IN (${placeholders})
    ORDER BY internal_date ASC LIMIT 5
  `).all(...ids) as Array<{ subject: string | null }>;

  const newest5 = db.prepare(`
    SELECT subject FROM messages WHERE id IN (${placeholders})
    ORDER BY internal_date DESC LIMIT 5
  `).all(...ids) as Array<{ subject: string | null }>;

  const sample = [
    ...oldest5.map((r) => r.subject ?? "(no subject)"),
    ...newest5.map((r) => r.subject ?? "(no subject)"),
  ];

  return {
    message_count: stats.cnt,
    total_size_bytes: stats.total_size,
    oldest_date: stats.oldest ?? null,
    newest_date: stats.newest ?? null,
    sample_subjects: sample,
    excluded_count: 0, // protected messages are already excluded before this point
  };
}
