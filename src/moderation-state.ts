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
  try {
    const raw = await readFile(MODERATION_EVENTS_PATH, "utf8");
    const statuses = new Map<string, ModerationDecision["status"]>();

    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      try {
        const event = JSON.parse(line) as Partial<ModerationDecision>;
        if (typeof event.id === "string" && typeof event.status === "string") {
          statuses.set(event.id, event.status as ModerationDecision["status"]);
        }
      } catch {
        // Ignore malformed historical log lines; the append-only log is diagnostic.
      }
    }

    return new Set(
      [...statuses.entries()]
        .filter(([, status]) => status === "failed")
        .map(([id]) => id)
    );
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") {
      return new Set();
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
