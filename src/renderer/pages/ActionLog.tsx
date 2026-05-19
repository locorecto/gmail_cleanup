import { useState, useEffect, useCallback } from "react";
import type { ActionLogEntry } from "@shared/types";
import { useInvoke } from "../hooks/useIpc";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

const PAGE_SIZE = 50;

export default function ActionLog({ onBack }: { onBack: () => void }) {
  const invoke = useInvoke();
  const [entries, setEntries] = useState<ActionLogEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [undoing, setUndoing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const rows = await invoke<ActionLogEntry[]>("actionlog:list", { limit: PAGE_SIZE, offset });
    setEntries(rows);
    setLoading(false);
  }, [invoke, offset]);

  useEffect(() => {
    load();
  }, [load]);

  async function undoEntry(id: number) {
    setUndoing(id);
    setError(null);
    try {
      const result = await invoke<{ restored: number }>("batch:undo", { log_id: id });
      setSuccess(`Restored ${result.restored.toLocaleString()} messages from Trash`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setUndoing(null);
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="text-gray-400 hover:text-white text-sm">
          ← Back
        </button>
        <h1 className="text-xl font-bold text-white">Action Log</h1>
      </div>

      {success && (
        <div className="mb-4 bg-green-900/30 border border-green-800 rounded-lg px-4 py-3 text-green-400 text-sm flex justify-between">
          <span>{success}</span>
          <button onClick={() => setSuccess(null)} className="ml-4 hover:text-green-200">×</button>
        </div>
      )}
      {error && (
        <div className="mb-4 bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-4 hover:text-red-200">×</button>
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm text-center py-8">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="text-gray-500 text-sm text-center py-8">
          No actions recorded yet. Actions you take will appear here.
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
          {entries.map((entry) => (
            <div key={entry.id} className="px-4 py-3 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-white">
                    #{entry.id} — {entry.message_count.toLocaleString()} messages
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      entry.dry_run
                        ? "bg-gray-800 text-gray-400"
                        : entry.action === "trash"
                          ? "bg-red-900/40 text-red-400"
                          : entry.action === "untrash"
                            ? "bg-green-900/40 text-green-400"
                            : "bg-yellow-900/40 text-yellow-400"
                    }`}
                  >
                    {entry.dry_run ? "dry-run" : entry.action}
                  </span>
                  {entry.undone && (
                    <span className="text-xs text-gray-500 italic">undone</span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {entry.category_name ?? entry.category_id ?? "—"} · {formatDate(entry.performed_at)}
                </div>
              </div>

              {!entry.dry_run && !entry.undone && entry.action === "trash" && (
                <button
                  onClick={() => undoEntry(entry.id)}
                  disabled={undoing === entry.id}
                  className="shrink-0 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 border border-blue-800 px-3 py-1.5 rounded transition-colors"
                >
                  {undoing === entry.id ? "Undoing…" : "Undo"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4 mt-4 text-sm text-gray-400">
        <button
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          disabled={offset === 0}
          className="disabled:opacity-30 hover:text-white"
        >
          ← Prev
        </button>
        <button
          onClick={() => setOffset(offset + PAGE_SIZE)}
          disabled={entries.length < PAGE_SIZE}
          className="disabled:opacity-30 hover:text-white"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
