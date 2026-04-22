import { WhatsAppSpamGuard, formatScanOutput } from "./bot.mjs";
import { appendSpamRule, loadSpamRules } from "./spam-rules.mjs";

function parseArgs(argv) {
  const parsed = {
    command: "scan",
    minScore: undefined,
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
    requireInviteLink: false
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

    if (flag === "--min-score") {
      parsed.minScore = Number(flags[index + 1]);
      index += 1;
      continue;
    }

    if (flag === "--poll-seconds") {
      parsed.pollMs = Number(flags[index + 1]) * 1000;
      index += 1;
      continue;
    }

    if (flag === "--limit") {
      parsed.limit = Number(flags[index + 1]);
      index += 1;
      continue;
    }

    if (flag === "--lookback-hours") {
      parsed.lookbackHours = Number(flags[index + 1]);
      index += 1;
      continue;
    }

    if (flag === "--chat") {
      parsed.chatFilter = String(flags[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (flag === "--rules") {
      parsed.rulesPath = String(flags[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (flag === "--id") {
      parsed.ruleId = String(flags[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (flag === "--label") {
      parsed.ruleLabel = String(flags[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (flag === "--template") {
      parsed.template = String(flags[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (flag === "--template-file") {
      parsed.templateFile = String(flags[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (flag === "--anchor") {
      parsed.anchorPhrases.push(String(flags[index + 1] ?? ""));
      index += 1;
      continue;
    }

    if (flag === "--tag") {
      parsed.tags.push(String(flags[index + 1] ?? ""));
      index += 1;
      continue;
    }

    if (flag === "--require-invite-link") {
      parsed.requireInviteLink = true;
    }
  }

  return parsed;
}

async function readTemplateText(args) {
  if (args.templateFile) {
    const { readFile } = await import("node:fs/promises");
    return readFile(args.templateFile, "utf8");
  }

  return args.template;
}

async function main() {
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
  const bot = new WhatsAppSpamGuard({
    minScore: args.minScore ?? 0.72,
    pollMs: args.pollMs,
    notify: args.notify,
    limit: args.limit,
    lookbackHours: args.lookbackHours,
    chatFilter: args.chatFilter,
    rules: loadedRules.rules,
    rulesPath: loadedRules.rulesPath
  });

  if (args.command === "watch") {
    console.log(
      `Watching WhatsApp every ${(args.pollMs / 1000).toFixed(0)}s with minimum score ${(args.minScore ?? 0.72).toFixed(2)} across ${loadedRules.rules.length} spam rule(s)`
    );

    await bot.watch((result) => {
      const prefix = `[${new Date().toISOString()}]`;
      if (result.freshMatches.length === 0) {
        console.log(`${prefix} scan complete, no new spam-rule matches.`);
        return;
      }

      console.log(`${prefix} ${result.freshMatches.length} new suspicious message(s):`);
      for (const match of result.freshMatches) {
        console.log(formatScanOutput({ matches: [match] }));
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
          scannedMessages: result.snapshot.messages.length,
          matchCount: result.matches.length,
          freshMatchCount: result.freshMatches.length,
          matches: result.matches,
          freshMatches: result.freshMatches
        },
        null,
        2
      )
    );
    return;
  }

  console.log(formatScanOutput(result));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
