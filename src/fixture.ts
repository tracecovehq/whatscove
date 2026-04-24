import type { MessageRow, MessageSnapshot } from "./types.ts";

type FixtureLike =
  | Partial<MessageSnapshot>
  | Partial<MessageRow>
  | {
      message?: Partial<MessageRow>;
      messages?: Partial<MessageRow>[];
    };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + ` ${[pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(":")}`;
}

export function normalizeFixtureRow(
  row: Partial<MessageRow>,
  index: number,
  now: Date = new Date()
): MessageRow {
  const messagePk = Number.isFinite(row.messagePk) ? Number(row.messagePk) : index + 1;
  const messageTimeUtc = row.messageTimeUtc ?? now.toISOString();
  const messageTimeLocal = row.messageTimeLocal ?? formatLocalTimestamp(now);

  return {
    messagePk,
    messageTimeUtc,
    messageTimeLocal,
    chatName: row.chatName ?? "Fixture Testing",
    chatJid: row.chatJid ?? "fixture-chat@g.us",
    fromJid: row.fromJid ?? "fixture-sender@lid",
    senderName: row.senderName ?? "Fixture Sender",
    messageType: Number.isFinite(row.messageType) ? Number(row.messageType) : 0,
    groupEventType:
      typeof row.groupEventType === "number" ? row.groupEventType : null,
    text: row.text ?? null,
    toJid: row.toJid ?? null,
    groupMemberJid: row.groupMemberJid ?? null,
    groupMemberName: row.groupMemberName ?? null,
    previewTitle: row.previewTitle ?? null,
    previewSummary: row.previewSummary ?? null,
    previewContent1: row.previewContent1 ?? null,
    previewContent2: row.previewContent2 ?? null
  };
}

export function coerceFixtureSnapshot(
  raw: unknown,
  sourceLabel: string,
  now: Date = new Date()
): MessageSnapshot {
  if (typeof raw !== "object" || raw == null) {
    throw new Error("Fixture JSON must be an object, array, or snapshot-like structure.");
  }

  const fixture = raw as FixtureLike;
  let rawMessages: Partial<MessageRow>[];

  if (Array.isArray(raw)) {
    rawMessages = raw as Partial<MessageRow>[];
  } else if (Array.isArray(fixture.messages)) {
    rawMessages = fixture.messages;
  } else if (fixture.message && typeof fixture.message === "object") {
    rawMessages = [fixture.message];
  } else {
    rawMessages = [fixture as Partial<MessageRow>];
  }

  if (rawMessages.length === 0) {
    throw new Error("Fixture must contain at least one message row.");
  }

  const snapshotLike = fixture as Partial<MessageSnapshot>;
  return {
    databasePath: snapshotLike.databasePath ?? `fixture:${sourceLabel}`,
    fetchedAt: snapshotLike.fetchedAt ?? now.toISOString(),
    messages: rawMessages.map((message, index) => normalizeFixtureRow(message, index, now))
  };
}
