import { useState } from "react";
import type { BatchPreview } from "@shared/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

interface Props {
  preview: BatchPreview;
  action: "trash" | "archive";
  confirmThreshold: number;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export default function ConfirmModal({
  preview,
  action,
  confirmThreshold,
  onConfirm,
  onCancel,
  loading = false,
}: Props) {
  const [typed, setTyped] = useState("");
  const needsTyped = preview.message_count >= confirmThreshold;
  const canConfirm =
    !loading && (!needsTyped || typed.trim() === preview.message_count.toString());

  const verb = action === "trash" ? "Move to Trash" : "Archive";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg mx-4">
        <div className="p-6">
          <h2 className="text-lg font-bold text-white mb-1">
            {verb} {preview.message_count.toLocaleString()} messages?
          </h2>
          <p className="text-sm text-gray-400 mb-4">
            {action === "trash"
              ? "Messages will be moved to Gmail Trash and recoverable for 30 days."
              : "Messages will be archived (removed from Inbox, kept in All Mail)."}
          </p>

          <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
            <InfoRow label="Total size" value={formatBytes(preview.total_size_bytes)} />
            <InfoRow label="Date range" value={`${formatDate(preview.oldest_date)} → ${formatDate(preview.newest_date)}`} />
            {preview.excluded_count > 0 && (
              <InfoRow
                label="Excluded (protected)"
                value={`${preview.excluded_count.toLocaleString()} messages`}
                className="text-green-400"
              />
            )}
          </div>

          {preview.sample_subjects.length > 0 && (
            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-1.5">Sample subjects:</div>
              <ul className="space-y-1">
                {preview.sample_subjects.slice(0, 10).map((s, i) => (
                  <li
                    key={i}
                    className="text-xs text-gray-400 truncate bg-gray-800 px-2 py-1 rounded"
                  >
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {needsTyped && (
            <div className="mb-4">
              <label className="text-xs text-gray-400 block mb-1">
                Type <span className="font-mono text-yellow-400">{preview.message_count}</span> to confirm:
              </label>
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={preview.message_count.toString()}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                autoFocus
              />
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={onCancel}
              disabled={loading}
              className="flex-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-sm font-medium py-2 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={!canConfirm}
              className="flex-1 bg-red-700 hover:bg-red-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium py-2 rounded-lg transition-colors"
            >
              {loading ? "Working…" : verb}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-sm font-medium ${className ?? "text-gray-200"}`}>{value}</div>
    </div>
  );
}
