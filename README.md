# Gmail Cleanup

A single-user Windows desktop app (Electron) that batch-cleans your Gmail
inbox safely. Trash-only (30-day Gmail recovery), per-batch confirmation,
allowlist, dry-run, undo. Metadata cached locally in SQLite.

See [`PLAN.md`](./PLAN.md) for the full design.

---

## Requirements (Windows)

- **Windows 10 or 11**, 64-bit
- **Node.js 20 LTS or newer** — install from <https://nodejs.org/>. Make sure
  to check **"Automatically install the necessary tools..."** during the
  Node installer (this installs Python + Visual Studio Build Tools, needed
  for native modules like `better-sqlite3` and `keytar`).
  - If you skipped that step, run from an **Administrator PowerShell**:
    ```powershell
    npm install --global windows-build-tools
    ```
    (or install "Desktop development with C++" workload via the Visual
    Studio Installer).
- **Git for Windows** — <https://git-scm.com/download/win>
- A **Google Cloud OAuth Desktop client** (free, takes ~5 min — see below).

---

## One-time Google Cloud setup

This app is unverified (single-user), so you provide your own OAuth client.

1. Go to <https://console.cloud.google.com/> and create a new project
   (e.g. "Gmail Cleanup Personal").
2. Enable the **Gmail API**: APIs & Services → Library → search "Gmail API"
   → Enable.
3. Configure the **OAuth consent screen**: User type = External; App name
   = anything; add your own Gmail address as a **Test user**. Scopes
   needed: `https://www.googleapis.com/auth/gmail.modify`.
4. Create credentials: APIs & Services → Credentials → Create credentials
   → **OAuth client ID** → Application type = **Desktop app**.
5. Copy the **Client ID** and **Client secret** — you'll set them as
   environment variables below.

---

## Install & run (dev)

Open PowerShell:

```powershell
git clone https://github.com/locorecto/gmail_cleanup.git
cd gmail_cleanup
git checkout claude/plan-gmail-cleanup-app-5M8w1

npm install

# Set OAuth credentials for this session:
$env:GMAIL_CLIENT_ID    = "xxx.apps.googleusercontent.com"
$env:GMAIL_CLIENT_SECRET = "GOCSPX-xxxxxxxx"

# Run in dev mode (Vite + Electron):
npm run dev
```

To persist the env vars across sessions, run once (PowerShell, as your user):

```powershell
[Environment]::SetEnvironmentVariable("GMAIL_CLIENT_ID","xxx.apps.googleusercontent.com","User")
[Environment]::SetEnvironmentVariable("GMAIL_CLIENT_SECRET","GOCSPX-xxxxxxxx","User")
```

Then restart your terminal.

---

## Tests

```powershell
npm test
```

In-memory SQLite — no Gmail access required.

---

## Build a Windows installer

```powershell
npm run dist
```

Output goes to `dist/`:

- `Gmail Cleanup Setup <version>.exe` — NSIS installer
- `Gmail Cleanup <version>.exe` — portable single-file build

The installer is **unsigned**. Windows SmartScreen will warn on first
launch — click "More info" → "Run anyway".

---

## Optional: local LLM classifier (Ollama)

For messages that no rule matched, the app can ask a **local** LLM via
[Ollama](https://ollama.com) to pick a category. Everything runs on your
machine — no API keys, no cost, no data leaves your computer.

1. Install Ollama for Windows from <https://ollama.com/download>.
2. Open PowerShell and pull a small model:
   ```powershell
   ollama pull llama3.2:3b
   ```
   (Larger models like `qwen2.5:7b` or `llama3.1:8b` classify better but
   are slower. Pick whatever fits your hardware.)
3. Start the Ollama server (it auto-starts after install, or run
   `ollama serve`).
4. In the app: **Settings → Local LLM classifier** → enable, set the
   model name (e.g. `llama3.2:3b`), click **Test connection**.
5. Click **Run on uncategorized**. The app sends one message at a time
   (sender, subject, ~240-char snippet, age, flags — **never** the full
   body) and stores the returned category. Bounded by the
   "Max messages per run" cap.

Endpoint defaults to `http://127.0.0.1:11434`. Change it if Ollama is
running on a different port or remote machine.

---

## Where data lives

| What | Path |
|---|---|
| SQLite cache | `%APPDATA%\gmail-cleanup\gmail-cleanup.db` |
| Local JSONL backups (before each batch) | `%APPDATA%\gmail-cleanup\backups\` |
| OAuth refresh token | Windows Credential Manager (service: `gmail-cleanup`) |

To fully reset: uninstall the app, then delete `%APPDATA%\gmail-cleanup`
and remove the `gmail-cleanup` entry from Windows Credential Manager
(Control Panel → User Accounts → Credential Manager → Windows Credentials).

---

## Safety model

- Only requests `gmail.modify` scope — **Google's API refuses permanent
  delete with this scope**. Everything goes to Trash (30-day recovery).
- Every batch requires per-batch confirmation; batches ≥ 1000 messages
  require typing the count.
- Allowlist (senders/domains/keywords/labels) is never touched. Starred
  and IMPORTANT messages, and any thread you've replied to, are also
  protected.
- Action log + undo: any batch can be untrashed within 30 days.
- Local JSONL backup of message metadata is written before any mutation.

---

## Troubleshooting

**`better-sqlite3` or `keytar` install fails** — you're missing C++ build
tools. Install Visual Studio Build Tools (Desktop C++ workload) and
re-run `npm install`. If only the Electron load fails:

```powershell
npx electron-rebuild
```

**OAuth browser doesn't return to the app** — make sure no other process
is binding the ephemeral port. The app uses `http://127.0.0.1:<random>/`
as the redirect URI; if your firewall blocks loopback HTTP, allow Node /
Electron through Windows Defender Firewall.
