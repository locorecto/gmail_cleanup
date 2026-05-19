import type Database from "better-sqlite3";
import type { GmailClient, MessageMetadata } from "./gmail-client";
import {
  listAllMessageIds,
  fetchMessagesBatch,
  fetchHistory,
} from "./gmail-client";
import { upsertMessages, setSyncState, getSyncState, rebuildSenders } from "../db/index";
import type { DbMessage, SyncProgress } from "../../shared/types";
import { runCategorizer } from "../categorizer/engine";

export type ProgressCallback = (progress: SyncProgress) => void;

function parseEmail(header: string): string {
  const match = header.match(/<([^>]+)>/);
  return (match ? match[1] : header).trim().toLowerCase();
}

function parseDomain(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function parseEmails(header: string): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => parseEmail(s.trim()))
    .filter(Boolean);
}

function metadataToDbMessage(msg: MessageMetadata, now: number): DbMessage {
  const fromRaw = msg.headers["From"] ?? "";
  const fromEmail = parseEmail(fromRaw);
  const fromDomain = parseDomain(fromEmail);
  const toEmails = parseEmails(msg.headers["To"] ?? "");
  const ccEmails = parseEmails(msg.headers["Cc"] ?? "");
  const listUnsub = msg.headers["List-Unsubscribe"] ?? "";
  const listId = msg.headers["List-Id"] ?? null;

  return {
    id: msg.id,
    thread_id: msg.threadId,
    from_email: fromEmail,
    from_domain: fromDomain,
    to_emails: JSON.stringify(toEmails),
    cc_emails: JSON.stringify(ccEmails),
    subject: msg.headers["Subject"] ?? null,
    snippet: msg.snippet || null,
    size_bytes: msg.sizeEstimate || null,
    internal_date: msg.internalDate,
    labels: JSON.stringify(msg.labelIds),
    has_list_unsub: listUnsub ? 1 : 0,
    list_id: listId,
    is_unread: msg.labelIds.includes("UNREAD") ? 1 : 0,
    category_id: null,
    confidence: null,
    fetched_at: now,
    body_cached: 0,
  };
}

export async function fullBackfill(
  gmail: GmailClient,
  db: Database.Database,
  accountEmail: string,
  onProgress: ProgressCallback
): Promise<void> {
  const now = Date.now();

  onProgress({ phase: "listing", total: 0, done: 0, message: "Listing all messages…" });

  const allIds: string[] = [];
  const { historyId } = await listAllMessageIds(gmail, (ids) => {
    allIds.push(...ids);
    onProgress({ phase: "listing", total: allIds.length, done: allIds.length });
  });

  const total = allIds.length;
  onProgress({ phase: "fetching", total, done: 0, message: `Fetching metadata for ${total} messages…` });

  const BATCH = 50;
  let done = 0;

  for (let i = 0; i < allIds.length; i += BATCH) {
    const chunk = allIds.slice(i, i + BATCH);
    const metas = await fetchMessagesBatch(gmail, chunk);
    const rows = metas.map((m) => metadataToDbMessage(m, now));
    upsertMessages(db, rows);
    done += rows.length;
    onProgress({ phase: "fetching", total, done });
  }

  onProgress({ phase: "categorizing", total, done, message: "Building sender stats…" });
  rebuildSenders(db, accountEmail);

  onProgress({ phase: "categorizing", total, done, message: "Categorizing messages…" });
  runCategorizer(db, accountEmail);

  setSyncState(db, {
    account_email: accountEmail,
    last_history_id: historyId,
    last_full_sync: now,
    last_sync: now,
  });

  onProgress({ phase: "done", total, done: total, message: "Sync complete" });
}

export async function incrementalSync(
  gmail: GmailClient,
  db: Database.Database,
  accountEmail: string,
  onProgress: ProgressCallback
): Promise<void> {
  const state = getSyncState(db, accountEmail);
  if (!state?.last_history_id) {
    return fullBackfill(gmail, db, accountEmail, onProgress);
  }

  onProgress({ phase: "fetching", total: 0, done: 0, message: "Checking for new messages…" });

  const result = await fetchHistory(gmail, state.last_history_id);
  if (result === "too_old") {
    onProgress({ phase: "fetching", total: 0, done: 0, message: "History expired — running full sync…" });
    return fullBackfill(gmail, db, accountEmail, onProgress);
  }

  const { added, deletedIds, labelChanges, newHistoryId } = result;

  if (deletedIds.length > 0) {
    const stmt = db.prepare("DELETE FROM messages WHERE id = ?");
    const tx = db.transaction(() => {
      for (const id of deletedIds) stmt.run(id);
    });
    tx();
  }

  if (labelChanges.length > 0) {
    const stmt = db.prepare("UPDATE messages SET labels = ?, is_unread = ? WHERE id = ?");
    const tx = db.transaction(() => {
      for (const { id, labelIds } of labelChanges) {
        stmt.run(JSON.stringify(labelIds), labelIds.includes("UNREAD") ? 1 : 0, id);
      }
    });
    tx();
  }

  if (added.length > 0) {
    const now = Date.now();
    const BATCH = 50;
    for (let i = 0; i < added.length; i += BATCH) {
      const chunk = added.slice(i, i + BATCH);
      const metas = await fetchMessagesBatch(gmail, chunk);
      upsertMessages(db, metas.map((m) => metadataToDbMessage(m, now)));
    }
    rebuildSenders(db, accountEmail);
    runCategorizer(db, accountEmail);
  }

  setSyncState(db, {
    ...state,
    last_history_id: newHistoryId,
    last_sync: Date.now(),
  });

  onProgress({
    phase: "done",
    total: added.length,
    done: added.length,
    message: `Synced: +${added.length} new, ${deletedIds.length} removed`,
  });
}
