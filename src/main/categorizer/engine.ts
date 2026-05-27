import type Database from "better-sqlite3";
import type { DbMessage, DbRule } from "../../shared/types";
import { ALL_RULES, buildRuleSettings, type SenderStats } from "./rules";
import { getRules, getSettings, updateMessageCategories } from "../db/index";

export function runCategorizer(db: Database.Database, accountEmail: string): void {
  const settings = getSettings(db);
  const dbRules = getRules(db);

  // Load sender stats into a map
  const senders = new Map<string, SenderStats>(
    (db.prepare("SELECT * FROM senders").all() as SenderStats[]).map((s) => [
      s.email,
      s,
    ])
  );

  // Build set of senders the account has replied to
  const repliedSenders = new Set<string>(
    [...senders.values()]
      .filter((s) => s.replied_count > 0)
      .map((s) => s.email)
  );

  const ruleSettings = buildRuleSettings(
    dbRules,
    {
      receipts_months: settings.receipts_months,
      attachments_months: settings.attachments_months,
      high_volume_per_month: settings.high_volume_per_month,
    },
    accountEmail,
    repliedSenders
  );

  // Process in chunks to avoid loading all messages into memory at once
  const CHUNK = 5000;
  let offset = 0;
  const now = Date.now();

  const assignments: Array<{ id: string; category_id: string; confidence: number }> = [];

  while (true) {
    const msgs = db
      .prepare("SELECT * FROM messages LIMIT ? OFFSET ?")
      .all(CHUNK, offset) as DbMessage[];

    if (msgs.length === 0) break;

    for (const msg of msgs) {
      const sender = senders.get(msg.from_email);
      let matched: { category_id: string; confidence: number } | null = null;

      for (const rule of ALL_RULES) {
        const result = rule(msg, sender, ruleSettings, now);
        if (result) {
          matched = result;
          break;
        }
      }

      if (matched && matched.category_id !== "protected") {
        assignments.push({
          id: msg.id,
          category_id: matched.category_id,
          confidence: matched.confidence,
        });
      } else if (!matched) {
        // Clear any stale category
        assignments.push({ id: msg.id, category_id: "", confidence: 0 });
      }
    }

    offset += CHUNK;
    if (msgs.length < CHUNK) break;
  }

  // Write in one transaction
  const validAssignments = assignments.filter((a) => a.category_id !== "");
  const clearAssignments = assignments
    .filter((a) => a.category_id === "")
    .map((a) => ({ id: a.id }));

  if (validAssignments.length > 0) {
    updateMessageCategories(db, validAssignments);
  }
  if (clearAssignments.length > 0) {
    const stmt = db.prepare("UPDATE messages SET category_id = NULL, confidence = NULL WHERE id = ?");
    const tx = db.transaction(() => {
      for (const a of clearAssignments) stmt.run(a.id);
    });
    tx();
  }
}
