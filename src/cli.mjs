import { WhatsAppSpamGuard, formatScanOutput } from "./bot.mjs";

function parseArgs(argv) {
  const parsed = {
    command: "scan",
    minScore: 0.72,
    pollMs: 30_000,
    notify: true,
    json: false,
    limit: 250,
    lookbackHours: 24,
    chatFilter: ""
  };

  const [command, ...flags] = argv;
  if (command === "scan" || command === "watch") {
    parsed.command = command;
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
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bot = new WhatsAppSpamGuard({
    minScore: args.minScore,
    pollMs: args.pollMs,
    notify: args.notify,
    limit: args.limit,
    lookbackHours: args.lookbackHours,
    chatFilter: args.chatFilter
  });

  if (args.command === "watch") {
    console.log(
      `Watching WhatsApp every ${(args.pollMs / 1000).toFixed(0)}s with minimum score ${args.minScore.toFixed(2)}`
    );

    await bot.watch((result) => {
      const prefix = `[${new Date().toISOString()}]`;
      if (result.freshMatches.length === 0) {
        console.log(`${prefix} scan complete, no new stock-spam matches.`);
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
