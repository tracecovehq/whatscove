import { readFile } from "node:fs/promises";
import { WhatsAppSpamGuard, formatScanOutput, formatWeakScanOutput } from "./bot.ts";
import { loadModerationPolicy } from "./moderation-policy.ts";
import { appendSpamRule, loadSpamRules } from "./spam-rules.ts";

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

function readFlagValue(flags: string[], index: number, flag: string): string {
  const value = flags[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function readNumberFlag(flags: string[], index: number, flag: string): number {
  const rawValue = readFlagValue(flags, index, flag);
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value for ${flag}: ${rawValue}`);
  }

  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "scan",
    minScore: undefined,
    weakMinScore: undefined,
    pollMs: 30_000,
    notify: true,
    json: false,
    limit: 250,
    lookbackHours: 24,
    chatFilter: "",
    rulesPath: "",
    ruleId: "",
    ruleLabel: "",
    template: "",
    templateFile: "",
    anchorPhrases: [],
    tags: [],
    requireInviteLink: false,
    moderationPolicyPath: "",
    moderationMode: ""
  };

  const [firstArg, ...restArgs] = argv;
  const hasExplicitCommand =
    firstArg === "scan" || firstArg === "watch" || firstArg === "add-rule";
  const flags = hasExplicitCommand ? restArgs : argv;

  if (hasExplicitCommand) {
    parsed.command = firstArg;
  }

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--json") {
      parsed.json = true;
      continue;
    }

    if (flag === "--no-notify") {
      parsed.notify = false;
      continue;
    }

    if (flag === "--require-invite-link") {
      parsed.requireInviteLink = true;
      continue;
    }

    if (flag === "--moderation-policy") {
      parsed.moderationPolicyPath = readFlagValue(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--moderation-mode") {
      const mode = readFlagValue(flags, index, flag);
      if (mode !== "detect" && mode !== "queue" && mode !== "apply") {
        throw new Error(`Invalid value for ${flag}: ${mode}`);
      }
      parsed.moderationMode = mode;
      index += 1;
      continue;
    }

    if (flag === "--min-score") {
      parsed.minScore = readNumberFlag(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--weak-min-score") {
      parsed.weakMinScore = readNumberFlag(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--poll-seconds") {
      parsed.pollMs = readNumberFlag(flags, index, flag) * 1000;
      index += 1;
      continue;
    }

    if (flag === "--limit") {
      parsed.limit = readNumberFlag(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--lookback-hours") {
      parsed.lookbackHours = readNumberFlag(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--chat") {
      parsed.chatFilter = readFlagValue(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--rules") {
      parsed.rulesPath = readFlagValue(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--id") {
      parsed.ruleId = readFlagValue(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--label") {
      parsed.ruleLabel = readFlagValue(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--template") {
      parsed.template = readFlagValue(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--template-file") {
      parsed.templateFile = readFlagValue(flags, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--anchor") {
      parsed.anchorPhrases.push(readFlagValue(flags, index, flag));
      index += 1;
      continue;
    }

    if (flag === "--tag") {
      parsed.tags.push(readFlagValue(flags, index, flag));
      index += 1;
      continue;
    }

    throw new Error(`Unknown flag: ${flag}`);
  }

  return parsed;
}

async function readTemplateText(args: ParsedArgs): Promise<string> {
  if (args.templateFile) {
    return readFile(args.templateFile, "utf8");
  }

  return args.template;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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
      console.log(
        `Watching WhatsApp every ${(args.pollMs / 1000).toFixed(0)}s with minimum score ${effectiveMinScore.toFixed(2)} across ${loadedRules.rules.length} spam rule(s)${
          typeof effectiveWeakMinScore === "number"
            ? ` and weak-match logging from ${effectiveWeakMinScore.toFixed(2)}`
            : ""
        }`
      );

      await bot.watch((result) => {
        const prefix = `[${new Date().toISOString()}]`;
        if (result.freshMatches.length === 0 && result.freshWeakMatches.length === 0) {
          console.log(`${prefix} scan complete, no new spam-rule matches.`);
          return;
        }

      console.log(`${prefix} ${result.freshMatches.length} new suspicious message(s):`);
        for (const match of result.freshMatches) {
          console.log(formatScanOutput({ matches: [match] }));
        }
        if (result.freshWeakMatches.length > 0) {
          console.log(`${prefix} ${result.freshWeakMatches.length} weak testing match(es):`);
          for (const match of result.freshWeakMatches) {
            console.log(formatWeakScanOutput({ weakMatches: [match] }));
          }
        }
        if (result.moderationDecisions.length > 0) {
          console.log(
            `${prefix} moderation decisions: ${result.moderationDecisions
            .map((decision) => `${decision.action}:${decision.status}`)
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
