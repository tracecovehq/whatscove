import { readFile } from "node:fs/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  WhatsAppSpamGuard,
  findSuspiciousEntries,
  formatScanOutput,
  formatWeakScanOutput,
  sortMatchesChronologically
} from "./bot.ts";
import { coerceFixtureSnapshot } from "./fixture.ts";
import { preflightBundledModerationHook } from "./moderation.ts";
import { loadModerationPolicy } from "./moderation-policy.ts";
import { appendSpamRule, loadSpamRules } from "./spam-rules.ts";
import type { MessageSnapshot, ModerationDecision, SuspiciousMatch } from "./types.ts";

type CliCommand = "scan" | "watch" | "add-rule" | "fixture";

interface ParsedArgs {
  command: CliCommand;
  minScore?: number;
  weakMinScore?: number;
  pollMs: number;
  notify: boolean;
  json: boolean;
  limit: number;
  lookbackHours: number;
  chatFilter: string;
  rulesPath: string;
  ruleId: string;
  ruleLabel: string;
  template: string;
  templateFile: string;
  fixtureFile: string;
  anchorPhrases: string[];
  tags: string[];
  requireInviteLink: boolean;
  moderationPolicyPath: string;
  moderationMode: "detect" | "queue" | "apply" | "";
}

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  red: "\u001B[31m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  blue: "\u001B[34m",
  magenta: "\u001B[35m",
  cyan: "\u001B[36m"
} as const;

type WatchEntryStyle = "strong" | "weak" | "system";
type MarkerTone = "info" | "error" | "success" | "warning";

function parseOptionalNumber(value: string | undefined, flag: string): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${flag}: ${value}`);
  }

  return parsed;
}

function parseStringArray(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function parseModerationMode(
  value: string | undefined
): "detect" | "queue" | "apply" | "" {
  if (typeof value !== "string" || value === "") {
    return "";
  }

  if (value === "detect" || value === "queue" || value === "apply") {
    return value;
  }

  throw new Error(`Invalid value for --moderation-mode: ${value}`);
}

function formatModerationDecision(decision: ModerationDecision): string {
  const error = decision.error ? ` (${decision.error})` : "";
  return `${decision.action}:${decision.status}${error}`;
}

type WatchStreamEntry = {
  kind: "suspicious" | "weak";
  match: SuspiciousMatch;
};

function compareWatchStreamEntries(left: WatchStreamEntry, right: WatchStreamEntry): number {
  const leftTime = left.match.messageTimeLocal || "";
  const rightTime = right.match.messageTimeLocal || "";
  if (leftTime !== rightTime) {
    return leftTime.localeCompare(rightTime);
  }

  return left.match.messagePk - right.match.messagePk;
}

function buildChronologicalWatchStream(
  freshMatches: SuspiciousMatch[],
  freshWeakMatches: SuspiciousMatch[]
): WatchStreamEntry[] {
  return [
    ...freshMatches.map((match) => ({ kind: "suspicious" as const, match })),
    ...freshWeakMatches.map((match) => ({ kind: "weak" as const, match }))
  ].sort(compareWatchStreamEntries);
}

function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null;
}

function colorize(text: string, ...codes: string[]): string {
  if (!supportsColor() || codes.length === 0) {
    return text;
  }

  return `${codes.join("")}${text}${ANSI.reset}`;
}

function colorizeLinePrefix(line: string, prefix: string, ...codes: string[]): string {
  return line.startsWith(prefix)
    ? `${colorize(prefix, ...codes)}${line.slice(prefix.length)}`
    : line;
}

function classifyWatchEntry(entry: WatchStreamEntry): WatchEntryStyle {
  if (entry.kind === "suspicious") {
    return "strong";
  }

  if (
    entry.match.ruleId == null ||
    entry.match.ruleLabel === "No spam rule signal" ||
    entry.match.messageType !== 0 ||
    entry.match.text.startsWith("WhatsApp ")
  ) {
    return "system";
  }

  return "weak";
}

function formatMarker(label: string): string {
  return `${label.padEnd(5, " ")} `;
}

function styleConfig(kind: WatchEntryStyle): {
  indicator: string;
  titleCodes: string[];
} {
  switch (kind) {
    case "strong":
      return {
        indicator: formatMarker("SPAM"),
        titleCodes: [ANSI.bold, ANSI.red]
      };
    case "weak":
      return {
        indicator: formatMarker("WEAK"),
        titleCodes: [ANSI.bold, ANSI.yellow]
      };
    case "system":
      return {
        indicator: formatMarker("SYS"),
        titleCodes: [ANSI.bold, ANSI.cyan]
      };
  }
}

function renderWatchEntry(entry: WatchStreamEntry): string {
  const raw =
    entry.kind === "suspicious"
      ? formatScanOutput({ matches: [entry.match] })
      : formatWeakScanOutput({ weakMatches: [entry.match] });
  const style = classifyWatchEntry(entry);
  const config = styleConfig(style);
  const lines = raw.split("\n");

  if (lines.length > 0) {
    if (style === "system") {
      lines[0] = lines[0].replace(/^Weak testing match\b/, "System message");
    }
    lines[0] = `${colorize(config.indicator, ...config.titleCodes)} ${colorize(lines[0], ...config.titleCodes)}`;
  }

  for (let index = 1; index < lines.length; index += 1) {
    lines[index] = colorizeLinePrefix(lines[index], "Time:", ANSI.bold, ANSI.blue);
    lines[index] = colorizeLinePrefix(lines[index], "Message:", ANSI.bold);
    lines[index] = colorizeLinePrefix(lines[index], "Why:", ANSI.bold, ANSI.magenta);
    lines[index] = colorizeLinePrefix(lines[index], "Matched phrases:", ANSI.bold, ANSI.yellow);
    if (/^-{10,}$/.test(lines[index] ?? "")) {
      lines[index] = colorize(lines[index] ?? "", ANSI.dim);
    }
  }

  return lines.join("\n");
}

function markerCodes(tone: MarkerTone): string[] {
  switch (tone) {
    case "info":
      return [ANSI.bold, ANSI.cyan];
    case "error":
      return [ANSI.bold, ANSI.red];
    case "success":
      return [ANSI.bold, ANSI.green];
    case "warning":
      return [ANSI.bold, ANSI.yellow];
  }
}

function renderStatusLine(label: string, prefix: string, message: string, tone: MarkerTone): string {
  return `${colorize(formatMarker(label), ...markerCodes(tone))} ${colorize(prefix, ANSI.dim)} ${message}`;
}

function renderInfoLine(prefix: string, message: string): string {
  return renderStatusLine("INFO", prefix, message, "info");
}

function renderErrorLine(prefix: string, message: string): string {
  return renderStatusLine("ERROR", prefix, colorize(message, ANSI.red), "error");
}

function renderModerationSummary(prefix: string, decisions: ModerationDecision[]): string {
  const hasFailed = decisions.some((decision) => decision.status === "failed");
  const hasApplied = decisions.some((decision) => decision.status === "applied");
  const label = hasFailed ? "ACTION" : "APPLY";
  const tone: MarkerTone = hasFailed ? "error" : hasApplied ? "success" : "warning";

  return renderStatusLine(
    label,
    prefix,
    `moderation decisions: ${decisions.map(formatModerationDecision).join(", ")}`,
    tone
  );
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const [firstArg, ...restArgs] = argv;
  const hasExplicitCommand =
    firstArg === "scan" || firstArg === "watch" || firstArg === "add-rule" || firstArg === "fixture";
  const command: CliCommand = hasExplicitCommand ? firstArg : "scan";
  const args = hasExplicitCommand ? restArgs : argv;

  const { values, positionals } = parseNodeArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
      "no-notify": { type: "boolean", default: false },
      "require-invite-link": { type: "boolean", default: false },
      "moderation-policy": { type: "string" },
      "moderation-mode": { type: "string" },
      "min-score": { type: "string" },
      "weak-min-score": { type: "string" },
      "poll-seconds": { type: "string" },
      limit: { type: "string" },
      "lookback-hours": { type: "string" },
      chat: { type: "string" },
      rules: { type: "string" },
      id: { type: "string" },
      label: { type: "string" },
      template: { type: "string" },
      "template-file": { type: "string" },
      "fixture-file": { type: "string" },
      anchor: { type: "string", multiple: true },
      tag: { type: "string", multiple: true }
    }
  });

  if (positionals.length > 0) {
    throw new Error(`Unexpected argument: ${positionals.join(" ")}`);
  }

  const pollSeconds = parseOptionalNumber(values["poll-seconds"], "--poll-seconds");

  return {
    command,
    minScore: parseOptionalNumber(values["min-score"], "--min-score"),
    weakMinScore: parseOptionalNumber(values["weak-min-score"], "--weak-min-score"),
    pollMs: (pollSeconds ?? 30) * 1000,
    notify: !values["no-notify"],
    json: values.json,
    limit: parseOptionalNumber(values.limit, "--limit") ?? 250,
    lookbackHours: parseOptionalNumber(values["lookback-hours"], "--lookback-hours") ?? 24,
    chatFilter: values.chat ?? "",
    rulesPath: values.rules ?? "",
    ruleId: values.id ?? "",
    ruleLabel: values.label ?? "",
    template: values.template ?? "",
    templateFile: values["template-file"] ?? "",
    fixtureFile: values["fixture-file"] ?? "",
    anchorPhrases: parseStringArray(values.anchor),
    tags: parseStringArray(values.tag),
    requireInviteLink: values["require-invite-link"],
    moderationPolicyPath: values["moderation-policy"] ?? "",
    moderationMode: parseModerationMode(values["moderation-mode"])
  };
}

async function readTemplateText(args: ParsedArgs): Promise<string> {
  if (args.templateFile) {
    return readFile(args.templateFile, "utf8");
  }

  return args.template;
}

async function readFixtureSnapshot(args: ParsedArgs): Promise<MessageSnapshot> {
  if (!args.fixtureFile) {
    throw new Error("The fixture command requires --fixture-file <path>.");
  }

  const raw = await readFile(args.fixtureFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse fixture JSON from ${args.fixtureFile}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return coerceFixtureSnapshot(parsed, args.fixtureFile);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.command === "add-rule") {
    const template = await readTemplateText(args);
    const result = await appendSpamRule(
      {
        id: args.ruleId || undefined,
        label: args.ruleLabel,
        template,
        anchorPhrases: args.anchorPhrases,
        minScore: typeof args.minScore === "number" ? args.minScore : undefined,
        requireInviteLink: args.requireInviteLink,
        tags: args.tags
      },
      {
        rulesPath: args.rulesPath || undefined
      }
    );

    console.log(`Added rule "${result.rule.label}" (${result.rule.id}) to ${result.rulesPath}`);
    console.log(`Rules in file: ${result.ruleCount}`);
    return;
  }

  const loadedRules = await loadSpamRules({
    rulesPath: args.rulesPath || undefined
  });
  const moderationPolicy = await loadModerationPolicy({
    policyPath: args.moderationPolicyPath || undefined
  });
  if (args.moderationMode) {
    moderationPolicy.mode = args.moderationMode;
  }

  const effectiveMinScore = args.minScore ?? 0.72;
  const effectiveWeakMinScore = args.weakMinScore;

  if (args.command === "fixture") {
    const snapshot = await readFixtureSnapshot(args);
    const { matches, weakMatches } = await findSuspiciousEntries(snapshot, {
      minScore: effectiveMinScore,
      weakMinScore: effectiveWeakMinScore,
      rules: loadedRules.rules
    });

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            fetchedAt: snapshot.fetchedAt,
            databasePath: snapshot.databasePath,
            rulesPath: loadedRules.rulesPath,
            ruleCount: loadedRules.rules.length,
            scannedMessages: snapshot.messages.length,
            matchCount: matches.length,
            weakMatchCount: weakMatches.length,
            matches,
            weakMatches
          },
          null,
          2
        )
      );
      return;
    }

    const watchStream = buildChronologicalWatchStream(
      sortMatchesChronologically(matches),
      sortMatchesChronologically(weakMatches)
    );
    console.log(
      renderInfoLine(
        "[fixture]",
        `Loaded ${snapshot.messages.length} fixture message(s) from ${args.fixtureFile}`
      )
    );

    if (watchStream.length === 0) {
      console.log(renderInfoLine("[fixture]", "No spam-rule matches met the active thresholds."));
      return;
    }

    for (const entry of watchStream) {
      console.log(renderWatchEntry(entry));
    }
    return;
  }

  const bot = new WhatsAppSpamGuard({
    minScore: effectiveMinScore,
    weakMinScore: effectiveWeakMinScore,
    pollMs: args.pollMs,
    notify: args.notify,
    limit: args.limit,
    lookbackHours: args.lookbackHours,
    chatFilter: args.chatFilter,
    rules: loadedRules.rules,
    rulesPath: loadedRules.rulesPath,
    moderationPolicy
  });

  if (args.command === "watch") {
    const moderationPreflightError = await preflightBundledModerationHook(moderationPolicy);
    console.log(
      renderInfoLine(
        "[watch]",
        `Watching WhatsApp every ${(args.pollMs / 1000).toFixed(0)}s with minimum score ${effectiveMinScore.toFixed(2)} across ${loadedRules.rules.length} spam rule(s)${
          typeof effectiveWeakMinScore === "number"
            ? ` and weak-match logging from ${effectiveWeakMinScore.toFixed(2)}`
            : ""
        }`
      )
    );
    if (moderationPreflightError) {
      console.warn(
        renderErrorLine(
          "[preflight]",
          `bundled moderation hook is not ready: ${moderationPreflightError}`
        )
      );
    }

    await bot.watch((result) => {
      const prefix = `[${new Date().toISOString()}]`;
      const chronologicalFreshMatches = sortMatchesChronologically(result.freshMatches);
      const chronologicalFreshWeakMatches = sortMatchesChronologically(result.freshWeakMatches);
      const watchStream = buildChronologicalWatchStream(
        chronologicalFreshMatches,
        chronologicalFreshWeakMatches
      );

      if (watchStream.length === 0) {
        console.log(renderInfoLine(prefix, "scan complete, no new spam-rule matches."));
        return;
      }

      console.log(
        renderInfoLine(
          prefix,
          `${watchStream.length} new log entr${watchStream.length === 1 ? "y" : "ies"}:`
        )
      );
      for (const entry of watchStream) {
        console.log(renderWatchEntry(entry));
      }

      if (result.moderationDecisions.length > 0) {
        console.log(renderModerationSummary(prefix, result.moderationDecisions));
      }
    });
    return;
  }

  const result = await bot.scanOnce();
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          fetchedAt: result.snapshot.fetchedAt,
          databasePath: result.snapshot.databasePath,
          rulesPath: result.rulesPath,
          ruleCount: result.ruleCount,
          moderationDecisions: result.moderationDecisions,
          scannedMessages: result.snapshot.messages.length,
          matchCount: result.matches.length,
          freshMatchCount: result.freshMatches.length,
          weakMatchCount: result.weakMatches.length,
          freshWeakMatchCount: result.freshWeakMatches.length,
          matches: result.matches,
          freshMatches: result.freshMatches,
          weakMatches: result.weakMatches,
          freshWeakMatches: result.freshWeakMatches
        },
        null,
        2
      )
    );
    return;
  }

  console.log(formatScanOutput(result));
  if (typeof effectiveWeakMinScore === "number") {
    console.log("");
    console.log(formatWeakScanOutput(result));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
