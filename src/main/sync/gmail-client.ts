import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type GmailClient = gmail_v1.Gmail;

export function createGmailClient(auth: OAuth2Client): GmailClient {
  return google.gmail({ version: "v1", auth });
}

// Retry wrapper with exponential backoff
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5
): Promise<T> {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { status?: number; code?: number }).status ??
                     (err as { status?: number; code?: number }).code;
      const isRetryable = status === 429 || (status !== undefined && status >= 500);
      if (!isRetryable || attempt === maxRetries) throw err;
      await sleep(delay + Math.random() * 500);
      delay = Math.min(delay * 2, 30000);
    }
  }
  throw new Error("unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Message listing ───────────────────────────────────────────────────────────

export async function listAllMessageIds(
  gmail: GmailClient,
  onPage: (ids: string[]) => void
): Promise<{ historyId: string }> {
  let pageToken: string | undefined;
  let historyId = "";

  do {
    const res = await withRetry(() =>
      gmail.users.messages.list({
        userId: "me",
        maxResults: 500,
        pageToken,
        fields: "messages/id,nextPageToken,historyId",
      })
    );

    const ids = (res.data.messages ?? []).map((m) => m.id!);
    if (ids.length > 0) onPage(ids);
    // historyId is not in the list response typings but is returned by the API
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawHistoryId = (res.data as any).historyId;
    if (rawHistoryId) historyId = String(rawHistoryId);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  // Fall back to profile API if historyId not captured from list response
  if (!historyId) {
    const profile = await withRetry(() => gmail.users.getProfile({ userId: "me" }));
    historyId = profile.data.historyId ?? "";
  }

  return { historyId };
}

// ── Metadata batch fetch ──────────────────────────────────────────────────────

const METADATA_FIELDS =
  "id,threadId,labelIds,snippet,sizeEstimate,internalDate,payload/headers";

const WANTED_HEADERS = new Set([
  "From",
  "To",
  "Cc",
  "Subject",
  "List-Unsubscribe",
  "List-Id",
  "Date",
]);

export interface MessageMetadata {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  sizeEstimate: number;
  internalDate: number;
  headers: Record<string, string>;
}

export async function fetchMessagesBatch(
  gmail: GmailClient,
  ids: string[]
): Promise<MessageMetadata[]> {
  // Gmail's HTTP batch API: up to 100 requests in one HTTP call
  // We use the library's per-request API with concurrency limit instead,
  // since googleapis doesn't expose raw batch easily in v4+.
  const CONCURRENCY = 10;
  const results: MessageMetadata[] = [];

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    const batch = await Promise.all(
      chunk.map((id) =>
        withRetry(() =>
          gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: [...WANTED_HEADERS],
            fields: METADATA_FIELDS,
          })
        )
      )
    );

    for (const res of batch) {
      const msg = res.data;
      const headers: Record<string, string> = {};
      for (const h of msg.payload?.headers ?? []) {
        if (h.name && h.value && WANTED_HEADERS.has(h.name)) {
          headers[h.name] = h.value;
        }
      }
      results.push({
        id: msg.id!,
        threadId: msg.threadId!,
        labelIds: msg.labelIds ?? [],
        snippet: msg.snippet ?? "",
        sizeEstimate: msg.sizeEstimate ?? 0,
        internalDate: Number(msg.internalDate ?? 0),
        headers,
      });
    }

    // Respect quota: 10 messages.get at 5 units each = 50 units per chunk
    // 250 units/sec → we can fire 5 chunks/sec. Add small delay.
    if (i + CONCURRENCY < ids.length) {
      await sleep(200);
    }
  }

  return results;
}

// ── batchModify ───────────────────────────────────────────────────────────────

export async function moveToTrash(
  gmail: GmailClient,
  messageIds: string[]
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    await withRetry(() =>
      gmail.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids: chunk,
          addLabelIds: ["TRASH"],
          removeLabelIds: ["INBOX", "UNREAD"],
        },
      })
    );
    if (i + CHUNK < messageIds.length) await sleep(500);
  }
}

export async function moveOutOfTrash(
  gmail: GmailClient,
  messageIds: string[]
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    await withRetry(() =>
      gmail.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids: chunk,
          removeLabelIds: ["TRASH"],
        },
      })
    );
    if (i + CHUNK < messageIds.length) await sleep(500);
  }
}

export async function archiveMessages(
  gmail: GmailClient,
  messageIds: string[]
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    await withRetry(() =>
      gmail.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids: chunk,
          removeLabelIds: ["INBOX"],
        },
      })
    );
    if (i + CHUNK < messageIds.length) await sleep(500);
  }
}

// ── History (incremental sync) ─────────────────────────────────────────────────

export interface HistoryResult {
  added: string[];
  deletedIds: string[];
  labelChanges: Array<{ id: string; labelIds: string[] }>;
  newHistoryId: string;
}

export async function fetchHistory(
  gmail: GmailClient,
  startHistoryId: string
): Promise<HistoryResult | "too_old"> {
  try {
    const added: string[] = [];
    const deletedIds: string[] = [];
    const labelChanges: Array<{ id: string; labelIds: string[] }> = [];
    let pageToken: string | undefined;
    let newHistoryId = startHistoryId;

    do {
      const res = await withRetry(() =>
        gmail.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded", "labelAdded", "labelRemoved"],
          pageToken,
        })
      );

      if (res.data.historyId) newHistoryId = res.data.historyId;
      pageToken = res.data.nextPageToken ?? undefined;

      for (const item of res.data.history ?? []) {
        for (const m of item.messagesAdded ?? []) {
          if (m.message?.id) added.push(m.message.id);
        }
        for (const m of item.messagesDeleted ?? []) {
          if (m.message?.id) deletedIds.push(m.message.id);
        }
        for (const m of [...(item.labelsAdded ?? []), ...(item.labelsRemoved ?? [])]) {
          if (m.message?.id) {
            labelChanges.push({ id: m.message.id, labelIds: m.message.labelIds ?? [] });
          }
        }
      }
    } while (pageToken);

    return { added, deletedIds, labelChanges, newHistoryId };
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 400) return "too_old";
    throw err;
  }
}
