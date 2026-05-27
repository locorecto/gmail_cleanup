import { describe, it, expect } from "vitest";
import {
  ruleProtected,
  ruleCalendarPast,
  ruleAutomatedAlerts,
  ruleSocial,
  ruleReceipts,
  rulePromos,
  ruleNewsletters,
  ruleOneOff,
  ruleHighVolumeUnread,
  buildRuleSettings,
  type SenderStats,
} from "../src/main/categorizer/rules";
import type { DbMessage } from "../src/shared/types";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;

function msg(overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id: "test-id",
    thread_id: "thread-1",
    from_email: "sender@example.com",
    from_domain: "example.com",
    to_emails: '["me@gmail.com"]',
    cc_emails: "[]",
    subject: "Test subject",
    snippet: "Test snippet",
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

function sender(overrides: Partial<SenderStats> = {}): SenderStats {
  return {
    email: "sender@example.com",
    domain: "example.com",
    total_count: 5,
    unread_count: 0,
    replied_count: 0,
    has_list_unsub: 0,
    first_seen: NOW - 6 * MONTH,
    last_seen: NOW - DAY,
    ...overrides,
  };
}

const baseSettings = buildRuleSettings(
  [],
  { receipts_months: 6, attachments_months: 12, high_volume_per_month: 20 },
  "me@gmail.com",
  new Set()
);

describe("ruleProtected", () => {
  it("protects starred messages", () => {
    const m = msg({ labels: '["INBOX","STARRED"]' });
    expect(ruleProtected(m, undefined, baseSettings, NOW)?.category_id).toBe("protected");
  });

  it("protects IMPORTANT messages", () => {
    const m = msg({ labels: '["INBOX","IMPORTANT"]' });
    expect(ruleProtected(m, undefined, baseSettings, NOW)?.category_id).toBe("protected");
  });

  it("protects allow-listed senders", () => {
    const settings = buildRuleSettings(
      [{ id: 1, kind: "allow_sender", pattern: "sender@example.com", created_at: NOW, note: null }],
      { receipts_months: 6, attachments_months: 12, high_volume_per_month: 20 },
      "me@gmail.com",
      new Set()
    );
    expect(ruleProtected(msg(), undefined, settings, NOW)?.category_id).toBe("protected");
  });

  it("protects allow-listed domains", () => {
    const settings = buildRuleSettings(
      [{ id: 1, kind: "allow_domain", pattern: "example.com", created_at: NOW, note: null }],
      { receipts_months: 6, attachments_months: 12, high_volume_per_month: 20 },
      "me@gmail.com",
      new Set()
    );
    expect(ruleProtected(msg(), undefined, settings, NOW)?.category_id).toBe("protected");
  });

  it("protects replied-to senders", () => {
    const settings = buildRuleSettings([], { receipts_months: 6, attachments_months: 12, high_volume_per_month: 20 }, "me@gmail.com", new Set(["sender@example.com"]));
    expect(ruleProtected(msg(), sender({ replied_count: 1 }), settings, NOW)?.category_id).toBe("protected");
  });

  it("does not protect ordinary messages", () => {
    expect(ruleProtected(msg(), sender(), baseSettings, NOW)).toBeNull();
  });
});

describe("ruleCalendarPast", () => {
  it("matches old Google calendar notifications", () => {
    const m = msg({
      from_email: "calendar-notification@google.com",
      from_domain: "google.com",
      internal_date: NOW - 10 * DAY,
    });
    expect(ruleCalendarPast(m, undefined, baseSettings, NOW)?.category_id).toBe("calendar_past");
  });

  it("matches invitation subjects", () => {
    const m = msg({
      subject: "Invitation: Team sync @ Mon Jan 1",
      internal_date: NOW - 5 * DAY,
    });
    expect(ruleCalendarPast(m, undefined, baseSettings, NOW)?.category_id).toBe("calendar_past");
  });

  it("does not match very recent calendar emails", () => {
    const m = msg({
      from_email: "calendar-notification@google.com",
      internal_date: NOW - 60 * 1000, // 1 minute ago
    });
    expect(ruleCalendarPast(m, undefined, baseSettings, NOW)).toBeNull();
  });
});

describe("ruleAutomatedAlerts", () => {
  it("matches GitHub notifications older than 30 days", () => {
    const m = msg({ from_domain: "github.com", internal_date: NOW - 45 * DAY });
    expect(ruleAutomatedAlerts(m, undefined, baseSettings, NOW)?.category_id).toBe("automated_alerts");
  });

  it("does not match GitHub notifications newer than 30 days", () => {
    const m = msg({ from_domain: "github.com", internal_date: NOW - 10 * DAY });
    expect(ruleAutomatedAlerts(m, undefined, baseSettings, NOW)).toBeNull();
  });
});

describe("ruleSocial", () => {
  it("matches LinkedIn", () => {
    const m = msg({ from_domain: "linkedin.com" });
    expect(ruleSocial(m, undefined, baseSettings, NOW)?.category_id).toBe("social");
  });

  it("does not match random domains", () => {
    const m = msg({ from_domain: "company.com" });
    expect(ruleSocial(m, undefined, baseSettings, NOW)).toBeNull();
  });
});

describe("ruleReceipts", () => {
  it("matches old Amazon order confirmation", () => {
    const m = msg({
      from_domain: "amazon.com",
      subject: "Your order confirmation #123",
      internal_date: NOW - 8 * MONTH,
    });
    expect(ruleReceipts(m, undefined, baseSettings, NOW)?.category_id).toBe("receipts");
  });

  it("does not match recent Amazon email", () => {
    const m = msg({
      from_domain: "amazon.com",
      subject: "Your order confirmation #123",
      internal_date: NOW - 2 * MONTH,
    });
    expect(ruleReceipts(m, undefined, baseSettings, NOW)).toBeNull();
  });
});

describe("rulePromos", () => {
  it("matches promotional email with List-Unsubscribe and sale subject", () => {
    const m = msg({
      has_list_unsub: 1,
      subject: "50% off today only!",
      internal_date: NOW - 60 * DAY,
    });
    expect(rulePromos(m, undefined, baseSettings, NOW)?.category_id).toBe("promos");
  });

  it("does not match recent promo", () => {
    const m = msg({
      has_list_unsub: 1,
      subject: "50% off today only!",
      internal_date: NOW - 5 * DAY,
    });
    expect(rulePromos(m, undefined, baseSettings, NOW)).toBeNull();
  });
});

describe("ruleNewsletters", () => {
  it("matches email with List-Unsubscribe from a sender I have not replied to", () => {
    const m = msg({ has_list_unsub: 1 });
    const s = sender({ replied_count: 0 });
    expect(ruleNewsletters(m, s, baseSettings, NOW)?.category_id).toBe("newsletters");
  });

  it("does not match if I have replied to the sender", () => {
    const m = msg({ has_list_unsub: 1 });
    const s = sender({ replied_count: 1 });
    expect(ruleNewsletters(m, s, baseSettings, NOW)).toBeNull();
  });

  it("does not match without List-Unsubscribe or list_id", () => {
    const m = msg({ has_list_unsub: 0, list_id: null });
    const s = sender({ replied_count: 0 });
    expect(ruleNewsletters(m, s, baseSettings, NOW)).toBeNull();
  });
});

describe("ruleOneOff", () => {
  it("matches sender with ≤2 messages, all unread, old", () => {
    const m = msg({ is_unread: 1, internal_date: NOW - 100 * DAY });
    const s = sender({ total_count: 1, unread_count: 1, replied_count: 0 });
    expect(ruleOneOff(m, s, baseSettings, NOW)?.category_id).toBe("one_off");
  });

  it("does not match if sender has >2 total messages", () => {
    const m = msg({ is_unread: 1, internal_date: NOW - 100 * DAY });
    const s = sender({ total_count: 5, unread_count: 5 });
    expect(ruleOneOff(m, s, baseSettings, NOW)).toBeNull();
  });

  it("does not match recent messages", () => {
    const m = msg({ is_unread: 1, internal_date: NOW - 10 * DAY });
    const s = sender({ total_count: 1, unread_count: 1 });
    expect(ruleOneOff(m, s, baseSettings, NOW)).toBeNull();
  });
});

describe("ruleHighVolumeUnread", () => {
  it("matches high-volume mostly-unread sender", () => {
    const m = msg();
    const s = sender({
      total_count: 100,
      unread_count: 90,
      first_seen: NOW - 4 * MONTH,
      last_seen: NOW,
    });
    expect(ruleHighVolumeUnread(m, s, baseSettings, NOW)?.category_id).toBe("high_volume_unread");
  });

  it("does not match if unread ratio is low", () => {
    const m = msg();
    const s = sender({
      total_count: 100,
      unread_count: 10,
      first_seen: NOW - 4 * MONTH,
      last_seen: NOW,
    });
    expect(ruleHighVolumeUnread(m, s, baseSettings, NOW)).toBeNull();
  });
});
