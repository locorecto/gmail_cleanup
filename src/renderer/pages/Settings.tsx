import { useState, useEffect } from "react";
import type { AppSettings, DbRule, LlmTestResult } from "@shared/types";
import { useInvoke } from "../hooks/useIpc";

export default function Settings({ onBack }: { onBack: () => void }) {
  const invoke = useInvoke();
  const [settings, setSettingsState] = useState<AppSettings | null>(null);
  const [rules, setRules] = useState<DbRule[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [llmTest, setLlmTest] = useState<LlmTestResult | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmRunning, setLlmRunning] = useState(false);
  const [llmResult, setLlmResult] = useState<string | null>(null);
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

  async function testLlm() {
    setLlmTesting(true);
    setLlmTest(null);
    try {
      const result = await invoke<LlmTestResult>("llm:test");
      setLlmTest(result);
    } finally {
      setLlmTesting(false);
    }
  }

  async function runLlm() {
    setLlmRunning(true);
    setLlmResult(null);
    try {
      const result = await invoke<{ classified: number; skipped: number }>("llm:run");
      setLlmResult(
        `Classified ${result.classified.toLocaleString()} messages (${result.skipped.toLocaleString()} left uncategorized).`
      );
    } catch (e) {
      setLlmResult(`Error: ${String(e)}`);
    } finally {
      setLlmRunning(false);
    }
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

      {/* Local LLM (Ollama) */}
      <Section title="Local LLM classifier (Ollama)">
        <p className="text-xs text-gray-500 mb-3">
          Optionally classify messages that no rule matched using a local Ollama server. Runs
          fully on your machine — no data leaves your computer. Install Ollama from{" "}
          <span className="font-mono">ollama.com</span>, then{" "}
          <span className="font-mono">ollama pull {settings.llm_model || "llama3.2:3b"}</span>.
        </p>

        <div className="flex items-center justify-between gap-4 py-2 border-b border-gray-800">
          <label className="text-sm text-gray-300">Enable local LLM classifier</label>
          <input
            type="checkbox"
            checked={settings.llm_enabled}
            onChange={(e) => setSettingsState({ ...settings, llm_enabled: e.target.checked })}
            className="h-4 w-4"
          />
        </div>

        <div className="flex items-center justify-between gap-4 py-2 border-b border-gray-800">
          <label className="text-sm text-gray-300">Ollama endpoint</label>
          <input
            type="text"
            value={settings.llm_endpoint}
            onChange={(e) => setSettingsState({ ...settings, llm_endpoint: e.target.value })}
            disabled={!settings.llm_enabled}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white w-64 text-right focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
        </div>

        <div className="flex items-center justify-between gap-4 py-2 border-b border-gray-800">
          <label className="text-sm text-gray-300">Model</label>
          <input
            type="text"
            value={settings.llm_model}
            onChange={(e) => setSettingsState({ ...settings, llm_model: e.target.value })}
            disabled={!settings.llm_enabled}
            placeholder="llama3.2:3b"
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white w-64 text-right font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
        </div>

        <NumberField
          label="Max messages per run"
          value={settings.llm_max_per_run}
          onChange={(v) => setSettingsState({ ...settings, llm_max_per_run: v })}
          min={1}
          max={100000}
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={testLlm}
            disabled={!settings.llm_enabled || llmTesting}
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-xs px-3 py-1.5 rounded transition-colors"
          >
            {llmTesting ? "Testing…" : "Test connection"}
          </button>
          <button
            onClick={runLlm}
            disabled={!settings.llm_enabled || llmRunning}
            className="bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded transition-colors"
          >
            {llmRunning ? "Running…" : "Run on uncategorized"}
          </button>
        </div>

        {llmTest && (
          <div
            className={`mt-3 text-xs px-3 py-2 rounded ${
              llmTest.ok ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"
            }`}
          >
            {llmTest.ok
              ? `Reachable. ${llmTest.models?.length ?? 0} model(s) installed${
                  llmTest.models?.length ? `: ${llmTest.models.slice(0, 5).join(", ")}` : ""
                }`
              : `Failed: ${llmTest.error}`}
          </div>
        )}

        {llmResult && (
          <div className="mt-3 text-xs px-3 py-2 rounded bg-gray-800 text-gray-300">{llmResult}</div>
        )}
      </Section>

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
