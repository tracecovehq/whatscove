import { readFile } from "node:fs/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  WhatsAppSpamGuard,
  formatScanOutput,
  formatWeakScanOutput,
  sortMatchesChronologically
} from "./bot.ts";
import { preflightBundledModerationHook } from "./moderation.ts";
import { loadModerationPolicy } from "./moderation-policy.ts";
import { appendSpamRule, loadSpamRules } from "./spam-rules.ts";
import type { ModerationDecision, SuspiciousMatch } from "./types.ts";

type CliCommand = "scan" | "watch" | "add-rule";

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
  anchorPhrases: string[];
  tags: string[];
  requireInviteLink: boolean;
  moderationPolicyPath: string;
  moderationMode: "detect" | "queue" | "apply" | "";
}

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

function parseCliArgs(argv: string[]): ParsedArgs {
  const [firstArg, ...restArgs] = argv;
  const hasExplicitCommand =
    firstArg === "scan" || firstArg === "watch" || firstArg === "add-rule";
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
      `Watching WhatsApp every ${(args.pollMs / 1000).toFixed(0)}s with minimum score ${effectiveMinScore.toFixed(2)} across ${loadedRules.rules.length} spam rule(s)${
        typeof effectiveWeakMinScore === "number"
          ? ` and weak-match logging from ${effectiveWeakMinScore.toFixed(2)}`
          : ""
      }`
    );
    if (moderationPreflightError) {
      console.warn(`[preflight] bundled moderation hook is not ready: ${moderationPreflightError}`);
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
        console.log(`${prefix} scan complete, no new spam-rule matches.`);
        return;
      }

      console.log(
        `${prefix} ${watchStream.length} new log entr${watchStream.length === 1 ? "y" : "ies"}:`
      );
      for (const entry of watchStream) {
        if (entry.kind === "suspicious") {
          console.log(formatScanOutput({ matches: [entry.match] }));
          continue;
        }

        console.log(formatWeakScanOutput({ weakMatches: [entry.match] }));
      }

      if (result.moderationDecisions.length > 0) {
        console.log(
          `${prefix} moderation decisions: ${result.moderationDecisions
            .map(formatModerationDecision)
            .join(", ")}`
        );
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
