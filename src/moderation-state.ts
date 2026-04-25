import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ModerationDecision, ModerationState } from "./types.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA_DIR = path.join(PACKAGE_ROOT, "data");
const MODERATION_STATE_PATH = path.join(DATA_DIR, "moderation-state.json");
const MODERATION_QUEUE_PATH = path.join(DATA_DIR, "moderation-queue.jsonl");
const MODERATION_EVENTS_PATH = path.join(DATA_DIR, "moderation-events.jsonl");

const EMPTY_STATE: ModerationState = {
  locallyBannedUsers: [],
  processedDecisionIds: []
};

function isGroupJid(value: string): boolean {
  return value.endsWith("@g.us");
}

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

async function loadLatestFailedDecisionIds(): Promise<Set<string>> {
  const latestEvents = await loadLatestModerationEventsByDecisionId();
  return new Set(
    [...latestEvents.values()]
      .filter((event) => event.status === "failed")
      .map((event) => event.id)
  );
}

async function loadLatestModerationEventsByDecisionId(): Promise<Map<string, ModerationDecision>> {
  try {
    const raw = await readFile(MODERATION_EVENTS_PATH, "utf8");
    const latestEvents = new Map<string, ModerationDecision>();

    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      try {
        const event = JSON.parse(line) as Partial<ModerationDecision>;
        if (
          typeof event.id === "string" &&
          typeof event.status === "string" &&
          typeof event.action === "string" &&
          typeof event.matchFingerprint === "string" &&
          typeof event.chatName === "string" &&
          typeof event.chatJid === "string" &&
          typeof event.senderName === "string" &&
          typeof event.fromJid === "string" &&
          typeof event.messageTimeLocal === "string" &&
          typeof event.messagePk === "number" &&
          typeof event.text === "string" &&
          typeof event.createdAt === "string"
        ) {
          latestEvents.set(event.id, event as ModerationDecision);
        }
      } catch {
        // Ignore malformed historical log lines; the append-only log is diagnostic.
      }
    }

    return latestEvents;
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

export async function loadModerationState(): Promise<ModerationState> {
  try {
    const raw = await readFile(MODERATION_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ModerationState>;
    const latestFailedDecisionIds = await loadLatestFailedDecisionIds();
    return {
      locallyBannedUsers: Array.isArray(parsed.locallyBannedUsers)
        ? parsed.locallyBannedUsers.filter(
            (value): value is string => typeof value === "string" && !isGroupJid(value)
          )
        : [],
      processedDecisionIds: Array.isArray(parsed.processedDecisionIds)
        ? parsed.processedDecisionIds.filter(
            (value): value is string =>
              typeof value === "string" && !latestFailedDecisionIds.has(value)
          )
        : []
    };
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") {
      return { ...EMPTY_STATE };
    }
    throw error;
  }
}

export async function saveModerationState(state: ModerationState): Promise<void> {
  await ensureDataDir();
  await writeFile(MODERATION_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export async function appendModerationQueue(decisions: ModerationDecision[]): Promise<void> {
  if (decisions.length === 0) {
    return;
  }
  await ensureDataDir();
  await appendFile(MODERATION_QUEUE_PATH, `${decisions.map((d) => JSON.stringify(d)).join("\n")}\n`);
}

export async function appendModerationEvents(events: ModerationDecision[]): Promise<void> {
  if (events.length === 0) {
    return;
  }
  await ensureDataDir();
  await appendFile(MODERATION_EVENTS_PATH, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

export async function loadPendingFailedModerationDecisions(
  lookbackHours: number
): Promise<ModerationDecision[]> {
  const latestEvents = await loadLatestModerationEventsByDecisionId();
  const cutoffTime = Date.now() - lookbackHours * 60 * 60 * 1000;
  return [...latestEvents.values()]
    .filter(
      (decision) =>
        decision.status === "failed" &&
        decision.action !== "notify" &&
        Number.isFinite(Date.parse(decision.createdAt)) &&
        Date.parse(decision.createdAt) >= cutoffTime
    )
    .map((decision) => ({
      ...decision,
      status: "pending_apply",
      resumedFromFailure: true
    }));
}
