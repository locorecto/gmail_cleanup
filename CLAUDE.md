# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Single-user Electron desktop app (Windows-only target) that batch-cleans a Gmail mailbox.
Rule-based categorizer + optional local Ollama LLM for ambiguous messages. Trash-only
(uses `gmail.modify` scope — permanent delete is impossible by design). See `PLAN.md` for the
full design rationale and `README.md` for end-user setup.

## Commands

```bash
npm run dev           # Vite (port 5173) + Electron concurrently
npm test              # vitest run (in-memory SQLite, no Gmail access)
npm run test:watch    # vitest watch mode
npx vitest run tests/rules.test.ts -t "ruleReceipts"   # single test
npm run build         # build:vite + build:electron (tsc -p tsconfig.electron.json)
npm run dist          # electron-builder → NSIS installer + portable .exe in dist/
npm run lint          # biome check src
```

Required env vars for `npm run dev` (OAuth Desktop client from Google Cloud):
`GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` — see `src/main/auth/oauth.ts:12`.
Note: `README.md` currently says `GOOGLE_*` — the code reads `GMAIL_*`.

Typecheck both halves separately — they have different tsconfigs:
`npx tsc -p tsconfig.electron.json --noEmit` (main process, CommonJS, node types)
`npx tsc -p tsconfig.json --noEmit` (renderer, ESM, dom types, `@shared` alias)

## Architecture

Two-process Electron app communicating over IPC. **Never put Gmail/SQLite/keytar code in
the renderer** — those are main-process only.

```
src/main/      Electron main process (Node)         src/renderer/   React + Vite
  index.ts          app boot, BrowserWindow, IPC      App.tsx           page router
  preload.ts        contextBridge: ipc.invoke/on        pages/            Dashboard, CategoryReview,
  auth/oauth.ts     OAuth flow + keytar storage                            ActionLog, Settings
  sync/             gmail-client + backfill +          components/       ConfirmModal, MessageList
                    incremental historyId sync         hooks/useIpc.ts   typed wrapper over window.ipc
  db/               better-sqlite3, schema.sql,
                    queries, settings, senders       src/shared/       DB row types + IPC channel map
  categorizer/      rules.ts, engine.ts, llm.ts      tests/            vitest (rules, engine)
  actions/          executor (trash/archive/undo)
  backup/jsonl.ts   pre-mutation backup write
  ipc/handlers.ts   single registration point for all ipcMain.handle
```

The IPC contract is the **type-level source of truth**: `IpcChannels` in
`src/shared/types.ts` enumerates every channel with args + result types. When adding a new
IPC: extend `IpcChannels`, add an `ipcMain.handle` in `src/main/ipc/handlers.ts`, and the
renderer picks it up automatically via `useInvoke<TResult>(channel, args)`.

### Categorization cascade — the core domain logic

`src/main/categorizer/rules.ts` exports `ALL_RULES: Rule[]` ordered most-specific to
least-specific. `runCategorizer` in `engine.ts` iterates messages in 5000-row chunks and
applies rules **top-down, first non-null wins**. Each rule is a pure function
`(msg, sender, settings, now) => CategoryMatch | null` — fully unit-testable, no DB access
inside rules.

Rule 0 is `ruleProtected` (allowlist, STARRED, IMPORTANT, replied-to threads). It returns
`category_id: "protected"` and the engine treats that as "skip this message entirely" —
**protected messages must never appear in any category for deletion**. Any new safety
check goes into `ruleProtected`.

Category ids live in `src/shared/categories.ts` (`BUILT_IN_CATEGORIES`) along with the
domain sets (`SOCIAL_DOMAINS`, `RECEIPT_DOMAINS`, etc.) and subject regex lists. Both
processes import from here — keep it dependency-free.

### Local LLM (optional)

`src/main/categorizer/llm.ts` calls Ollama's `/api/chat` with `format: "json"` over plain
`fetch` — no Anthropic/cloud SDK. Sends one message per request: sender, subject,
240-char snippet, age, flags. **Never the full body.** Response is validated against
`VALID_CATEGORY_IDS` (the built-in id allowlist) before write — a hallucinated label is
dropped silently. LLM-assigned rows are stored at `confidence ≤ 0.95` to remain
distinguishable from rule-assigned rows (`confidence = 1.0`).

### Data flow

1. `auth:connect` runs the OAuth dance, persists refresh token via `keytar` (Windows
   Credential Manager), stores the current account email under `service=gmail-cleanup`,
   `account=current-account`.
2. `sync:start` chooses incremental (if `last_history_id` exists) or full backfill.
   Backfill pages `messages.list` then batches `messages.get(format=METADATA)`. After
   upsert, `rebuildSenders` recomputes the `senders` table, then `runCategorizer`
   assigns `category_id` per message.
3. `categories:list` returns aggregates from a `categories LEFT JOIN messages` group-by.
4. `batch:execute` writes `action_log` first, then a JSONL backup under
   `app.getPath("userData")/backups/`, then calls `batchModify` in 500-id chunks.
5. `batch:undo` reads the stored ids and removes the `TRASH` label.

## Hard safety invariants — preserve when editing

- **`gmail.modify` scope only.** Don't add `mail.google.com` or any scope that permits
  permanent delete. The whole safety model rests on the Trash being recoverable.
- **`ruleProtected` runs first and is final.** Don't reorder `ALL_RULES`. Don't add a
  rule that bypasses the protected check.
- **`action_log` row is written before the mutation call**, even on `dry_run`. The
  JSONL backup is written before the mutation too. If a partial failure happens, we
  need to know what was attempted.
- **`session_mutation_cap` is enforced in `executor.ts`** for non-dry-run batches.
  Don't bypass it; raise the cap in Settings if needed.
- **`confirm_threshold` typed-count gate** is enforced in `ConfirmModal.tsx`. The
  number-typing UX is the last line of defense before a >1000-message destructive op.
- LLM payloads carry sender/subject/snippet only — **never full bodies**. The `bodies`
  table is for the preview pane only, fetched on user click.

## Schema and migrations

`src/main/db/schema.sql` is hand-rolled and idempotent (`CREATE TABLE IF NOT EXISTS`).
`migrate()` in `src/main/db/index.ts` runs on every `getDb()` and uses a `schema_version`
table to seed `BUILT_IN_CATEGORIES` and default settings exactly once. Schema changes
require bumping `SCHEMA_VERSION` and adding the upgrade branch.

Settings are stored as `(key, value)` rows where `value` is a JSON string. `getSettings`
parses every row through `JSON.parse`; **all new settings must be added to the
`AppSettings` type in `src/shared/types.ts` AND to the `defaults` object in `migrate()`**,
or `getSettings` will return `undefined` for that field.

## Test conventions

`tests/` uses vitest with in-memory SQLite (`new Database(":memory:")`). `engine.test.ts`
exercises the full DB→categorizer pipeline; `rules.test.ts` calls each rule directly with
synthetic `DbMessage` and `SenderStats` fixtures. When adding a rule, add both: a unit
test in `rules.test.ts` (happy path + the most likely false-positive case) and an
integration test in `engine.test.ts` if it interacts with sender stats or DB rules.

## Workflow

All work pushes to `claude/plan-gmail-cleanup-app-5M8w1` on `locorecto/gmail_cleanup`.
Don't push to other branches or open a PR without explicit ask.
