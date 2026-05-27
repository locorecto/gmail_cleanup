import type Database from "better-sqlite3";
import type { DbMessage, LlmRunProgress, LlmTestResult } from "../../shared/types";
import { BUILT_IN_CATEGORIES } from "../../shared/categories";
import { getSettings, updateMessageCategories } from "../db/index";

const VALID_CATEGORY_IDS = new Set(BUILT_IN_CATEGORIES.map((c) => c.id));

const SYSTEM_PROMPT = `You are an email triage assistant. You classify a single email \
into exactly one of these categories, or return "uncategorized" if no category fits.

Categories:
${BUILT_IN_CATEGORIES.map((c) => `- ${c.id}: ${c.description ?? c.display_name}`).join("\n")}
- uncategorized: does not clearly fit any of the above

You receive: from address, subject, snippet, age in days, unread flag, has-list-unsubscribe flag.
You never read full message bodies.

Respond with a single JSON object: {"category": "<id>", "confidence": <0..1>, "reason": "<short>"}
- confidence must be between 0 and 1
- reason must be under 80 characters`;

interface OllamaChatRequest {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  format: "json";
  stream: false;
  options?: { temperature?: number; num_ctx?: number };
}

interface OllamaChatResponse {
  message: { role: string; content: string };
  done: boolean;
}

interface OllamaTagsResponse {
  models: { name: string }[];
}

interface LlmDecision {
  category: string;
  confidence: number;
  reason: string;
}

function buildUserPrompt(msg: DbMessage, now: number): string {
  const ageDays = Math.max(0, Math.floor((now - msg.internal_date) / (24 * 60 * 60 * 1000)));
  return JSON.stringify({
    from: msg.from_email,
    subject: msg.subject ?? "",
    snippet: (msg.snippet ?? "").slice(0, 240),
    age_days: ageDays,
    is_unread: msg.is_unread === 1,
    has_list_unsubscribe: msg.has_list_unsub === 1,
  });
}

async function callOllama(
  endpoint: string,
  model: string,
  userPrompt: string,
  signal?: AbortSignal
): Promise<LlmDecision | null> {
  const body: OllamaChatRequest = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    format: "json",
    stream: false,
    options: { temperature: 0, num_ctx: 2048 },
  };

  const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const data = (await res.json()) as OllamaChatResponse;
  const content = data.message?.content?.trim();
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as Partial<LlmDecision>;
    if (typeof parsed.category !== "string") return null;
    const confidence =
      typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    return {
      category: parsed.category,
      confidence,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "",
    };
  } catch {
    return null;
  }
}

export async function testOllama(endpoint: string): Promise<LlmTestResult> {
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as OllamaTagsResponse;
    return { ok: true, models: data.models?.map((m) => m.name) ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runLlmClassifier(
  db: Database.Database,
  onProgress?: (p: LlmRunProgress) => void
): Promise<{ classified: number; skipped: number }> {
  const settings = getSettings(db);
  if (!settings.llm_enabled) {
    return { classified: 0, skipped: 0 };
  }

  const now = Date.now();
  const cap = Math.max(1, settings.llm_max_per_run);

  const candidates = db
    .prepare(
      `SELECT * FROM messages
       WHERE category_id IS NULL
       ORDER BY internal_date ASC
       LIMIT ?`
    )
    .all(cap) as DbMessage[];

  const total = candidates.length;
  onProgress?.({ phase: "classifying", total, done: 0 });

  if (total === 0) {
    onProgress?.({ phase: "done", total: 0, done: 0 });
    return { classified: 0, skipped: 0 };
  }

  const assignments: Array<{ id: string; category_id: string; confidence: number }> = [];
  let skipped = 0;
  let done = 0;

  for (const msg of candidates) {
    try {
      const decision = await callOllama(
        settings.llm_endpoint,
        settings.llm_model,
        buildUserPrompt(msg, now)
      );

      if (
        decision &&
        decision.category !== "uncategorized" &&
        VALID_CATEGORY_IDS.has(decision.category)
      ) {
        assignments.push({
          id: msg.id,
          category_id: decision.category,
          // LLM confidences are always < 1 to mark them as non-deterministic
          confidence: Math.min(0.95, decision.confidence),
        });
      } else {
        skipped += 1;
      }
    } catch (err) {
      onProgress?.({
        phase: "error",
        total,
        done,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    done += 1;
    if (done % 10 === 0 || done === total) {
      onProgress?.({ phase: "classifying", total, done });
    }
  }

  if (assignments.length > 0) {
    updateMessageCategories(db, assignments);
  }

  onProgress?.({ phase: "done", total, done });
  return { classified: assignments.length, skipped };
}
