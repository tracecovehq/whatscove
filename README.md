# WhatsCove

A small macOS bot for detecting recurring WhatsApp spam patterns from a dynamic rule list.

It reads WhatsApp Desktop's local `ChatStorage.sqlite`, scores message text against the active spam rules, and writes alerts to local files so you can review or act on them.

## What it catches

- The default stock-advice spam rule shipped with the project.
- Close paraphrases of any configured spam pitch.
- Multiple independent spam families at once, as long as they are listed in the rules file.

## How it works

1. `src/whatsapp-db.mjs` queries WhatsApp Desktop's local `ChatStorage.sqlite`.
2. `src/detection.mjs` normalizes text, strips links, and scores each message-like string against every active spam rule.
3. `src/bot.mjs` logs matches to `data/latest-suspects.json` and `data/spam-alerts.jsonl`, and can optionally show macOS notifications for new hits.

## Rules

The default rules live in [config/spam-rules.json](/Users/jlukanta/Projects/tracecove/whatscove/config/spam-rules.json).

Each rule can define:

- `id`: stable identifier for the rule
- `label`: human-friendly name shown in alerts
- `template`: the canonical spam text to compare against
- `anchorPhrases`: optional phrases that strengthen a match
- `minScore`: optional per-rule threshold override
- `requireInviteLink`: optional flag for invite-link-heavy spam
- `tags`: optional metadata for downstream automation

You can add as many rules as you want to that file, or point the CLI at a different JSON file with the same shape.

## Requirements

- macOS
- Node.js 20+
- WhatsApp Desktop signed in on this Mac
- Read access to the local WhatsApp container

## Usage

Run a one-off scan:

```bash
cd /Users/jlukanta/Projects/tracecove/whatscove
node ./src/cli.mjs scan
```

Run a continuous watcher:

```bash
cd /Users/jlukanta/Projects/tracecove/whatscove
node ./src/cli.mjs watch --poll-seconds 20
```

Append a new spam rule from the terminal:

```bash
cd /Users/jlukanta/Projects/tracecove/whatscove
node ./src/cli.mjs add-rule \
  --label "Crypto signal promo" \
  --template "Join our free crypto signal team for daily bitcoin calls and market updates" \
  --anchor "free crypto signal team" \
  --anchor "daily bitcoin calls" \
  --tag crypto \
  --require-invite-link
```

For long spam bodies, keep the template in a text file:

```bash
node ./src/cli.mjs add-rule \
  --label "Stock invite variant" \
  --template-file /absolute/path/to/template.txt \
  --anchor "us stock knowledge" \
  --anchor "greater returns"
```

Useful flags:

- `--min-score 0.80` makes the detector stricter.
- `--no-notify` disables macOS notifications.
- `--json` prints the full scan result as JSON for automation.
- `--chat "East Bay"` limits the scan to one community or group name.
- `--lookback-hours 6` restricts the initial scan window.
- `--rules /absolute/path/to/spam-rules.json` loads a custom dynamic rule list.
- `add-rule --label ... --template ...` appends a new rule without hand-editing JSON.

## Notes

- This is a desktop-side detector, not an official server-side WhatsApp bot.
- By default it scans recent inbound WhatsApp messages from the local database, then watches only newly inserted rows on subsequent polls.
- The default rule pack is just a starting point. The intended workflow is to keep growing the rule list as new spam patterns appear.
- The safest default is detection-only. If you want, we can add a second phase that opens the suspect chat, copies sender details, or prepares a moderation queue.
