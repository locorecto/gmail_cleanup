import { ipcMain, BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import type { GmailClient } from "../sync/gmail-client";
import { createGmailClient } from "../sync/gmail-client";
import { runOAuthFlow, loadSavedCredentials, revokeCredentials } from "../auth/oauth";
import {
  getDb,
  getSettings,
  setSettings,
  getCategorySummaries,
  getRules,
  addRule,
  deleteRule,
  getActionLog,
} from "../db/index";
import { fullBackfill, incrementalSync } from "../sync/backfill";
import { executeAction, undoAction, getBatchPreview } from "../actions/executor";
import type {
  ConnectedAccount,
  CategorySummary,
  MessageRow,
  SyncProgress,
  ActionLogEntry,
} from "../../shared/types";
import * as keytar from "keytar";

const KEYTAR_SERVICE = "gmail-cleanup";
const ACCOUNT_KEY = "current-account";

let _account: ConnectedAccount | null = null;
let _gmail: GmailClient | null = null;
let _mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow): void {
  _mainWindow = win;
}

function emitProgress(progress: SyncProgress): void {
  _mainWindow?.webContents.send("sync:progress", progress);
}

function requireGmail(): { gmail: GmailClient; email: string } {
  if (!_gmail || !_account) throw new Error("Not authenticated");
  return { gmail: _gmail, email: _account.email };
}

async function persistCurrentAccount(email: string | null): Promise<void> {
  if (email) {
    await keytar.setPassword(KEYTAR_SERVICE, ACCOUNT_KEY, email);
  } else {
    await keytar.deletePassword(KEYTAR_SERVICE, ACCOUNT_KEY);
  }
}

export async function restoreSession(): Promise<void> {
  const email = await keytar.getPassword(KEYTAR_SERVICE, ACCOUNT_KEY);
  if (!email) return;

  const client = await loadSavedCredentials(email);
  if (!client) return;

  _gmail = createGmailClient(client);
  _account = { email, last_sync: getDb().prepare("SELECT last_sync FROM sync_state WHERE account_email = ?").get(email) ? (getDb().prepare("SELECT last_sync FROM sync_state WHERE account_email = ?").get(email) as { last_sync: number }).last_sync : null };
}

export function registerIpcHandlers(): void {
  // ── Auth ──────────────────────────────────────────────────────────────────────────

  ipcMain.handle("auth:status", async () => {
    return _account;
  });

  ipcMain.handle("auth:connect", async () => {
    const { email, client } = await runOAuthFlow();
    _gmail = createGmailClient(client);
    const state = getDb().prepare("SELECT last_sync FROM sync_state WHERE account_email = ?").get(email) as { last_sync: number } | undefined;
    _account = { email, last_sync: state?.last_sync ?? null };
    await persistCurrentAccount(email);
    return _account;
  });

  ipcMain.handle("auth:disconnect", async () => {
    if (_account) {
      await revokeCredentials(_account.email);
      await persistCurrentAccount(null);
    }
    _account = null;
    _gmail = null;
  });

  // ── Sync ──────────────────────────────────────────────────────────────────────────

  ipcMain.handle("sync:start", async () => {
    const { gmail, email } = requireGmail();
    const db = getDb();
    const state = db.prepare("SELECT last_history_id FROM sync_state WHERE account_email = ?").get(email) as { last_history_id: string } | undefined;

    if (state?.last_history_id) {
      await incrementalSync(gmail, db, email, emitProgress);
    } else {
      await fullBackfill(gmail, db, email, emitProgress);
    }

    const newState = db.prepare("SELECT last_sync FROM sync_state WHERE account_email = ?").get(email) as { last_sync: number } | undefined;
    if (_account) _account.last_sync = newState?.last_sync ?? null;
  });

  // ── Categories ──────────────────────────────────────────────────────────────────

  ipcMain.handle("categories:list", async (): Promise<CategorySummary[]> => {
    return getCategorySummaries(getDb()) as CategorySummary[];
  });

  // ── Messages ────────────────────────────────────────────────────────────────────

  ipcMain.handle(
    "messages:list",
    async (_event, { category_id, offset, limit }: { category_id: string; offset: number; limit: number }) => {
      const db = getDb();
      const rows = db.prepare(`
        SELECT id, thread_id, from_email, subject, snippet, size_bytes, internal_date, is_unread
        FROM messages WHERE category_id = ?
        ORDER BY internal_date DESC
        LIMIT ? OFFSET ?
      `).all(category_id, limit, offset) as MessageRow[];

      const { total } = db.prepare(
        "SELECT COUNT(*) AS total FROM messages WHERE category_id = ?"
      ).get(category_id) as { total: number };

      return { rows, total };
    }
  );

  // ── Batch preview & execute ──────────────────────────────────────────────────────

  ipcMain.handle(
    "batch:preview",
    async (_event, { category_id, message_ids }: { category_id: string; message_ids?: string[] }) => {
      return getBatchPreview(getDb(), category_id, message_ids);
    }
  );

  ipcMain.handle(
    "batch:execute",
    async (
      _event,
      opts: { category_id: string; message_ids?: string[]; action: "trash" | "archive"; dry_run: boolean }
    ) => {
      const { gmail, email } = requireGmail();
      return executeAction(getDb(), { ...opts, gmail, accountEmail: email });
    }
  );

  ipcMain.handle("batch:undo", async (_event, { log_id }: { log_id: number }) => {
    const { gmail } = requireGmail();
    return undoAction(getDb(), gmail, log_id);
  });

  // ── Action log ────────────────────────────────────────────────────────────────

  ipcMain.handle(
    "actionlog:list",
    async (_event, { limit, offset }: { limit: number; offset: number }): Promise<ActionLogEntry[]> => {
      const rows = getActionLog(getDb(), limit, offset) as Array<{
        id: number;
        performed_at: number;
        category_id: string | null;
        category_name: string | null;
        action: "trash" | "archive" | "untrash";
        message_ids: string;
        dry_run: number;
        undone: number;
        undone_at: number | null;
        notes: string | null;
      }>;
      return rows.map((r) => ({
        ...r,
        message_count: JSON.parse(r.message_ids).length,
        dry_run: r.dry_run === 1,
        undone: r.undone === 1,
      }));
    }
  );

  // ── Rules ─────────────────────────────────────────────────────────────────────

  ipcMain.handle("rules:list", async () => getRules(getDb()));

  ipcMain.handle(
    "rules:add",
    async (_event, rule: { kind: "allow_sender" | "allow_domain" | "allow_keyword" | "allow_label"; pattern: string; note?: string }) => {
      return addRule(getDb(), { ...rule, note: rule.note ?? null, created_at: Date.now() });
    }
  );

  ipcMain.handle("rules:delete", async (_event, { id }: { id: number }) => {
    deleteRule(getDb(), id);
  });

  // ── Settings ────────────────────────────────────────────────────────────────

  ipcMain.handle("settings:get", async () => getSettings(getDb()));
  ipcMain.handle("settings:set", async (_event, patch: Parameters<typeof setSettings>[1]) => {
    return setSettings(getDb(), patch);
  });
}
