import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { upsertMessages, rebuildSenders, updateMessageCategories } from "../src/main/db/index";
import { runCategorizer } from "../src/main/categorizer/engine";
import type { DbMessage } from "../src/shared/types";
import { BUILT_IN_CATEGORIES } from "../src/shared/categories";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;

function openTestDb(): Database.Database {
  const db = new Database(":memory:");
  const schema = fs.readFileSync(
    path.join(__dirname, "../src/main/db/schema.sql"),
    "utf-8"
  );
  db.exec(schema);

  // Seed categories
  const ins = db.prepare(
    "INSERT OR IGNORE INTO categories (id, display_name, description, priority, default_action, enabled) VALUES (@id, @display_name, @description, @priority, @default_action, @enabled)"
  );
  const tx = db.transaction(() => {
    for (const cat of BUILT_IN_CATEGORIES) ins.run(cat);
  });
  tx();

  // Seed default settings
  const defaults = [
    ["receipts_months", "6"],
    ["attachments_months", "12"],
    ["high_volume_per_month", "20"],
    ["confirm_threshold", "1000"],
    ["llm_enabled", "false"],
    ["llm_api_key", "null"],
    ["llm_cost_cap_usd", "5"],
    ["session_mutation_cap", "50000"],
  ];
  const setSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [k, v] of defaults) setSetting.run(k, v);

  return db;
}

function makeMsg(overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id: Math.random().toString(36).slice(2),
    thread_id: "thread-1",
    from_email: "sender@example.com",
    from_domain: "example.com",
    to_emails: '["me@gmail.com"]',
    cc_emails: "[]",
    subject: "Test",
    snippet: null,
    size_bytes: 5000,
    internal_date: NOW - 60 * DAY,
    labels: '["INBOX"]',
    has_list_unsub: 0,
    list_id: null,
    is_unread: 0,
    category_id: null,
    confidence: null,
    fetched_at: NOW,
    body_cached: 0,
    ...overrides,
  };
}

describe("categorizer engine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  it("categorizes newsletters", () => {
    const m = makeMsg({ has_list_unsub: 1, from_email: "news@newsletter.com", from_domain: "newsletter.com" });
    upsertMessages(db, [m]);
    rebuildSenders(db, "me@gmail.com");
    runCategorizer(db, "me@gmail.com");

    const row = db.prepare("SELECT category_id FROM messages WHERE id = ?").get(m.id) as { category_id: string | null };
    expect(row.category_id).toBe("newsletters");
  });

  it("does not categorize newsletters if sender is replied-to", () => {
    const threadId = "reply-thread";
    const newsletter = makeMsg({
      has_list_unsub: 1,
      from_email: "news@newsletter.com",
      from_domain: "newsletter.com",
      thread_id: threadId,
    });
    const myReply = makeMsg({
      from_email: "me@gmail.com",
      from_domain: "gmail.com",
      thread_id: threadId,
    });
    upsertMessages(db, [newsletter, myReply]);
    rebuildSenders(db, "me@gmail.com");
    runCategorizer(db, "me@gmail.com");

    const row = db.prepare("SELECT category_id FROM messages WHERE id = ?").get(newsletter.id) as { category_id: string | null };
    // Should not be in newsletters because I've replied in the thread
    expect(row.category_id).toBeNull();
  });

  it("protects starred messages", () => {
    const m = makeMsg({ labels: '["INBOX","STARRED"]', has_list_unsub: 1 });
    upsertMessages(db, [m]);
    rebuildSenders(db, "me@gmail.com");
    runCategorizer(db, "me@gmail.com");

    const row = db.prepare("SELECT category_id FROM messages WHERE id = ?").get(m.id) as { category_id: string | null };
    expect(row.category_id).toBeNull();
  });

  it("categorizes social notifications", () => {
    const m = makeMsg({ from_email: "notifications@linkedin.com", from_domain: "linkedin.com" });
    upsertMessages(db, [m]);
    rebuildSenders(db, "me@gmail.com");
    runCategorizer(db, "me@gmail.com");

    const row = db.prepare("SELECT category_id FROM messages WHERE id = ?").get(m.id) as { category_id: string | null };
    expect(row.category_id).toBe("social");
  });

  it("categorizes old receipts from known merchants", () => {
    const m = makeMsg({
      from_domain: "amazon.com",
      subject: "Your order confirmation #ABC123",
      internal_date: NOW - 8 * MONTH,
    });
    upsertMessages(db, [m]);
    rebuildSenders(db, "me@gmail.com");
    runCategorizer(db, "me@gmail.com");

    const row = db.prepare("SELECT category_id FROM messages WHERE id = ?").get(m.id) as { category_id: string | null };
    expect(row.category_id).toBe("receipts");
  });

  it("allowlist rule from DB overrides category", () => {
    db.prepare("INSERT INTO rules (kind, pattern, created_at) VALUES ('allow_domain','linkedin.com',?)").run(NOW);
    const m = makeMsg({ from_email: "notifications@linkedin.com", from_domain: "linkedin.com" });
    upsertMessages(db, [m]);
    rebuildSenders(db, "me@gmail.com");
    runCategorizer(db, "me@gmail.com");

    const row = db.prepare("SELECT category_id FROM messages WHERE id = ?").get(m.id) as { category_id: string | null };
    expect(row.category_id).toBeNull();
  });
});
