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
const HUMAN_ALERT_LOG_PATH = path.join(DATA_DIR, "spam-alerts.log");
const WHATSAPP_IDENTIFIER_RE = /^[0-9]+@(?:s\.whatsapp\.net|lid|g\.us)$/i;

type NormalizedSpamGuardOptions = Required<
  Omit<SpamGuardOptions, "afterPk" | "weakMinScore">
> & {
  weakMinScore?: number;
};

function buildFingerprint(record: Record<string, unknown>): string {
  return createHash("sha1").update(JSON.stringify(record)).digest("hex").slice(0, 12);
}

function isWhatsAppIdentifierOnly(text: string): boolean {
  const parts = text
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 && parts.every((part) => WHATSAPP_IDENTIFIER_RE.test(part));
}

function describeGroupEventType(type: number | null | undefined): string {
  if (type === 2) {
    return "group membership update";
  }
  if (type === 7) {
    return "group participant removal or exit update";
  }

  return "group system update";
}

function describeCandidateText(row: MessageSnapshot["messages"][number], text: string): string {
  if (!isWhatsAppIdentifierOnly(text)) {
    return text;
  }

  const lines = [
    `WhatsApp ${describeGroupEventType(row.groupEventType)}`,
    `Raw participant id(s): ${text.split(/\s+/).filter(Boolean).join(", ")}`,
    `Message type: ${row.messageType}${
      typeof row.groupEventType === "number" ? ` | Group event type: ${row.groupEventType}` : ""
    }`
  ];

  if (row.groupMemberName || row.groupMemberJid) {
    lines.push(`Group member: ${row.groupMemberName || row.groupMemberJid}`);
  }
  if (row.toJid) {
    lines.push(`Target: ${row.toJid}`);
  }

  return lines.join("\n");
}

function getModerationSenderJid(row: MessageSnapshot["messages"][number]): string {
  return row.groupMemberJid || row.fromJid;
}

// Detection intentionally evaluates every message-like field, not just the visible body.
// WhatsApp spam often puts the CTA or invite pitch in link-preview metadata, so each
// database row can produce multiple text candidates. Only the strongest candidate per
// row is emitted to avoid moderating one physical message multiple times.
export async function findSuspiciousEntries(
  snapshot: MessageSnapshot,
  options: SpamDetectionOptions = {}
): Promise<{
  matches: SuspiciousMatch[];
  weakMatches: SuspiciousMatch[];
}> {
  const minScore = Number(options.minScore ?? 0.72);
  const weakMinScore =
    typeof options.weakMinScore === "number"
      ? options.weakMinScore
      : undefined;
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
    const rowMatches: SuspiciousMatch[] = [];
    const rowWeakMatches: SuspiciousMatch[] = [];

    for (const text of candidates) {
      const result = await detectSpam(text, { minScore, rules });
      const isZeroSignal = result.score <= 0;
      const candidateMatch = {
        fingerprint: buildFingerprint({
          messagePk: row.messagePk,
          messageTimeLocal: row.messageTimeLocal,
          chatName: row.chatName,
          senderName: row.senderName,
          ruleId: isZeroSignal ? "no-rule-signal" : result.ruleId,
          text
        }),
        messagePk: row.messagePk,
        chatName: row.chatName,
        chatJid: row.chatJid,
        senderName: row.senderName,
        fromJid: getModerationSenderJid(row),
        senderIsAdmin: Boolean(row.senderIsAdmin),
        messageType: row.messageType,
        messageTimeLocal: row.messageTimeLocal,
        ruleId: isZeroSignal ? undefined : result.ruleId,
        ruleLabel: isZeroSignal ? "No spam rule signal" : result.ruleLabel,
        text: describeCandidateText(row, text),
        score: Number(result.score.toFixed(3)),
        reasons:
          isZeroSignal && result.reasons.length === 0
            ? ["Debug candidate only; no detector signals matched."]
            : result.reasons,
        details: isZeroSignal ? undefined : result.details
      };

      if (result.matched) {
        rowMatches.push(candidateMatch);
        continue;
      }

      if (typeof weakMinScore !== "number" || candidateMatch.score < weakMinScore) {
        continue;
      }

      rowWeakMatches.push(candidateMatch);
    }

    if (rowMatches.length > 0) {
      matches.push(rowMatches.sort((left, right) => right.score - left.score)[0] as SuspiciousMatch);
    } else if (rowWeakMatches.length > 0) {
      weakMatches.push(rowWeakMatches.sort((left, right) => right.score - left.score)[0] as SuspiciousMatch);
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

function shortenJid(jid: string | undefined): string {
  if (!jid) {
    return "unknown";
  }

  if (jid.length <= 20) {
    return jid;
  }

  return `${jid.slice(0, 8)}...${jid.slice(-10)}`;
}

function describeSender(match: SuspiciousMatch): string {
  const senderName = match.senderName?.trim();
  if (senderName && senderName !== match.fromJid) {
    return `${senderName} (${shortenJid(match.fromJid)})`;
  }

  return shortenJid(match.fromJid);
}

function confidenceLabel(score: number): string {
  if (score >= 0.9) {
    return "very high";
  }
  if (score >= 0.75) {
    return "high";
  }
  if (score >= 0.5) {
    return "medium";
  }
  return "low";
}

function toPercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function formatReasonList(reasons: string[]): string {
  if (reasons.length === 0) {
    return "No specific detection signals were recorded.";
  }

  return reasons.join("; ");
}

function compareMatchesChronologically(left: SuspiciousMatch, right: SuspiciousMatch): number {
  const leftTime = left.messageTimeLocal || "";
  const rightTime = right.messageTimeLocal || "";
  if (leftTime !== rightTime) {
    return leftTime.localeCompare(rightTime);
  }

  return left.messagePk - right.messagePk;
}

export function sortMatchesChronologically(matches: SuspiciousMatch[]): SuspiciousMatch[] {
  return [...matches].sort(compareMatchesChronologically);
}

function formatHumanLogEntry(
  match: SuspiciousMatch,
  options: {
    fetchedAt?: string;
    label?: string;
    includeFingerprint?: boolean;
  } = {}
): string {
  const label = options.label ?? "Spam match";
  const lines = [
    `${label} | ${match.ruleLabel || "spam rule"} | ${toPercent(match.score)} confidence (${confidenceLabel(match.score)})`,
    `Time: ${match.messageTimeLocal || "unknown"} | Chat: ${match.chatName || "unknown"} | Sender: ${describeSender(match)}`,
    `Message: ${match.text}`,
    `Why: ${formatReasonList(match.reasons)}`
  ];

  if ((match.details?.matchedPhrases.length ?? 0) > 0) {
    lines.push(`Matched phrases: ${match.details?.matchedPhrases.join(", ")}`);
  }

  if (options.includeFingerprint) {
    lines.push(`Fingerprint: ${match.fingerprint}`);
  }

  if (options.fetchedAt) {
    lines.push(`Scanned at: ${options.fetchedAt}`);
  }

  return `${lines.join("\n")}\n${"-".repeat(72)}\n`;
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
  const humanLog = matches
    .map((match) =>
      formatHumanLogEntry(match, {
        fetchedAt: snapshot.fetchedAt,
        includeFingerprint: true
      })
    )
    .join("\n");
  await appendFile(HUMAN_ALERT_LOG_PATH, humanLog);
}

function summarizeMatch(match: SuspiciousMatch): string {
  return formatHumanLogEntry(match, {
    label: "Spam match"
  }).trimEnd();
}

function summarizeWeakMatch(match: SuspiciousMatch): string {
  return formatHumanLogEntry(
    {
      ...match,
      reasons:
        match.reasons.length > 0
          ? match.reasons
          : ["Low-confidence similarity to an active spam rule."]
    },
    {
      label: "Weak testing match"
    }
  ).trimEnd();
}

export class WhatsAppSpamGuard {
  private readonly options: NormalizedSpamGuardOptions;
  private readonly seenFingerprints = new Set<string>();
  private lastSeenMessagePk: number;

  constructor(options: SpamGuardOptions = {}) {
    this.options = {
      minScore: Number(options.minScore ?? 0.72),
      weakMinScore:
        typeof options.weakMinScore === "number" ? Number(options.weakMinScore) : undefined,
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
        ignoreLocallyBannedUsers: false,
        skipAdminSenders: true,
        retryFailedActions: false,
        retryFailedActionsLookbackHours: 24,
        captureActionScreenshots: false,
        screenshotDirectory: "",
        hookCommand: "",
        perRule: {}
      }
    };
    this.lastSeenMessagePk = Number(options.afterPk ?? 0);
  }

  async scanOnce(): Promise<ScanResult> {
    // `lastSeenMessagePk` controls database polling, while `seenFingerprints`
    // controls process-local duplicate logging/moderation. Keep them separate:
    // a repeated spam template from a different WhatsApp row should still be a
    // new event because the fingerprint includes messagePk and messageTimeLocal.
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
    const duplicateMatches = matches.filter((match) => this.seenFingerprints.has(match.fingerprint));
    const freshWeakMatches = weakMatches.filter(
      (match) => !this.seenFingerprints.has(match.fingerprint)
    );
    const duplicateWeakMatches = weakMatches.filter(
      (match) => this.seenFingerprints.has(match.fingerprint)
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
      duplicateMatches,
      weakMatches,
      freshWeakMatches,
      duplicateWeakMatches,
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
