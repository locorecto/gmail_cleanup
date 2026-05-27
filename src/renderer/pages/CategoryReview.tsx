import { useState, useEffect, useCallback } from "react";
import type { MessageRow, BatchPreview, CategorySummary, AppSettings } from "@shared/types";
import { useInvoke } from "../hooks/useIpc";
import ConfirmModal from "../components/ConfirmModal";

function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

const PAGE_SIZE = 100;

export default function CategoryReview({
  categoryId,
  onBack,
}: {
  categoryId: string;
  onBack: () => void;
}) {
  const invoke = useInvoke();
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [categoryInfo, setCategoryInfo] = useState<CategorySummary | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    invoke<AppSettings>("settings:get").then(setSettings);
    invoke<CategorySummary[]>("categories:list").then((cats) => {
      const cat = cats.find((c) => c.id === categoryId);
      if (cat) setCategoryInfo(cat);
    });
  }, [invoke, categoryId]);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    const result = await invoke<{ rows: MessageRow[]; total: number }>(
      "messages:list",
      { category_id: categoryId, offset, limit: PAGE_SIZE }
    );
    setMessages(result.rows);
    setTotal(result.total);
    setLoading(false);
  }, [invoke, categoryId, offset]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(messages.map((m) => m.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function openDryRun() {
    const ids = selectedIds.size > 0 ? [...selectedIds] : undefined;
    const p = await invoke<BatchPreview>("batch:preview", { category_id: categoryId, message_ids: ids });
    setPreview(p);
    // Execute as dry run without showing confirm
    const result = await invoke<{ log_id: number; affected: number }>("batch:execute", {
      category_id: categoryId,
      message_ids: ids,
      action: categoryInfo?.default_action ?? "trash",
      dry_run: true,
    });
    setSuccess(`Dry-run: would move ${result.affected.toLocaleString()} messages to ${categoryInfo?.default_action ?? "trash"} (nothing changed)`);
  }

  async function openConfirm() {
    const ids = selectedIds.size > 0 ? [...selectedIds] : undefined;
    const p = await invoke<BatchPreview>("batch:preview", { category_id: categoryId, message_ids: ids });
    setPreview(p);
    setShowConfirm(true);
  }

  async function executeAction() {
    if (!preview) return;
    setActionLoading(true);
    setError(null);
    try {
      const ids = selectedIds.size > 0 ? [...selectedIds] : undefined;
      const result = await invoke<{ log_id: number; affected: number }>("batch:execute", {
        category_id: categoryId,
        message_ids: ids,
        action: categoryInfo?.default_action ?? "trash",
        dry_run: false,
      });
      setShowConfirm(false);
      setSuccess(`Moved ${result.affected.toLocaleString()} messages to ${categoryInfo?.default_action ?? "trash"} (log #${result.log_id})`);
      setSelectedIds(new Set());
      await loadMessages();
    } catch (e) {
      setError(String(e));
    } finally {
      setActionLoading(false);
    }
  }

  const action = categoryInfo?.default_action ?? "trash";
  const operationIds = selectedIds.size > 0 ? [...selectedIds] : null;
  const operationCount = operationIds ? operationIds.length : total;

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <button
          onClick={onBack}
          className="text-gray-400 hover:text-white transition-colors text-sm"
        >
          ← Back
        </button>
        <h1 className="text-xl font-bold text-white">
          {categoryInfo?.display_name ?? categoryId}
        </h1>
      </div>
      {categoryInfo?.description && (
        <p className="text-sm text-gray-500 mb-4">{categoryInfo.description}</p>
      )}

      {/* Feedback banners */}
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

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className="text-sm text-gray-400">
          {total.toLocaleString()} messages
          {selectedIds.size > 0 && ` · ${selectedIds.size} selected`}
        </span>
        <div className="flex gap-2 ml-auto">
          {selectedIds.size > 0 ? (
            <button onClick={clearSelection} className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded border border-gray-700 transition-colors">
              Clear selection
            </button>
          ) : (
            <button onClick={selectAll} className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded border border-gray-700 transition-colors">
              Select all visible
            </button>
          )}
          <button
            onClick={openDryRun}
            className="text-xs text-gray-300 hover:text-white px-3 py-1.5 rounded border border-gray-700 transition-colors"
          >
            Dry-run
          </button>
          <button
            onClick={openConfirm}
            disabled={total === 0}
            className="text-xs bg-red-700 hover:bg-red-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded transition-colors font-medium"
          >
            {action === "trash" ? "Move" : "Archive"} {operationCount.toLocaleString()} to {action}
          </button>
        </div>
      </div>

      {/* Message list */}
      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading…</div>
      ) : messages.length === 0 ? (
        <div className="text-gray-500 text-sm py-8 text-center">No messages in this category.</div>
      ) : (
        <>
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden divide-y divide-gray-800">
            {messages.map((msg) => (
              <MessageRow
                key={msg.id}
                msg={msg}
                selected={selectedIds.has(msg.id)}
                onToggle={() => toggleSelect(msg.id)}
              />
            ))}
          </div>

          {/* Pagination */}
          <div className="flex items-center gap-4 mt-4 text-sm text-gray-400">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="disabled:opacity-30 hover:text-white transition-colors"
            >
              ← Prev
            </button>
            <span>
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
            </span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="disabled:opacity-30 hover:text-white transition-colors"
            >
              Next →
            </button>
          </div>
        </>
      )}

      {/* Confirm modal */}
      {showConfirm && preview && settings && (
        <ConfirmModal
          preview={preview}
          action={action}
          confirmThreshold={settings.confirm_threshold}
          onConfirm={executeAction}
          onCancel={() => setShowConfirm(false)}
          loading={actionLoading}
        />
      )}
    </div>
  );
}

function MessageRow({
  msg,
  selected,
  onToggle,
}: {
  msg: MessageRow;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${
        selected ? "bg-blue-900/30" : "hover:bg-gray-800"
      }`}
    >
      <div className="mt-0.5 w-4 h-4 rounded border border-gray-600 flex items-center justify-center shrink-0">
        {selected && <div className="w-2 h-2 rounded-sm bg-blue-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm truncate ${msg.is_unread ? "font-medium text-white" : "text-gray-300"}`}>
            {msg.subject ?? "(no subject)"}
          </span>
          {msg.is_unread && (
            <span className="shrink-0 text-xs bg-blue-700 text-blue-200 px-1.5 py-0.5 rounded">new</span>
          )}
        </div>
        <div className="text-xs text-gray-500 mt-0.5 flex gap-3">
          <span className="truncate">{msg.from_email}</span>
          <span className="shrink-0">{formatDate(msg.internal_date)}</span>
          {msg.size_bytes && <span className="shrink-0">{formatBytes(msg.size_bytes)}</span>}
        </div>
        {msg.snippet && (
          <div className="text-xs text-gray-600 mt-0.5 truncate">{msg.snippet}</div>
        )}
      </div>
    </div>
  );
}
