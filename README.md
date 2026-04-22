# WhatsCove

A small macOS bot for detecting the recurring WhatsApp stock-promo spam you showed me.

It reads WhatsApp Desktop's local `ChatStorage.sqlite`, scores message text against the known stock-spam template, and writes alerts to local files so you can review or act on them.

## What it catches

- The exact stock-advice spam text you pasted.
- Close paraphrases of the same pitch.
- Variants that append a WhatsApp invite link at the end.

## How it works

1. `src/whatsapp-db.mjs` queries WhatsApp Desktop's local `ChatStorage.sqlite`.
2. `src/detection.mjs` normalizes text, strips links, and scores each message-like string against the stock-spam template.
3. `src/bot.mjs` logs matches to `data/latest-suspects.json` and `data/spam-alerts.jsonl`, and can optionally show macOS notifications for new hits.

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

Useful flags:

- `--min-score 0.80` makes the detector stricter.
- `--no-notify` disables macOS notifications.
- `--json` prints the full scan result as JSON for automation.
- `--chat "East Bay"` limits the scan to one community or group name.
- `--lookback-hours 6` restricts the initial scan window.

## Notes

- This is a desktop-side detector, not an official server-side WhatsApp bot.
- By default it scans recent inbound WhatsApp messages from the local database, then watches only newly inserted rows on subsequent polls.
- The safest default is detection-only. If you want, we can add a second phase that opens the suspect chat, copies sender details, or prepares a moderation queue.
