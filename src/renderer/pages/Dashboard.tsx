import { useState, useEffect, useCallback } from "react";
import type { CategorySummary, ConnectedAccount, SyncProgress } from "@shared/types";
import { useInvoke, useSyncProgress } from "../hooks/useIpc";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString();
}

function formatRelative(ms: number | null): string {
  if (!ms) return "Never";
  const ago = Date.now() - ms;
  if (ago < 60000) return "Just now";
  if (ago < 3600000) return `${Math.floor(ago / 60000)}m ago`;
  if (ago < 86400000) return `${Math.floor(ago / 3600000)}h ago`;
  return `${Math.floor(ago / 86400000)}d ago`;
}

export default function Dashboard({
  account,
  onOpenCategory,
  onSynced,
}: {
  account: ConnectedAccount;
  onOpenCategory: (id: string) => void;
  onSynced: (acct: ConnectedAccount) => void;
}) {
  const invoke = useInvoke();
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCategories = useCallback(async () => {
    const cats = await invoke<CategorySummary[]>("categories:list");
    setCategories(cats);
  }, [invoke]);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useSyncProgress(
    useCallback((p: SyncProgress) => {
      setProgress(p);
      if (p.phase === "done" || p.phase === "error") {
        setSyncing(false);
        loadCategories();
      }
    }, [loadCategories])
  );

  async function startSync() {
    setSyncing(true);
    setError(null);
    setProgress({ phase: "listing", total: 0, done: 0, message: "Starting…" });
    try {
      await invoke("sync:start");
    } catch (e) {
      setError(String(e));
      setSyncing(false);
    }
  }

  const totalMessages = categories.reduce((s, c) => s + c.message_count, 0);
  const totalSize = categories.reduce((s, c) => s + c.total_size_bytes, 0);

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Last sync: {formatRelative(account.last_sync)}
          </p>
        </div>
        <button
          onClick={startSync}
          disabled={syncing}
          className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
        >
          {syncing ? "Syncing…" : account.last_sync ? "Sync Now" : "Start Full Sync"}
        </button>
      </div>

      {syncing && progress && (
        <div className="mb-6 bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="flex justify-between text-sm text-gray-400 mb-2">
            <span>{progress.message ?? progress.phase}</span>
            <span>
              {progress.total > 0
                ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
                : progress.done > 0
                  ? `${progress.done.toLocaleString()} messages…`
                  : "…"}
            </span>
          </div>
          {progress.total > 0 && (
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mb-6 bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      {categories.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Stat label="Categorized messages" value={totalMessages.toLocaleString()} />
          <Stat label="Reclaimable space" value={formatBytes(totalSize)} />
          <Stat label="Categories" value={categories.length.toString()} />
        </div>
      )}

      {categories.length === 0 && !syncing ? (
        <div className="text-center py-16 text-gray-500 text-sm">
          {account.last_sync
            ? "No categorized messages found. Run a sync to detect new emails."
            : 'Click "Start Full Sync" to scan your mailbox and detect categories.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {categories.map((cat) => (
            <CategoryCard key={cat.id} cat={cat} onReview={() => onOpenCategory(cat.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-gray-400 mt-1">{label}</div>
    </div>
  );
}

function CategoryCard({
  cat,
  onReview,
}: {
  cat: CategorySummary;
  onReview: () => void;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium text-white text-sm">{cat.display_name}</div>
          {cat.description && (
            <div className="text-xs text-gray-500 mt-0.5">{cat.description}</div>
          )}
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
            cat.default_action === "trash"
              ? "bg-red-900/40 text-red-400"
              : "bg-yellow-900/40 text-yellow-400"
          }`}
        >
          {cat.default_action}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-gray-400">
        <span>{cat.message_count.toLocaleString()} messages</span>
        <span>{formatBytes(cat.total_size_bytes)}</span>
        <span>Oldest: {formatDate(cat.oldest_date)}</span>
        <span>Newest: {formatDate(cat.newest_date)}</span>
      </div>

      <button
        onClick={onReview}
        className="mt-auto bg-gray-800 hover:bg-gray-700 text-white text-sm py-1.5 px-3 rounded transition-colors"
      >
        Review
      </button>
    </div>
  );
}
