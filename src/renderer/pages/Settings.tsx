import { useState, useEffect } from "react";
import type { AppSettings, DbRule } from "@shared/types";
import { useInvoke } from "../hooks/useIpc";

export default function Settings({ onBack }: { onBack: () => void }) {
  const invoke = useInvoke();
  const [settings, setSettingsState] = useState<AppSettings | null>(null);
  const [rules, setRules] = useState<DbRule[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newRule, setNewRule] = useState<{ kind: DbRule["kind"]; pattern: string; note: string }>({
    kind: "allow_sender",
    pattern: "",
    note: "",
  });

  useEffect(() => {
    invoke<AppSettings>("settings:get").then(setSettingsState);
    invoke<DbRule[]>("rules:list").then(setRules);
  }, [invoke]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    const updated = await invoke<AppSettings>("settings:set", settings);
    setSettingsState(updated);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function addRule() {
    if (!newRule.pattern.trim()) return;
    const rule = await invoke<DbRule>("rules:add", {
      kind: newRule.kind,
      pattern: newRule.pattern.trim(),
      note: newRule.note.trim() || undefined,
    });
    setRules((prev) => [...prev, rule]);
    setNewRule({ kind: "allow_sender", pattern: "", note: "" });
  }

  async function deleteRule(id: number) {
    await invoke("rules:delete", { id });
    setRules((prev) => prev.filter((r) => r.id !== id));
  }

  if (!settings) return <div className="p-6 text-gray-500 text-sm">Loading…</div>;

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="text-gray-400 hover:text-white text-sm">
          ← Back
        </button>
        <h1 className="text-xl font-bold text-white">Settings</h1>
      </div>

      {/* Thresholds */}
      <Section title="Category thresholds">
        <NumberField
          label="Receipts older than (months)"
          value={settings.receipts_months}
          onChange={(v) => setSettingsState({ ...settings, receipts_months: v })}
          min={1} max={120}
        />
        <NumberField
          label="Large attachments older than (months)"
          value={settings.attachments_months}
          onChange={(v) => setSettingsState({ ...settings, attachments_months: v })}
          min={1} max={120}
        />
        <NumberField
          label="High-volume threshold (emails/month)"
          value={settings.high_volume_per_month}
          onChange={(v) => setSettingsState({ ...settings, high_volume_per_month: v })}
          min={1} max={500}
        />
        <NumberField
          label="Confirm gate threshold (messages)"
          value={settings.confirm_threshold}
          onChange={(v) => setSettingsState({ ...settings, confirm_threshold: v })}
          min={1} max={100000}
        />
        <NumberField
          label="Session mutation cap"
          value={settings.session_mutation_cap}
          onChange={(v) => setSettingsState({ ...settings, session_mutation_cap: v })}
          min={100} max={500000}
        />
      </Section>

      <div className="flex justify-end mt-4 mb-8">
        <button
          onClick={save}
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
        >
          {saved ? "Saved!" : saving ? "Saving…" : "Save settings"}
        </button>
      </div>

      {/* Allowlist */}
      <Section title="Protected senders & keywords">
        <p className="text-xs text-gray-500 mb-3">
          Emails matching any of these rules are never offered for deletion, regardless of category.
          Also protected: starred messages, IMPORTANT-labeled threads, and threads you've replied to.
        </p>

        {rules.length > 0 && (
          <div className="mb-4 space-y-1">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center gap-3 bg-gray-800 px-3 py-2 rounded text-sm"
              >
                <span className="text-xs text-gray-500 w-28 shrink-0">{rule.kind.replace("allow_", "")}</span>
                <span className="text-gray-200 flex-1 truncate font-mono text-xs">{rule.pattern}</span>
                {rule.note && <span className="text-xs text-gray-500 truncate">{rule.note}</span>}
                <button
                  onClick={() => deleteRule(rule.id)}
                  className="text-gray-600 hover:text-red-400 transition-colors ml-auto shrink-0"
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add new rule */}
        <div className="flex gap-2 flex-wrap">
          <select
            value={newRule.kind}
            onChange={(e) => setNewRule({ ...newRule, kind: e.target.value as DbRule["kind"] })}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300 focus:outline-none"
          >
            <option value="allow_sender">Sender email</option>
            <option value="allow_domain">Domain</option>
            <option value="allow_keyword">Subject keyword</option>
            <option value="allow_label">Gmail label</option>
          </select>
          <input
            type="text"
            placeholder={
              newRule.kind === "allow_sender"
                ? "user@example.com"
                : newRule.kind === "allow_domain"
                  ? "example.com"
                  : newRule.kind === "allow_keyword"
                    ? "keyword"
                    : "Label name"
            }
            value={newRule.pattern}
            onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none flex-1 min-w-32"
          />
          <input
            type="text"
            placeholder="Note (optional)"
            value={newRule.note}
            onChange={(e) => setNewRule({ ...newRule, note: e.target.value })}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none flex-1 min-w-24"
          />
          <button
            onClick={addRule}
            disabled={!newRule.pattern.trim()}
            className="bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm px-3 py-1.5 rounded transition-colors"
          >
            Add
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wide">{title}</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">{children}</div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-gray-800 last:border-0">
      <label className="text-sm text-gray-300">{label}</label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white w-24 text-right focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}
