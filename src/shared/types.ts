// ── DB row types ──────────────────────────────────────────────────────────────

export interface DbMessage {
  id: string;
  thread_id: string;
  from_email: string;
  from_domain: string;
  to_emails: string; // JSON array
  cc_emails: string; // JSON array
  subject: string | null;
  snippet: string | null;
  size_bytes: number | null;
  internal_date: number; // ms since epoch
  labels: string; // JSON array
  has_list_unsub: 0 | 1;
  list_id: string | null;
  is_unread: 0 | 1;
  category_id: string | null;
  confidence: number | null;
  fetched_at: number;
  body_cached: 0 | 1;
}

export interface DbSender {
  email: string;
  domain: string;
  display_name: string | null;
  total_count: number;
  unread_count: number;
  replied_count: number;
  first_seen: number | null;
  last_seen: number | null;
  has_list_unsub: 0 | 1;
}

export interface DbCategory {
  id: string;
  display_name: string;
  description: string | null;
  priority: number;
  default_action: "trash" | "archive";
  enabled: 0 | 1;
}

export interface DbRule {
  id: number;
  kind: "allow_sender" | "allow_domain" | "allow_keyword" | "allow_label";
  pattern: string;
  created_at: number;
  note: string | null;
}

export interface DbActionLog {
  id: number;
  performed_at: number;
  category_id: string | null;
  action: "trash" | "archive" | "untrash";
  message_ids: string; // JSON array
  dry_run: 0 | 1;
  undone: 0 | 1;
  undone_at: number | null;
  notes: string | null;
}

export interface DbSyncState {
  account_email: string;
  last_history_id: string | null;
  last_full_sync: number | null;
  last_sync: number | null;
}

// ── IPC payload types ─────────────────────────────────────────────────────────

export interface CategorySummary {
  id: string;
  display_name: string;
  description: string | null;
  default_action: "trash" | "archive";
  message_count: number;
  total_size_bytes: number;
  oldest_date: number | null;
  newest_date: number | null;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  from_email: string;
  subject: string | null;
  snippet: string | null;
  size_bytes: number | null;
  internal_date: number;
  is_unread: boolean;
}

export interface BatchPreview {
  message_count: number;
  total_size_bytes: number;
  oldest_date: number | null;
  newest_date: number | null;
  sample_subjects: string[];
  excluded_count: number;
}

export interface SyncProgress {
  phase: "listing" | "fetching" | "categorizing" | "done" | "error";
  total: number;
  done: number;
  message?: string;
}

export interface ActionLogEntry {
  id: number;
  performed_at: number;
  category_id: string | null;
  category_name: string | null;
  action: "trash" | "archive" | "untrash";
  message_count: number;
  dry_run: boolean;
  undone: boolean;
  undone_at: number | null;
}

export interface AppSettings {
  receipts_months: number;
  attachments_months: number;
  high_volume_per_month: number;
  confirm_threshold: number;
  llm_enabled: boolean;
  llm_api_key: string | null;
  llm_cost_cap_usd: number;
  session_mutation_cap: number;
}

export interface ConnectedAccount {
  email: string;
  last_sync: number | null;
}

// ── IPC channel map (main → renderer events) ──────────────────────────────────

export type IpcChannels = {
  // invokable (renderer → main, returns promise)
  "auth:connect": { args: []; result: ConnectedAccount };
  "auth:disconnect": { args: []; result: void };
  "auth:status": { args: []; result: ConnectedAccount | null };
  "sync:start": { args: []; result: void };
  "categories:list": { args: []; result: CategorySummary[] };
  "messages:list": {
    args: [{ category_id: string; offset: number; limit: number }];
    result: { rows: MessageRow[]; total: number };
  };
  "batch:preview": {
    args: [{ category_id: string; message_ids?: string[] }];
    result: BatchPreview;
  };
  "batch:execute": {
    args: [
      {
        category_id: string;
        message_ids?: string[];
        action: "trash" | "archive";
        dry_run: boolean;
      },
    ];
    result: { log_id: number; affected: number };
  };
  "batch:undo": { args: [{ log_id: number }]; result: { restored: number } };
  "actionlog:list": {
    args: [{ limit: number; offset: number }];
    result: ActionLogEntry[];
  };
  "rules:list": { args: []; result: DbRule[] };
  "rules:add": {
    args: [
      {
        kind: DbRule["kind"];
        pattern: string;
        note?: string;
      },
    ];
    result: DbRule;
  };
  "rules:delete": { args: [{ id: number }]; result: void };
  "settings:get": { args: []; result: AppSettings };
  "settings:set": { args: [Partial<AppSettings>]; result: AppSettings };

  // events (main → renderer, one-way)
  "sync:progress": SyncProgress;
};
