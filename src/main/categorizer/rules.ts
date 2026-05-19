import type { DbMessage, DbRule } from "../../shared/types";
import {
  ALERT_DOMAINS,
  SOCIAL_DOMAINS,
  RECEIPT_DOMAINS,
  RECEIPT_SUBJECT_PATTERNS,
  PROMO_SUBJECT_PATTERNS,
} from "../../shared/categories";

export interface SenderStats {
  email: string;
  domain: string;
  total_count: number;
  unread_count: number;
  replied_count: number;
  has_list_unsub: 0 | 1;
  first_seen: number | null;
  last_seen: number | null;
}

export interface CategoryMatch {
  category_id: string;
  confidence: number;
}

export type Rule = (
  msg: DbMessage,
  sender: SenderStats | undefined,
  settings: RuleSettings,
  now: number
) => CategoryMatch | null;

export interface RuleSettings {
  receipts_months: number;
  attachments_months: number;
  high_volume_per_month: number;
  accountEmail: string;
  allowedSenders: Set<string>;
  allowedDomains: Set<string>;
  allowedKeywords: Set<string>;
  allowedLabels: Set<string>;
  repliedSenders: Set<string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

function ageMs(msg: DbMessage, now: number): number {
  return now - msg.internal_date;
}

function labels(msg: DbMessage): string[] {
  try {
    return JSON.parse(msg.labels);
  } catch {
    return [];
  }
}

// Rule 0: Protected
export const ruleProtected: Rule = (msg, sender, settings) => {
  const lbls = labels(msg);

  if (lbls.includes("STARRED")) return { category_id: "protected", confidence: 1 };
  if (lbls.includes("SENT")) return { category_id: "protected", confidence: 1 };
  if (lbls.includes("IMPORTANT")) return { category_id: "protected", confidence: 1 };

  if (settings.allowedSenders.has(msg.from_email)) {
    return { category_id: "protected", confidence: 1 };
  }
  if (settings.allowedDomains.has(msg.from_domain)) {
    return { category_id: "protected", confidence: 1 };
  }

  if (settings.repliedSenders.has(msg.from_email)) {
    return { category_id: "protected", confidence: 1 };
  }

  if (settings.allowedKeywords.size > 0 && msg.subject) {
    for (const kw of settings.allowedKeywords) {
      if (msg.subject.toLowerCase().includes(kw.toLowerCase())) {
        return { category_id: "protected", confidence: 1 };
      }
    }
  }

  const msgLabels = new Set(lbls);
  for (const lbl of settings.allowedLabels) {
    if (msgLabels.has(lbl)) return { category_id: "protected", confidence: 1 };
  }

  return null;
};

// Rule 1: Calendar invites past date
export const ruleCalendarPast: Rule = (msg, _sender, _settings, now) => {
  const from = msg.from_email.toLowerCase();
  const isCalendar =
    from.includes("calendar-notification@google.com") ||
    from.includes("calendar.google.com") ||
    from.includes("invite@") ||
    (msg.subject?.toLowerCase().includes("invitation:") ?? false) ||
    (msg.subject?.toLowerCase().includes("accepted:") ?? false) ||
    (msg.subject?.toLowerCase().includes("declined:") ?? false) ||
    (msg.subject?.toLowerCase().includes("updated invitation:") ?? false);

  if (!isCalendar) return null;

  if (ageMs(msg, now) > DAY_MS) {
    return { category_id: "calendar_past", confidence: 0.9 };
  }
  return null;
};

// Rule 2: Automated alerts (CI/CD, monitoring)
export const ruleAutomatedAlerts: Rule = (msg, _sender, _settings, now) => {
  if (ALERT_DOMAINS.has(msg.from_domain) && ageMs(msg, now) > 30 * DAY_MS) {
    return { category_id: "automated_alerts", confidence: 1 };
  }
  return null;
};

// Rule 3: Social notifications
export const ruleSocial: Rule = (msg) => {
  if (SOCIAL_DOMAINS.has(msg.from_domain)) {
    return { category_id: "social", confidence: 1 };
  }
  return null;
};

// Rule 4: Transactional receipts older than N months
export const ruleReceipts: Rule = (msg, _sender, settings, now) => {
  const threshold = settings.receipts_months * MONTH_MS;
  if (ageMs(msg, now) < threshold) return null;

  const isReceiptDomain = RECEIPT_DOMAINS.has(msg.from_domain);
  const subject = msg.subject ?? "";
  const isReceiptSubject = RECEIPT_SUBJECT_PATTERNS.some((p) => p.test(subject));

  if (isReceiptDomain && isReceiptSubject) {
    return { category_id: "receipts", confidence: 1 };
  }
  if (isReceiptDomain && ageMs(msg, now) > 12 * MONTH_MS) {
    return { category_id: "receipts", confidence: 0.8 };
  }
  return null;
};

// Rule 5: Promotional / discount emails
export const rulePromos: Rule = (msg, _sender, _settings, now) => {
  if (!msg.has_list_unsub) return null;
  if (ageMs(msg, now) < 30 * DAY_MS) return null;

  const subject = msg.subject ?? "";
  if (PROMO_SUBJECT_PATTERNS.some((p) => p.test(subject))) {
    return { category_id: "promos", confidence: 1 };
  }
  return null;
};

// Rule 6: Newsletters & marketing
export const ruleNewsletters: Rule = (msg, sender) => {
  if (!msg.has_list_unsub && !msg.list_id) return null;

  if (sender && sender.replied_count > 0) return null;

  return { category_id: "newsletters", confidence: 1 };
};

// Rule 7: CC'd, never participated, older than 60 days
export const ruleCcOnly: Rule = (msg, sender, settings, now) => {
  if (ageMs(msg, now) < 60 * DAY_MS) return null;

  let ccEmails: string[] = [];
  try {
    ccEmails = JSON.parse(msg.cc_emails);
  } catch {
    return null;
  }

  const isCcOnly =
    ccEmails.includes(settings.accountEmail) &&
    sender &&
    sender.replied_count === 0;

  if (isCcOnly) return { category_id: "cc_only", confidence: 0.9 };
  return null;
};

// Rule 8: Large attachments older than N months
export const ruleLargeAttachments: Rule = (msg, _sender, settings, now) => {
  const threshold = settings.attachments_months * MONTH_MS;
  if (ageMs(msg, now) < threshold) return null;
  if ((msg.size_bytes ?? 0) < 1024 * 1024) return null; // < 1 MB
  return { category_id: "large_attachments", confidence: 0.9 };
};

// Rule 9: One-off senders (≤2 messages, all unread, age > 90 days)
export const ruleOneOff: Rule = (msg, sender, _settings, now) => {
  if (!sender) return null;
  if (ageMs(msg, now) < 90 * DAY_MS) return null;
  if (sender.total_count > 2) return null;
  if (sender.unread_count < sender.total_count) return null;
  return { category_id: "one_off", confidence: 0.85 };
};

// Rule 10: High-volume, mostly unread
export const ruleHighVolumeUnread: Rule = (msg, sender, settings, now) => {
  if (!sender) return null;
  if (!sender.first_seen || !sender.last_seen) return null;

  const spanMonths = Math.max(1, (sender.last_seen - sender.first_seen) / MONTH_MS);
  const perMonth = sender.total_count / spanMonths;
  if (perMonth < settings.high_volume_per_month) return null;

  const unreadRatio = sender.total_count > 0 ? sender.unread_count / sender.total_count : 0;
  if (unreadRatio < 0.8) return null;

  return { category_id: "high_volume_unread", confidence: 0.9 };
};

export const ALL_RULES: Rule[] = [
  ruleProtected,
  ruleCalendarPast,
  ruleAutomatedAlerts,
  ruleSocial,
  ruleReceipts,
  rulePromos,
  ruleNewsletters,
  ruleCcOnly,
  ruleLargeAttachments,
  ruleOneOff,
  ruleHighVolumeUnread,
];

export function buildRuleSettings(
  dbRules: DbRule[],
  settings: { receipts_months: number; attachments_months: number; high_volume_per_month: number },
  accountEmail: string,
  repliedSenders: Set<string>
): RuleSettings {
  const allowedSenders = new Set<string>();
  const allowedDomains = new Set<string>();
  const allowedKeywords = new Set<string>();
  const allowedLabels = new Set<string>();

  for (const rule of dbRules) {
    if (rule.kind === "allow_sender") allowedSenders.add(rule.pattern.toLowerCase());
    else if (rule.kind === "allow_domain") allowedDomains.add(rule.pattern.toLowerCase());
    else if (rule.kind === "allow_keyword") allowedKeywords.add(rule.pattern);
    else if (rule.kind === "allow_label") allowedLabels.add(rule.pattern);
  }

  return {
    ...settings,
    accountEmail,
    allowedSenders,
    allowedDomains,
    allowedKeywords,
    allowedLabels,
    repliedSenders,
  };
}
