import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createTextCandidates, detectStockSpam } from "./detection.mjs";
import { fetchRecentMessages } from "./whatsapp-db.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA_DIR = path.join(PACKAGE_ROOT, "data");
const LATEST_RESULTS_PATH = path.join(DATA_DIR, "latest-suspects.json");
const ALERT_LOG_PATH = path.join(DATA_DIR, "spam-alerts.jsonl");

function buildFingerprint(record) {
  return createHash("sha1")
    .update(JSON.stringify(record))
    .digest("hex")
    .slice(0, 12);
}

export function findSuspiciousEntries(snapshot, options = {}) {
  const minScore = Number(options.minScore ?? 0.72);
  const matches = [];

  for (const row of snapshot.messages ?? []) {
    const candidates = createTextCandidates({
      value: row.text,
      name: row.previewTitle,
      description: [row.previewSummary, row.previewContent1, row.previewContent2]
        .filter(Boolean)
        .join("\n")
    });

    for (const text of candidates) {
      const result = detectStockSpam(text, { minScore });
      if (!result.matched) {
        continue;
      }

      matches.push({
        fingerprint: buildFingerprint({
          chatName: row.chatName,
          senderName: row.senderName,
          text
        }),
        messagePk: row.messagePk,
        chatName: row.chatName,
        chatJid: row.chatJid,
        senderName: row.senderName,
        fromJid: row.fromJid,
        messageType: row.messageType,
        messageTimeLocal: row.messageTimeLocal,
        text,
        score: Number(result.score.toFixed(3)),
        reasons: result.reasons,
        details: result.details
      });
    }
  }

  return matches.sort((left, right) => right.score - left.score);
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

function buildNotificationScript(match) {
  const title = "WhatsCove";
  const subtitle = match.description || match.name || "Suspicious stock spam detected";
  const body = match.text.slice(0, 140);

  const escape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `display notification "${escape(body)}" with title "${escape(title)}" subtitle "${escape(subtitle)}"`;
}

async function notify(match) {
  await execFileAsync("osascript", ["-e", buildNotificationScript(match)]);
}

async function writeArtifacts(snapshot, matches) {
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

function summarizeMatch(match) {
  return [
    `[score ${match.score.toFixed(3)}] ${match.chatName || "unknown chat"} | ${match.senderName || match.fromJid || "unknown sender"} | ${match.messageTimeLocal || "unknown time"}`,
    `text: ${match.text}`,
    `why: ${match.reasons.join("; ")}`
  ].join("\n");
}

export class WhatsAppSpamGuard {
  constructor(options = {}) {
    this.options = {
      minScore: Number(options.minScore ?? 0.72),
      pollMs: Number(options.pollMs ?? 30_000),
      notify: options.notify !== false,
      limit: Number(options.limit ?? 250),
      lookbackHours: Number(options.lookbackHours ?? 24),
      chatFilter: options.chatFilter ?? ""
    };
    this.seenFingerprints = new Set();
    this.lastSeenMessagePk = Number(options.afterPk ?? 0);
  }

  async scanOnce() {
    const snapshot = await fetchRecentMessages({
      afterPk: this.lastSeenMessagePk,
      limit: this.options.limit,
      lookbackHours: this.options.lookbackHours,
      chatFilter: this.options.chatFilter
    });
    const matches = findSuspiciousEntries(snapshot, {
      minScore: this.options.minScore
    });
    const maxSeenPk = snapshot.messages.reduce(
      (highest, message) => Math.max(highest, Number(message.messagePk || 0)),
      this.lastSeenMessagePk
    );
    this.lastSeenMessagePk = maxSeenPk;
    const freshMatches = matches.filter((match) => !this.seenFingerprints.has(match.fingerprint));

    for (const match of freshMatches) {
      this.seenFingerprints.add(match.fingerprint);
    }

    await writeArtifacts(snapshot, matches);

    if (this.options.notify) {
      for (const match of freshMatches) {
        await notify(match);
      }
    }

    return {
      snapshot,
      matches,
      freshMatches
    };
  }

  async watch(onIteration) {
    for (;;) {
      const result = await this.scanOnce();
      if (typeof onIteration === "function") {
        await onIteration(result);
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs));
    }
  }
}

export function formatScanOutput(result) {
  if (result.matches.length === 0) {
    return "No suspicious stock-spam messages were detected in the recent WhatsApp message database scan.";
  }

  return result.matches.map(summarizeMatch).join("\n\n");
}
