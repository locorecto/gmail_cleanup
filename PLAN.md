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

See full architecture in the original plan document.

## 8. Phased build plan

### Phase 1 — MVP (COMPLETE)
- Electron + Vite + React skeleton, single window.
- OAuth desktop flow + keychain token storage.
- SQLite schema for `messages`, `sync_state`, `action_log`.
- Full-mailbox metadata sync with progress UI.
- All 10 categorization rules implemented and tested.
- Category card → review list → confirmation → batch trash.
- Action log with undo.
- Dry-run mode.
- Local JSONL backups before each mutation.
- Session mutation cap.
- Typed-confirmation gate above threshold.

### Phase 2 — Next
- Preview pane (renders cached snippet; fetches body on click).
- Per-batch progress UI with cancel.
- electron-builder packaging → AppImage + .deb.
- Playwright smoke test for the confirmation modal.

### Phase 4 — Optional LLM classifier
- Anthropic SDK integration, opt-in toggle, API key in keychain.
- Batched calls with structured output + prompt caching.
