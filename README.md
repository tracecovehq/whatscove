# WhatsCove

A small macOS bot for detecting recurring WhatsApp spam patterns from a dynamic rule list.

It reads WhatsApp Desktop's local `ChatStorage.sqlite`, scores message text against the active spam rules, and writes alerts to local files so you can review or act on them.

It can also auto-moderate matches through a moderation policy: queue moderation decisions and in `apply` mode either invoke a custom hook or fall back to the bundled WhatsApp Desktop accessibility hook for destructive actions like message deletion and sender removal.

## What it catches

- The default stock-advice spam rule shipped with the project.
- Close paraphrases of any configured spam pitch.
- Multiple independent spam families at once, as long as they are listed in the rules file.

## How it works

1. `src/whatsapp-db.ts` queries WhatsApp Desktop's local `ChatStorage.sqlite`.
2. `src/detection.ts` normalizes text, strips links, and scores each message-like string against every active spam rule.
3. `src/bot.ts` logs matches to `data/latest-suspects.json`, appends machine-readable entries to `data/spam-alerts.jsonl`, writes human-readable summaries to `data/spam-alerts.log`, and can optionally show macOS notifications for new hits.
4. `src/moderation.ts` turns fresh matches into moderation decisions and either logs, queues, or applies them based on the moderation policy.

## Rules

The default rules live in [spam-rules.yaml](/Users/jlukanta/Projects/tracecove/whatscove/config/spam-rules.yaml), and WhatsCove also supports `spam-rules.json` / `spam-rules.yml`.

Each rule can define:

- `id`: stable identifier for the rule
- `label`: human-friendly name shown in alerts
- `template`: the canonical spam text to compare against
- `examples`: optional shorter or alternate phrasings from the same spam family
- `anchorPhrases`: optional phrases that strengthen a match
- `signalBuckets`: optional intent buckets such as topic, promo language, and join calls-to-action
- `structuralPatterns`: optional recipes that require multiple hits across named signal buckets, such as three finance-topic terms plus two promo-language terms plus a join CTA and an invite link
- `minScore`: optional per-rule threshold override
- `requireInviteLink`: optional flag for invite-link-heavy spam
- `tags`: optional metadata for downstream automation

You can add as many rules as you want to that file, or point the CLI at a different JSON or YAML file with the same shape.

## Moderation

The default moderation policy lives in [moderation-policy.yaml](/Users/jlukanta/Projects/tracecove/whatscove/config/moderation-policy.yaml), and WhatsCove also supports `moderation-policy.json` / `moderation-policy.yml`.

Supported moderation actions:

- `delete_message`
- `remove_sender`
- `notify`

Modes:

- `detect`: log moderation decisions only
- `queue`: write moderation decisions to the queue without executing destructive actions
- `apply`: invoke either a custom hook or the bundled WhatsApp Desktop hook for destructive actions

Moderation data files:

- `data/moderation-queue.jsonl`: queued moderation actions waiting for a human or external executor
- `data/moderation-events.jsonl`: audit log of moderation decisions
- `data/moderation-state.json`: processed decision ids and any historical local ban state

Important:

- If `hookCommand` is empty, `apply` mode falls back to the bundled [whatsapp-hook.swift](/Users/jlukanta/Projects/tracecove/whatscove/src/whatsapp-hook.swift) executor.
- `delete_message` and `remove_sender` in the bundled hook are best-effort WhatsApp Desktop accessibility automations. They depend on your admin permissions in the chat and on WhatsApp’s current macOS UI labels.
- The default policy does not use local bans, so moderators can keep seeing repeat spam if delete/remove actions fail.

## Requirements

- macOS
- Node.js 24+ recommended
- macOS Accessibility permission granted to your terminal or Node runtime for `apply` mode
- Xcode Command Line Tools or Swift runtime available for the bundled hook
- WhatsApp Desktop signed in on this Mac
- Read access to the local WhatsApp container

## Usage

Run a one-off scan:

```bash
cd /Users/jlukanta/Projects/tracecove/whatscove
node --experimental-strip-types ./src/cli.ts scan
```

Run a continuous watcher:

```bash
cd /Users/jlukanta/Projects/tracecove/whatscove
node --experimental-strip-types ./src/cli.ts watch --poll-seconds 20
```

Run a watcher that also prints weak testing matches without treating them as real spam:

```bash
cd /Users/jlukanta/Projects/tracecove/whatscove
node --experimental-strip-types ./src/cli.ts watch --poll-seconds 20 --weak-min-score 0.10
```

Run with queued auto-moderation:

```bash
node --experimental-strip-types ./src/cli.ts watch --poll-seconds 20 --moderation-mode queue
```

Run with apply mode and a custom moderation policy:

```bash
node --experimental-strip-types ./src/cli.ts watch \
  --poll-seconds 20 \
  --moderation-mode apply \
  --moderation-policy /absolute/path/to/moderation-policy.yaml
```

Append a new spam rule from the terminal:

```bash
cd /Users/jlukanta/Projects/tracecove/whatscove
node --experimental-strip-types ./src/cli.ts add-rule \
  --label "Crypto signal promo" \
  --template "Join our free crypto signal team for daily bitcoin calls and market updates" \
  --anchor "free crypto signal team" \
  --anchor "daily bitcoin calls" \
  --tag crypto \
  --require-invite-link
```

For long spam bodies, keep the template in a text file:

```bash
node --experimental-strip-types ./src/cli.ts add-rule \
  --label "Stock invite variant" \
  --template-file /absolute/path/to/template.txt \
  --anchor "us stock knowledge" \
  --anchor "greater returns"
```

Useful flags:

- `--min-score 0.80` makes the detector stricter.
- `--weak-min-score 0.10` prints low-confidence testing matches to the console and JSON output without triggering moderation.
- `--no-notify` disables macOS notifications.
- `--json` prints the full scan result as JSON for automation.
- `--chat "East Bay"` limits the scan to one community or group name.
- `--lookback-hours 6` restricts the initial scan window.
- `--rules /absolute/path/to/spam-rules.yaml` loads a custom dynamic rule list.
- `--rules /absolute/path/to/spam-rules.json` also works for JSON rule files.
- `--moderation-policy /absolute/path/to/moderation-policy.yaml` loads a moderation policy.
- `--moderation-policy /absolute/path/to/moderation-policy.json` also works for JSON policy files.
- `--moderation-mode detect|queue|apply` controls whether matches just log, queue, or execute moderation actions.
- `add-rule --label ... --template ...` appends a new rule without hand-editing JSON.

## Notes

- This is a desktop-side detector, not an official server-side WhatsApp bot.
- By default it scans recent inbound WhatsApp messages from the local database, then watches only newly inserted rows on subsequent polls.
- The default rule pack is just a starting point. The intended workflow is to keep growing the rule list as new spam patterns appear.
- Short hand-typed spam paraphrases work best when a rule includes both alternate `examples` and a few high-signal `signalBuckets`.
- Broad spam variants work best when `signalBuckets` describe the reusable ingredients and `structuralPatterns` describe how many ingredients must appear together.
- If both YAML and JSON versions of the same config exist, WhatsCove prefers YAML automatically.
- The safest default for moderation is `queue`, which records removal/ban decisions without executing destructive WhatsApp-side actions.
- The codebase now uses TypeScript source files and relies on Node's built-in strip-types runtime flag instead of a separate build step.
