import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTextCandidates, detectSpam, getDefaultSpamRules } from "./detection.ts";
import { handleModeration } from "./moderation.ts";
import type {
  MessageSnapshot,
  ModerationDecision,
  ScanResult,
  SpamDetectionOptions,
  SpamGuardOptions,
  SuspiciousMatch
} from "./types.ts";
import { fetchRecentMessages } from "./whatsapp-db.ts";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA_DIR = path.join(PACKAGE_ROOT, "data");
const LATEST_RESULTS_PATH = path.join(DATA_DIR, "latest-suspects.json");
const ALERT_LOG_PATH = path.join(DATA_DIR, "spam-alerts.jsonl");

function buildFingerprint(record: Record<string, unknown>): string {
  return createHash("sha1").update(JSON.stringify(record)).digest("hex").slice(0, 12);
}

export async function findSuspiciousEntries(
  snapshot: MessageSnapshot,
  options: SpamDetectionOptions = {}
): Promise<{
  matches: SuspiciousMatch[];
  weakMatches: SuspiciousMatch[];
}> {
  const minScore = Number(options.minScore ?? 0.72);
  const weakMinScore = Number(options.weakMinScore ?? 0);
  const rules = options.rules ?? (await getDefaultSpamRules());
  const matches: SuspiciousMatch[] = [];
  const weakMatches: SuspiciousMatch[] = [];

  for (const row of snapshot.messages ?? []) {
    const candidates = createTextCandidates({
      value: row.text,
      name: row.previewTitle,
      description: [row.previewSummary, row.previewContent1, row.previewContent2]
        .filter(Boolean)
        .join("\n")
    });

    for (const text of candidates) {
      const result = await detectSpam(text, { minScore, rules });
      const candidateMatch = {
        fingerprint: buildFingerprint({
          chatName: row.chatName,
          senderName: row.senderName,
          ruleId: result.ruleId,
          text
        }),
        messagePk: row.messagePk,
        chatName: row.chatName,
        chatJid: row.chatJid,
        senderName: row.senderName,
        fromJid: row.fromJid,
        messageType: row.messageType,
        messageTimeLocal: row.messageTimeLocal,
        ruleId: result.ruleId,
        ruleLabel: result.ruleLabel,
        text,
        score: Number(result.score.toFixed(3)),
        reasons: result.reasons,
        details: result.details
      };

      if (result.matched) {
        matches.push(candidateMatch);
        continue;
      }

      if (candidateMatch.score < weakMinScore) {
        continue;
      }

      weakMatches.push(candidateMatch);
    }
  }

  return {
    matches: matches.sort((left, right) => right.score - left.score),
    weakMatches: weakMatches.sort((left, right) => right.score - left.score)
  };
}

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function buildNotificationScript(match: SuspiciousMatch): string {
  const title = "WhatsCove";
  const subtitle = match.ruleLabel || "Suspicious spam detected";
  const body = match.text.slice(0, 140);
  const escape = (value: string) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  return `display notification "${escape(body)}" with title "${escape(title)}" subtitle "${escape(subtitle)}"`;
}

async function notify(match: SuspiciousMatch): Promise<void> {
  await execFileAsync("osascript", ["-e", buildNotificationScript(match)]);
}

async function writeArtifacts(snapshot: MessageSnapshot, matches: SuspiciousMatch[]): Promise<void> {
  await ensureDataDir();
  await writeFile(
    LATEST_RESULTS_PATH,
    JSON.stringify(
      {
        fetchedAt: snapshot.fetchedAt,
        databasePath: snapshot.databasePath,
        matches
      },
      null,
      2
    )
  );

  if (matches.length === 0) {
    return;
  }

  const lines = matches
    .map((match) =>
      JSON.stringify({
        fetchedAt: snapshot.fetchedAt,
        databasePath: snapshot.databasePath,
        ...match
      })
    )
    .join("\n");

  await appendFile(ALERT_LOG_PATH, `${lines}\n`);
}

function summarizeMatch(match: SuspiciousMatch): string {
  return [
    `[score ${match.score.toFixed(3)}] ${match.ruleLabel || "spam rule"} | ${match.chatName || "unknown chat"} | ${match.senderName || match.fromJid || "unknown sender"} | ${match.messageTimeLocal || "unknown time"}`,
    `text: ${match.text}`,
    `why: ${match.reasons.join("; ")}`
  ].join("\n");
}

function summarizeWeakMatch(match: SuspiciousMatch): string {
  return [
    `[weak score ${match.score.toFixed(3)}] ${match.ruleLabel || "spam rule"} | ${match.chatName || "unknown chat"} | ${match.senderName || match.fromJid || "unknown sender"} | ${match.messageTimeLocal || "unknown time"}`,
    `text: ${match.text}`,
    `why: ${match.reasons.join("; ") || "low-confidence similarity to an active spam rule"}`
  ].join("\n");
}

export class WhatsAppSpamGuard {
  private readonly options: Required<Omit<SpamGuardOptions, "afterPk">>;
  private readonly seenFingerprints = new Set<string>();
  private lastSeenMessagePk: number;

  constructor(options: SpamGuardOptions = {}) {
    this.options = {
      minScore: Number(options.minScore ?? 0.72),
      weakMinScore: Number(options.weakMinScore ?? 0),
      pollMs: Number(options.pollMs ?? 30_000),
      notify: options.notify !== false,
      limit: Number(options.limit ?? 250),
      lookbackHours: Number(options.lookbackHours ?? 24),
      chatFilter: options.chatFilter ?? "",
      rules: options.rules ?? [],
      rulesPath: options.rulesPath ?? "",
      moderationPolicy: options.moderationPolicy ?? {
        policyPath: "",
        enabled: false,
        mode: "detect",
        actions: [],
        ignoreLocallyBannedUsers: true,
        hookCommand: "",
        perRule: {}
      }
    };
    this.lastSeenMessagePk = Number(options.afterPk ?? 0);
  }

  async scanOnce(): Promise<ScanResult> {
    const snapshot = await fetchRecentMessages({
      afterPk: this.lastSeenMessagePk,
      limit: this.options.limit,
      lookbackHours: this.options.lookbackHours,
      chatFilter: this.options.chatFilter
    });
    const { matches, weakMatches } = await findSuspiciousEntries(snapshot, {
      minScore: this.options.minScore,
      weakMinScore: this.options.weakMinScore,
      rules: this.options.rules
    });
    const maxSeenPk = snapshot.messages.reduce(
      (highest, message) => Math.max(highest, Number(message.messagePk || 0)),
      this.lastSeenMessagePk
    );
    this.lastSeenMessagePk = maxSeenPk;
    const freshMatches = matches.filter((match) => !this.seenFingerprints.has(match.fingerprint));
    const freshWeakMatches = weakMatches.filter(
      (match) => !this.seenFingerprints.has(match.fingerprint)
    );
    const moderationDecisions = await handleModeration(
      freshMatches,
      this.options.moderationPolicy
    );

    for (const match of freshMatches) {
      this.seenFingerprints.add(match.fingerprint);
    }
    for (const match of freshWeakMatches) {
      this.seenFingerprints.add(match.fingerprint);
    }

    await writeArtifacts(snapshot, matches);

    if (this.options.notify) {
      for (const match of freshMatches) {
        try {
          await notify(match);
        } catch (error) {
          console.warn(
            `WhatsCove notification failed for ${match.ruleId ?? "unknown-rule"}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    return {
      snapshot,
      matches,
      freshMatches,
      weakMatches,
      freshWeakMatches,
      rulesPath: this.options.rulesPath,
      ruleCount: this.options.rules.length,
      moderationDecisions
    };
  }

  async watch(onIteration?: (result: ScanResult) => void | Promise<void>): Promise<never> {
    for (;;) {
      const result = await this.scanOnce();
      if (typeof onIteration === "function") {
        await onIteration(result);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.options.pollMs);
      });
    }
  }
}

export function formatScanOutput(result: Pick<ScanResult, "matches">): string {
  if (result.matches.length === 0) {
    return "No suspicious messages matched the active spam rules in the recent WhatsApp message database scan.";
  }

  return result.matches.map(summarizeMatch).join("\n\n");
}

export function formatWeakScanOutput(result: Pick<ScanResult, "weakMatches">): string {
  if (result.weakMatches.length === 0) {
    return "No weak spam-rule matches met the testing threshold in the recent WhatsApp message database scan.";
  }

  return result.weakMatches.map(summarizeWeakMatch).join("\n\n");
}
