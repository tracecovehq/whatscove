# Operations

This guide covers running WhatsCove, testing it safely, interpreting logs, and debugging failures.

## Requirements

- macOS.
- Node.js 24 or newer recommended.
- WhatsApp Desktop signed in on this Mac.
- Read access to WhatsApp Desktop's local container.
- `sqlite3` available on the path.
- Xcode Command Line Tools or Swift runtime for the bundled hook.
- macOS Accessibility permission for the terminal or Node runtime when using `apply` mode.

## One-Off Scan

```bash
cd whatscove
node --experimental-strip-types ./src/cli.ts scan
```

Use a one-off scan when changing detector rules or inspecting recent history.

## Watch Mode

```bash
cd whatscove
node --experimental-strip-types ./src/cli.ts watch --poll-seconds 20
```

Watch mode scans recent inbound rows first, then uses `messagePk` as the cursor for subsequent polls.

## Weak Testing Output

```bash
node --experimental-strip-types ./src/cli.ts watch \
  --poll-seconds 20 \
  --weak-min-score 0.10
```

Weak output is useful for tuning rules. It does not trigger moderation.

Use `--weak-min-score 0` only when you want the full debug stream, including system-style rows.

## Moderation Modes

Queue moderation decisions without applying them:

```bash
node --experimental-strip-types ./src/cli.ts watch \
  --poll-seconds 20 \
  --moderation-mode queue
```

Apply real moderation actions:

```bash
node --experimental-strip-types ./src/cli.ts watch \
  --poll-seconds 20 \
  --moderation-mode apply
```

Use a custom policy:

```bash
node --experimental-strip-types ./src/cli.ts watch \
  --poll-seconds 20 \
  --moderation-mode apply \
  --moderation-policy /absolute/path/to/moderation-policy.yaml
```

## Safe Rollout Checklist

Before using `apply` mode in a real community:

- Confirm the bot account is an admin.
- Confirm `skipAdminSenders: true`.
- Confirm `retryFailedActions: false` unless intentionally resuming failures.
- Confirm `captureActionScreenshots: true` during testing.
- Run in `queue` mode first and inspect planned decisions.
- Test destructive actions in a controlled group with a non-admin test sender.
- Keep WhatsApp Desktop visible, awake, unlocked, and signed in.

## Fixture Testing

Fixtures test detection without touching WhatsApp:

```bash
node --experimental-strip-types ./src/cli.ts fixture \
  --fixture-file /absolute/path/to/test-fixture.json \
  --weak-min-score 0.10 \
  --no-notify
```

Use fixtures for:

- New spam families.
- Split-body/preview spam.
- Short paraphrases.
- False positive prevention.
- Regression tests from real spam logs.

## End-To-End WhatsApp Testing

Use a dedicated test group.

Recommended setup:

- Bot account is group admin.
- Tester account is not admin.
- Screenshots are enabled.
- `retryFailedActions` is disabled.
- Start in `queue`, then move to `apply`.

For destructive delete testing, have the tester send a known strong spam message and confirm:

- The bot logs a `SPAM` entry.
- `delete_message` is planned.
- The trace shows the context menu, selected-message action bar, `Delete for everyone`, and final admin confirmation.
- The UI shows the message was deleted by admin.

For sender removal testing, confirm:

- The trace opens group info.
- The trace opens `Members`, not `Group permissions`.
- Visible group members include the tester.
- The member menu includes `Remove from group`.
- The confirmation button `Remove` is clicked.
- The hook clicks `Done` and returns to the main chat screen.

## Log Markers

The watch output uses fixed-width markers:

- `INFO`: Scanner status or duplicate notices.
- `SPAM`: Strong spam match.
- `WEAK`: Weak test match.
- `SYS`: WhatsApp system/debug row.
- `ACTION`: Moderation decisions in non-apply contexts or failed action summaries.
- `APPLY`: Moderation actions applied successfully.
- `TRACE`: UI automation details.

The timestamp next to `INFO`, `ACTION`, `APPLY`, and `TRACE` is the scanner/log timestamp. The `Time:` line inside a match is the WhatsApp message timestamp.

## Runtime Files

Inspect these files when debugging:

- `data/spam-alerts.log`: Human-readable historical spam summaries.
- `data/spam-alerts.jsonl`: Machine-readable spam matches.
- `data/latest-suspects.json`: Latest scan result.
- `data/moderation-queue.jsonl`: Queued decisions.
- `data/moderation-events.jsonl`: Applied/failed decisions with traces.
- `data/moderation-state.json`: Processed decision ids.
- `data/moderation-screenshots/`: Visual evidence around destructive actions.

## Common Failure Modes

The Mac is locked, asleep, or at the login screen. The hook requires an active GUI session.

Accessibility permission is missing. The hook cannot inspect or press WhatsApp controls.

WhatsApp is not running or not signed in. The hook cannot find the target UI.

The bot account is not an admin. WhatsApp may not expose delete-for-everyone or remove-member controls.

The target message is not visible. The hook currently targets visible WhatsApp UI, so scroll position and chat state matter.

The visible menu belongs to macOS/Finder instead of WhatsApp. The hook logs menu options and refuses unexpected menus.

The sender display name changed or is ambiguous. `remove_sender` targets visible member rows by display name.

WhatsApp Desktop changed labels or layout. Update `src/whatsapp-hook.swift` selectors and add trace details before changing behavior.

## Debugging Delete Failures

Check `uiTrace` for:

- `Opened context menu for the matched message.`
- `Visible context menu options: ... delete ...`
- `Delete context-menu action entered selected-message mode`
- `Visible selected-message action bar options`
- `Post footer-toolbar-center click state: confirmation dialog detected`
- `Visible button options in confirmation search: delete for everyone | delete for me | cancel`
- Final confirmation with `cancel | delete`

If the trace reaches selected-message mode but no confirmation opens, inspect the `delete-toolbar` screenshots.

## Debugging Remove Sender Failures

Check `uiTrace` for:

- `Opening group info`
- `Group info opened from header center click` or chat-list context-menu fallback success.
- `Visible group-info buttons before opening Members`
- `Members navigation candidates`
- `Visible texts after opening Members`
- `Visible group members`
- `Candidate member rows`
- `Visible member menu ... remove from group`
- `Clicking confirmation button: Remove`
- `Returned to the main chat screen after remove_sender`

If the bot goes to `Group permissions`, update Members navigation filtering before changing the rest of the flow.

## Commands For Verification

Run tests:

```bash
node --experimental-strip-types test/*.test.ts
```

Typecheck the Swift hook:

```bash
/usr/bin/swiftc -typecheck src/whatsapp-hook.swift
```

Check git status:

```bash
git status --short
```
