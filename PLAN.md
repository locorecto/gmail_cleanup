# Gmail Cleanup — PLAN.md

> This document will be committed as `PLAN.md` at the repo root after approval.
> No implementation has begun yet.

## Context

The author has a Gmail mailbox that has accumulated 100k+ messages, the
overwhelming majority of which they will never read again: newsletters,
receipts, social notifications, CI alerts, expired promos, and one-off
senders. Gmail's built-in filters require knowing what to search for and
don't help discover *categories* of low-value mail. Manual cleanup at this
scale is impractical and risky — a single unlucky "Select all → Delete"
can lose important threads.

This project is a **single-user desktop app** that:

1. Connects to one Gmail account via OAuth 2.0.
2. Locally indexes message metadata and clusters messages into
   context-derived categories.
3. Presents each category as a reviewable batch with full per-batch
   confirmation, dry-run, undo, and an allowlist that is never touched.
4. Defaults to **Trash** (30-day Gmail recovery) — never permanent delete.

The bar is: the author should be able to delete tens of thousands of
messages in an afternoon, without ever worrying that something important
slipped through.

---

## 1. Architecture overview

```
┌───────────────────────────────────────────────────────────────┐
│                  Electron (Windows NSIS installer)            │
│                                                                │
│  Renderer (React + TS)            Main process (Node + TS)    │
│  ┌─────────────────────┐          ┌────────────────────────┐  │
│  │ Categories view     │ ◀──IPC──▶│ Gmail sync service     │  │
│  │ Batch review        │          │ Categorizer engine     │  │
│  │ Confirmation modal  │          │ Action executor        │  │
│  │ Settings / rules    │          │ Undo manager           │  │
│  └─────────────────────┘          │ LLM client (optional)  │  │
│                                   └─────────┬──────────────┘  │
│                                             │                  │
│                                   ┌─────────▼──────────────┐  │
│                                   │ SQLite (better-sqlite3)│  │
│                                   │  - messages cache      │  │
│                                   │  - categories          │  │
│                                   │  - rules / allowlist   │  │
│                                   │  - action_log (undo)   │  │
│                                   │  - sync_state          │  │
│                                   └────────────────────────┘  │
└─────────────────────────┬─────────────────────────────────────┘
                          │
            ┌─────────────┴──────────────┐
            │                            │
   ┌────────▼─────────┐         ┌────────▼──────────┐
   │ Gmail REST API   │         │ Local Ollama HTTP │
   │  (googleapis)    │         │ (optional, opt-in)│
   └──────────────────┘         └───────────────────┘
```

**Data flow per session:**

1. App boots → loads OAuth token from Windows Credential Manager.
2. Sync service does an incremental `users.history.list` from the last
   stored `historyId`. First run does a full `users.messages.list` walk
   in pages, batching `messages.get(format=METADATA)` calls.
3. Categorizer runs over new/changed rows in SQLite (pure SQL +
   TypeScript heuristics). Ambiguous rows can be queued for LLM.
4. UI reads category aggregates and renders cards. User clicks a
   category → preview list (paginated) → "Move N to Trash" →
   confirmation modal → action executor runs `batchModify` calls →
   writes an entry to `action_log` for undo.

**Components:**

| Component         | Responsibility                                                |
|-------------------|---------------------------------------------------------------|
| `auth`            | OAuth dance, token refresh, keychain storage                  |
| `sync`            | Incremental fetch via historyId, batched message metadata     |
| `db`              | SQLite schema, migrations, query helpers                      |
| `categorizer`     | Heuristic rules, scoring, category assignment                 |
| `llm-classifier` | Optional local Ollama calls for ambiguous messages (free, runs locally) |
| `actions`         | `batchModify` to Trash, label apply, undo replay              |
| `rules`           | Allowlist (senders/keywords/domains), protected criteria      |
| `ui`              | React app: categories, batch review, settings, action log     |

---

## 2. Tech stack

| Layer      | Choice                                | Why                                                   |
|------------|---------------------------------------|-------------------------------------------------------|
| Shell      | **Electron**                          | User preference. Mature on Windows, official Google libs in Node. |
| Language   | **TypeScript** (strict)               | One language across main + renderer; strong types catch row/field mistakes against the Gmail API. |
| UI         | React + Vite + Tailwind + shadcn/ui   | Fast iteration, accessible components, no design debt |
| State      | TanStack Query + Zustand              | Query handles IPC caching; Zustand for UI-local state |
| DB         | SQLite via `better-sqlite3`           | Synchronous, fast, perfect for 100k+ rows on one disk |
| Gmail SDK  | `googleapis` (official Node client)   | Built-in batching, retries, typed responses           |
| OAuth      | `google-auth-library` + `keytar`      | Refresh handling + Windows Credential Manager via keytar |
| LLM        | **Ollama** local HTTP API (`llama3.2:3b` default) | Free, fully local, no data leaves the machine. JSON-mode output |
| Packaging  | `electron-builder` → NSIS + portable  | Windows-only target per requirements                  |
| Testing    | Vitest (unit), Playwright (e2e UI)    | Standard for this stack                               |
| Lint/fmt   | Biome (or ESLint + Prettier)          | Single binary, fast                                   |

**Why not Python:** the official Gmail Node client has better batching
ergonomics, and Electron ships a single Windows installer via
electron-builder NSIS without the packaging pain of bundling a Python
interpreter + native Qt/Tk dependencies on Windows.

---

## 3. Gmail API integration

### Scopes

Minimal viable set:

- `https://www.googleapis.com/auth/gmail.modify` — read messages,
  modify labels, move to Trash. **Cannot permanently delete.** Good fit
  for this app's safety stance.
- `https://www.googleapis.com/auth/gmail.metadata` — *not used*; it
  forbids reading `body`/`snippet`, which we need for LLM snippets and
  the UI preview.

We deliberately do **not** request `gmail.readonly` (insufficient — no
modify) or `mail.google.com` (full access including permanent delete —
unnecessary risk).

### Auth flow

1. App ships with a **bundled** OAuth Desktop client (`client_id` +
   `client_secret` baked in). Per user choice; acceptable for personal
   use. Document the trust model in the README.
2. On first launch: open system browser to Google consent screen with
   `redirect_uri=http://127.0.0.1:<random_port>/oauth/callback` and a
   local one-shot HTTP listener catches the code.
3. Exchange code → access + refresh tokens.
4. Persist refresh token to **Windows Credential Manager** via `keytar`
   (service=`gmail-cleanup`, account=email). Never write tokens to disk
   in plaintext.
5. Refresh on 401 transparently inside the API client wrapper.

App will be flagged "unverified" by Google. Single-user is fine: click
through "Advanced → Go to Gmail Cleanup (unsafe)". README will document
this.

### Rate limits & batching

Gmail per-user quota: **250 quota units / user / second**, with these
costs that matter for us:

- `messages.list` = 5 units
- `messages.get` = 5 units
- `messages.batchModify` = 50 units (modifies up to 1000 IDs in one call)
- `history.list` = 2 units

Strategy:

- **Initial backfill**: page `messages.list?maxResults=500` → for each
  page, issue **HTTP batch requests** (10 `messages.get` at a time, 5x
  parallel batches = 50 in flight = 250 units = right at the limit) with
  exponential backoff on 429/5xx. Expect ~30–60 min for 100k messages
  on a residential connection.
- **Incremental sync**: store `historyId` per account in `sync_state`.
  `users.history.list?startHistoryId=...&historyTypes=messageAdded,labelAdded,labelRemoved`
  on every app open and on a "Sync now" button. If `historyId` is too
  old (Gmail keeps ~1 week), fall back to full re-list filtered by
  `internalDate > last_sync`.
- **Mutations**: always `batchModify` with 500-ID chunks. One batch =
  one row in `action_log` for undo.
- **Retry policy**: 5 retries with jitter on 429, 500, 502, 503, 504.
  Honor `Retry-After` when present.

### Fields fetched

For metadata pass (cheap, default):
`id, threadId, labelIds, snippet, sizeEstimate, internalDate,
payload.headers[Subject, From, To, Cc, List-Unsubscribe, List-Id, Date]`.

Full body only fetched **on demand** when the user opens a message in
the preview pane, or when LLM classification is requested for that
specific message.

---

## 4. Categorization engine

### Design

A **rule-based pipeline** that emits one category per message via a
priority cascade. LLM is a fallback for messages no rule confidently
claims. Per user preference: **most-specific category wins**.

### Rule cascade (highest priority first)

| # | Category                              | Rule                                                                                                    |
|---|---------------------------------------|---------------------------------------------------------------------------------------------------------|
| 0 | **Protected** (never offered)         | Matches allowlist (sender, domain, keyword), is starred, is in a thread I replied to, has IMPORTANT label, or in SENT |
| 1 | Calendar invites past their date      | From `calendar-notification@google.com` or has `Content-Type: text/calendar`, event end < today          |
| 2 | Automated alerts (CI/CD, monitoring)  | Sender domain matches `github.com`, `sentry.io`, `pagerduty.com`, `datadog`, etc. + age > 30d            |
| 3 | Social notifications                  | Sender domain ∈ {linkedin, facebook, twitter/x, instagram, reddit, ...}                                  |
| 4 | Transactional receipts > N months     | Has order/receipt keywords in subject AND sender ∈ known commerce list (Amazon, Uber, DoorDash...) AND age > N months |
| 5 | Promotional / discount (likely expired)| Has `List-Unsubscribe` header AND subject matches `%off|sale|deal|coupon|expires|limited time|last chance%` AND age > 30d |
| 6 | Newsletters & marketing               | Has `List-Unsubscribe` OR `List-Id` header AND I never replied to sender                                 |
| 7 | CC'd, never participated              | I'm in `Cc:` (not `To:`), thread has no message from me, age > 60d                                       |
| 8 | Large attachments older than X months | `sizeEstimate > 1 MB` AND age > X months AND not protected                                               |
| 9 | One-off senders, never opened         | Sender total message count ≤ 2 AND all UNREAD AND age > 90d                                              |
|10 | High-volume, mostly unread            | Sender sends > N msgs/month AND unread ratio > 80% (per user requirement)                                |
|11 | **Uncategorized / LLM candidate**     | Anything else with age > 1 year and not in INBOX as UNREAD                                               |

Thresholds (`N months`, `X months`, `N msgs/month`) are user-configurable
in Settings, with defaults: receipts = 6 months, attachments = 12 months,
high-volume = 20/month.

### Implementation

- Each rule is a TypeScript function:
  `(msg: CachedMessage, ctx: SenderStats) => CategoryMatch | null`.
- `SenderStats` is computed once per sync and stored in a `senders`
  table: total count, unread count, reply count, first/last seen,
  has_list_unsubscribe.
- Run rules top-down; first non-null match wins. Store the assigned
  category id and a `confidence` (1.0 for deterministic, <1 for LLM).
- Messages that fall through all rules → marked `needs_llm` if LLM is
  enabled, else `uncategorized` (not shown for deletion).

### LLM path (local Ollama)

- **Opt-in** via Settings. Off by default. No cloud calls, no API keys,
  no cost — runs entirely against a local Ollama server.
- **Prereqs**: user installs Ollama from <https://ollama.com>, runs
  `ollama pull llama3.2:3b` (default; configurable). Default endpoint
  `http://127.0.0.1:11434`.
- **Payload sent per message**: `from`, `subject`, `snippet` (Gmail's
  ~200-char snippet — already truncated by Gmail), `age_days`,
  `is_unread`, `has_list_unsubscribe`. **Never** the full body. Same
  data that would have gone to a cloud API, just routed to localhost.
- **Transport**: HTTP POST to `/api/chat` with `format: "json"` and
  `stream: false`. One message per request, temperature 0, num_ctx 2048
  — keeps small models reliable.
- **Output schema**: model returns
  `{ "category": "<id>", "confidence": 0..1, "reason": "<short>" }`.
  Invalid or `"uncategorized"` responses leave the message unclassified.
- **Cap**: `llm_max_per_run` setting (default 2000) bounds each run so
  the user can ctrl-C-equivalent (close the app) without losing much
  work, and so a slow local model doesn't tie up an entire afternoon.
- **Cost**: $0. Latency depends on the user's hardware and model size:
  on a CPU-only laptop, `llama3.2:3b` takes ~1–3 s per message; on a
  modern GPU, well under a second. Larger models (e.g. `qwen2.5:7b`)
  give better classification at higher latency.
- **Test button** in Settings calls `/api/tags` to verify the endpoint
  is reachable and lists installed models.

### Conflict resolution

Per user choice: **priority cascade, single category, first match
wins**. Rules are ordered most-specific to least-specific. The
allowlist (rule 0) always wins and short-circuits.

---

## 5. Data model (SQLite)

```sql
-- One row per Gmail message we know about.
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,        -- Gmail message id
  thread_id       TEXT NOT NULL,
  from_email      TEXT NOT NULL,
  from_domain     TEXT NOT NULL,           -- denormalized for fast group-by
  to_emails       TEXT,                    -- json array
  cc_emails       TEXT,                    -- json array
  subject         TEXT,
  snippet         TEXT,
  size_bytes      INTEGER,
  internal_date   INTEGER NOT NULL,        -- ms since epoch
  labels          TEXT NOT NULL,           -- json array of label ids
  has_list_unsub  INTEGER NOT NULL,        -- 0/1
  list_id         TEXT,
  is_unread       INTEGER NOT NULL,        -- 0/1
  category_id     TEXT,                    -- nullable, FK -> categories.id
  confidence      REAL,                    -- 1.0 deterministic, <1 LLM
  fetched_at      INTEGER NOT NULL,
  body_cached     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_messages_from_domain ON messages(from_domain);
CREATE INDEX idx_messages_category    ON messages(category_id);
CREATE INDEX idx_messages_date        ON messages(internal_date);
CREATE INDEX idx_messages_thread      ON messages(thread_id);

-- Aggregated stats per sender, rebuilt after each sync.
CREATE TABLE senders (
  email           TEXT PRIMARY KEY,
  domain          TEXT NOT NULL,
  display_name    TEXT,
  total_count     INTEGER NOT NULL,
  unread_count    INTEGER NOT NULL,
  replied_count   INTEGER NOT NULL,        -- threads where I sent a msg
  first_seen      INTEGER,
  last_seen       INTEGER,
  has_list_unsub  INTEGER NOT NULL
);

-- The category catalog (stable IDs, user-editable display names).
CREATE TABLE categories (
  id              TEXT PRIMARY KEY,        -- e.g. 'newsletters'
  display_name    TEXT NOT NULL,
  description     TEXT,
  priority        INTEGER NOT NULL,        -- rule cascade order
  default_action  TEXT NOT NULL,           -- 'trash' | 'archive' | 'label_then_trash'
  enabled         INTEGER NOT NULL DEFAULT 1
);

-- User-defined rules: allowlist + custom heuristics.
CREATE TABLE rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,           -- 'allow_sender' | 'allow_domain' | 'allow_keyword' | 'allow_label'
  pattern         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  note            TEXT
);

-- Every batch action, for undo + audit.
CREATE TABLE action_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  performed_at    INTEGER NOT NULL,
  category_id     TEXT,
  action          TEXT NOT NULL,           -- 'trash' | 'archive' | 'untrash' (undo)
  message_ids     TEXT NOT NULL,           -- json array of ids
  dry_run         INTEGER NOT NULL,
  undone          INTEGER NOT NULL DEFAULT 0,
  undone_at       INTEGER,
  notes           TEXT
);

-- Single-row table for sync cursor.
CREATE TABLE sync_state (
  account_email   TEXT PRIMARY KEY,
  last_history_id TEXT,
  last_full_sync  INTEGER,
  last_sync       INTEGER
);

-- Optional bodies cache (only when user opens a message).
CREATE TABLE bodies (
  message_id      TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  mime_type       TEXT,
  text_body       TEXT,
  html_body       TEXT,
  fetched_at      INTEGER NOT NULL
);
```

Migrations: `umzug` or hand-rolled with a `schema_version` PRAGMA. Bias
toward hand-rolled — fewer dependencies for a small schema.

---

## 6. UI / UX flow

### Screens

1. **First-run / onboarding**
   - "Connect Gmail" button → browser OAuth → "Syncing your mailbox…"
     progress with messages/sec, ETA, cancel button.

2. **Dashboard (post-sync)**
   - Header: total messages, last sync, "Sync now" button.
   - Grid of **category cards**, sorted by potential cleanup impact
     (size × count). Each card:
     - Category name, description.
     - Count of messages, total size, age range.
     - "Review" button.
     - Per-category default action chip (Trash / Archive).

3. **Category review (the main workspace)**
   - Two-pane: list on left (virtualized, paginated by sender, expandable),
     preview on right.
   - Bulk controls at top:
     - Search/filter within category.
     - "Select all visible" / "Select all in category".
     - "Exclude sender" → adds an allowlist rule.
   - Bottom action bar:
     - "Dry-run" → opens modal listing exactly what would happen, no API call.
     - "Move N to Trash" → confirmation modal showing count, size, and
       the first/last 5 subjects. Requires typing the count to confirm
       if > 1000 messages.

4. **Action log / Undo**
   - List of past batches with timestamp, category, count, status.
   - "Undo" per batch within 30 days → calls `users.messages.batchModify`
     to remove the `TRASH` label.
   - Filter to "show last 24h" prominently.

5. **Settings**
   - Thresholds (months for receipts, attachments, high-volume).
   - Allowlist: senders, domains, keywords, labels (e.g. `Family`).
   - LLM toggle + Ollama endpoint + model name + max-messages-per-run cap.
   - Category enable/disable + per-category default action.
   - Sign out / revoke access.

### Confirmation pattern (key safety surface)

Every destructive action goes through this modal:

```
┌─────────────────────────────────────────────────┐
│  Move 12,431 messages to Trash?                 │
│  ──────────────────────────────────────────────  │
│  Category:    Newsletters & marketing            │
│  Total size:  842 MB                             │
│  Date range:  2014-03 → 2024-11                  │
│                                                  │
│  Sample (5 oldest, 5 newest):                    │
│    • [2014-03-12] Medium Digest                  │
│    • [2014-04-01] Quora Weekly Digest            │
│    ... (3 more)                                  │
│    • [2024-11-02] Substack Reads                 │
│    ... (4 more)                                  │
│                                                  │
│  Excluded by your allowlist:                     │
│    • dad@example.com (47 msgs)                   │
│    • @mycompany.com (203 msgs)                   │
│                                                  │
│  [Type "12431" to confirm:  _____ ]              │
│                                                  │
│         [ Cancel ]   [ Move to Trash ]           │
└─────────────────────────────────────────────────┘
```

Threshold for the "type the number" gate: configurable, default 1000.

---

## 7. Safety & recovery design

| Layer                       | Mechanism                                                                       |
|-----------------------------|---------------------------------------------------------------------------------|
| Scope                       | Request only `gmail.modify` — Google API will *refuse* permanent delete         |
| Default action              | Move to Trash → Gmail keeps for 30 days, user can restore via Gmail UI          |
| Per-batch confirmation      | Modal with count, size, samples; numeric typed confirmation above 1000 msgs     |
| Allowlist (rule 0)          | Sender, domain, keyword, label. Always wins, shown explicitly in confirmation    |
| Reply-aware protection      | Any thread containing a message I sent is protected (queryable via `from:me`)    |
| Starred protection          | Messages with `STARRED` label always protected                                  |
| Dry-run                     | Lists everything that would be touched, writes a row to `action_log` with `dry_run=1` |
| Undo                        | `action_log` stores message_ids per batch; one click runs `batchModify` to remove `TRASH` |
| Atomic batch logging        | `action_log` row written *before* the mutation call; on partial failure we still know what was attempted |
| Local backup                | Before any batch, write the affected message metadata to `~/.gmail-cleanup/backups/<timestamp>.jsonl` |
| Rate-limit safety           | Hard cap of 50k mutations per session by default; configurable                  |
| Token revocation            | Settings → "Disconnect" calls Google revoke endpoint, clears keychain entry     |

---

## 8. Phased build plan

Each phase ≈ one weekend.

### Phase 1 — MVP: "Newsletters only, with undo"
- Electron + Vite + React skeleton, single window.
- OAuth desktop flow + keychain token storage.
- SQLite schema for `messages`, `sync_state`, `action_log`.
- Full-mailbox metadata sync with progress UI (no incremental yet).
- ONE hardcoded category: "Newsletters" (has List-Unsubscribe AND I never replied).
- Category card → review list (no preview pane yet) → confirmation → batch trash.
- Action log with undo.
- Dry-run mode.
**Exit criterion:** I can cleanly trash 10k newsletters and undo one batch.

### Phase 2 — Full category set + incremental sync
- All rules from §4 implemented and unit-tested.
- `senders` table + stats job.
- `historyId`-based incremental sync.
- Preview pane (renders cached snippet; fetches body on click).
- Allowlist UI + reply-aware / starred protection wired in.
- Settings screen with threshold config.
**Exit criterion:** Run end-to-end on the real mailbox; categories
look right; allowlist is honored.

### Phase 3 — Polish + safety hardening
- "Type the count" gate above 1000.
- Local JSONL backups before each batch.
- Per-batch progress UI with cancel.
- Action log filters, search.
- electron-builder packaging → NSIS installer + portable .exe.
- Vitest unit coverage for rules; Playwright smoke test for the
  confirmation modal.
**Exit criterion:** I'd let a non-technical friend use this without
fearing data loss.

### Phase 4 — Optional LLM classifier (local Ollama)
- HTTP integration with a local Ollama server, opt-in toggle.
- Configurable endpoint + model + per-run cap in Settings.
- Test-connection button calling `/api/tags`.
- One request per message with `format: "json"`, temperature 0.
- Surface LLM-suggested category with rationale in the UI.
**Exit criterion:** LLM pass over previously-uncategorized messages
yields a non-trivial extra batch I'd actually delete — at $0 cost.

### Phase 5 — Nice-to-haves (not scoped to a weekend each)
- Unsubscribe assistant: parse List-Unsubscribe and offer one-click
  unsubscribe before trashing.
- Sender rules: "always trash from this domain on sync".
- Saved searches.
- Per-thread (not per-message) actions.
- Stats page: "you've cleaned 240k messages, reclaimed 18 GB".

---

## 9. Open questions and risks

### Open questions
1. **Aliases**: do you use `+suffix` Gmail aliases or multiple "Send mail
   as" identities? Reply detection needs to know all of yours.
2. **Workspace vs consumer Gmail**: scopes and verification rules
   differ. Assumption: consumer `@gmail.com`. Confirm.
3. **"Threads I've replied to" granularity**: protect the *thread* or
   only the specific reply message? Plan assumes whole thread.
4. **Calendar invites**: keep accepted-event invites for travel
   records, or trash all past-date invites? Plan trashes all past-date.
5. **Backup retention**: how long to keep local JSONL backups before
   pruning? Plan: 90 days, configurable.
6. **Allowlist seed**: should v1 pre-seed with common bank/government
   domain heuristics, or start empty? Plan: empty, with a "Suggest
   senders to allowlist" helper that surfaces senders you've replied to.

### Risks
| Risk                                                                | Mitigation                                                            |
|---------------------------------------------------------------------|-----------------------------------------------------------------------|
| OAuth client_secret embedded in app → can be extracted              | Document the trust model; single-user; rotate if leaked publicly      |
| Initial sync rate-limited or interrupted                            | Resumable paging, exponential backoff, persist cursor to `sync_state` |
| `historyId` too old after long absence                              | Fall back to date-bounded `messages.list` with `internalDate >`       |
| Misclassification trashes something important                       | Allowlist + Trash-not-delete + 30-day Gmail recovery + local backups  |
| keytar prebuilt binary missing for Electron version                 | Document `npm rebuild keytar --runtime=electron --target=<ver>`; uses Windows Credential Manager natively |
| Windows code-signing required to avoid SmartScreen warning          | Ship unsigned for personal use; document "More info → Run anyway"     |
| `better-sqlite3` native build fails on Windows without build tools  | Document "node-gyp" / Windows Build Tools install in README           |
| Local Ollama server not running when LLM pass is invoked            | "Test connection" button in Settings; clear error surfaced in UI       |
| Small local models hallucinate category labels                      | Validate response against fixed category-id allowlist; invalid → skip  |
| User accidentally trashes 100k messages and panics                  | "Undo last batch" is the prominent header action for 24h after a batch |

---

## 10. Verification plan

Before declaring each phase complete:

1. **Unit tests (Vitest)**: every rule in §4 has happy-path + edge-case
   tests with fixture messages. Allowlist precedence test. Conflict
   resolution test.
2. **DB tests**: in-memory SQLite, run migrations, assert schema.
3. **Sync test**: mock `googleapis` client; assert historyId is
   advanced, batchModify is called with correct chunking.
4. **Manual e2e on a test Gmail account**:
   - Seed account with ~500 mixed messages (script using the same SDK).
   - Run full sync → verify category counts.
   - Dry-run a batch → verify nothing changes server-side.
   - Real batch → verify messages appear in Trash in Gmail web UI.
   - Undo → verify messages return to inbox/All Mail.
5. **Manual e2e on the real mailbox (Phase 2+)**: start with the
   smallest category, watch the action log, restore one batch, then
   proceed.
6. **Playwright (Phase 3)**: scripted click-through of the
   confirmation modal including the typed-count gate.

---

## 11. Critical files (to be created)

```
gmail_cleanup/
├── PLAN.md                          (this file)
├── package.json
├── electron-builder.yml
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── main/                        Electron main process
│   │   ├── index.ts
│   │   ├── auth/oauth.ts            Google OAuth + keytar
│   │   ├── sync/gmail-client.ts     googleapis wrapper, retries, batching
│   │   ├── sync/incremental.ts      historyId-based sync
│   │   ├── sync/backfill.ts         Initial full sync
│   │   ├── db/schema.sql
│   │   ├── db/index.ts              better-sqlite3 connection, migrations
│   │   ├── db/queries.ts
│   │   ├── categorizer/rules.ts     All §4 rules
│   │   ├── categorizer/engine.ts    Cascade runner
│   │   ├── categorizer/llm.ts       Local Ollama HTTP optional path
│   │   ├── actions/executor.ts      batchModify, action_log writes
│   │   ├── actions/undo.ts
│   │   ├── ipc/handlers.ts          IPC contract for renderer
│   │   └── backup/jsonl.ts          Local backups before mutations
│   ├── renderer/                    React app
│   │   ├── App.tsx
│   │   ├── pages/Dashboard.tsx
│   │   ├── pages/CategoryReview.tsx
│   │   ├── pages/ActionLog.tsx
│   │   ├── pages/Settings.tsx
│   │   ├── components/ConfirmModal.tsx
│   │   ├── components/MessageList.tsx
│   │   └── hooks/useIpc.ts
│   └── shared/
│       ├── types.ts                 IPC + DB row types
│       └── categories.ts            Category catalog
└── tests/
    ├── rules.test.ts
    ├── engine.test.ts
    └── e2e/confirm.spec.ts
```
