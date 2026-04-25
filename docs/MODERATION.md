# Moderation

Moderation turns fresh spam matches into explicit actions. It can record intended actions, queue them for later, or apply them immediately through a hook.

## Policy Modes

`config/moderation-policy.yaml` controls moderation.

Modes:

- `detect`: Create and record moderation decisions, but do not queue or execute destructive work.
- `queue`: Append decisions to `data/moderation-queue.jsonl` without touching WhatsApp.
- `apply`: Execute decisions immediately through a custom hook or the bundled Swift hook.

The safest progression is `detect`, then `queue`, then `apply` in a controlled test group.

## Policy Switches

Important policy keys:

- `enabled`: Master switch for moderation planning.
- `actions`: Default actions for strong spam matches.
- `ignoreLocallyBannedUsers`: Suppress matches from local-only banned users when that feature is used.
- `skipAdminSenders`: Log admin-posted spam examples but skip destructive moderation actions.
- `retryFailedActions`: Retry failed destructive decisions from the event log on restart.
- `retryFailedActionsLookbackHours`: Limit how far back retry can look.
- `captureActionScreenshots`: Save screenshots before and after consequential UI actions.
- `screenshotDirectory`: Optional absolute screenshot output path.
- `hookCommand`: Optional external moderation hook.
- `perRule`: Override actions for a specific spam family.

`skipAdminSenders` should usually stay true. Admins often paste spam examples while testing or discussing moderation.

`retryFailedActions` should usually stay false. When enabled, restart can resume old destructive work, which is useful but should be a deliberate operational choice.

## Decision Planning

`src/moderation.ts` owns planning.

For each fresh `SuspiciousMatch`, the planner:

1. Checks whether moderation is enabled.
2. Skips admin senders when `skipAdminSenders` is true.
3. Applies per-rule action overrides.
4. Creates one `ModerationDecision` per action.
5. Skips decisions already marked processed in `moderation-state.json`.

The decision id is derived from the match fingerprint plus action. This means `delete_message` and `remove_sender` for the same spam match are separate decisions.

## Persistence

Moderation writes two kinds of records:

- Compact state in `data/moderation-state.json`.
- Append-only events in `data/moderation-events.jsonl`.

The event log is the audit trail. It keeps all historical outcomes. The compact state prevents completed actions from repeating.

When loading state, failed decisions are removed from the processed set. This does not automatically retry them. It only makes retry possible if `retryFailedActions` is enabled.

## Hook Contract

In `apply` mode, `src/moderation.ts` sends a `ModerationDecision` JSON object to a hook on stdin.

The hook must:

- Read one JSON decision from stdin.
- Perform the requested action.
- Write trace lines to stdout.
- Exit with status `0` on success.
- Exit non-zero and write an error on failure.

Trace lines should start with:

```text
TRACE:
```

The TypeScript runner strips that prefix and stores the resulting lines in `decision.uiTrace`.

## Bundled Hook

If `hookCommand` is empty, WhatsCove runs:

```bash
/usr/bin/swift src/whatsapp-hook.swift
```

The bundled hook is a macOS Accessibility script. It uses:

- `AXUIElement` to inspect buttons, menus, headings, groups, and modal sheets.
- `AXPress` and `AXShowMenu` when controls expose semantic actions.
- `CGEvent` clicks and key presses when WhatsApp exposes unusable accessibility elements.
- `screencapture` for optional before/after screenshots.

It must run while the Mac is awake, unlocked, and in an interactive GUI session. WhatsApp Desktop must be open and signed in, and the bot account must be an admin in the target group for destructive group actions.

## Delete Message Flow

The `delete_message` action uses the same visible flow a human admin uses:

1. Open the target chat.
2. Find the visible message that best matches the decision text, sender, timestamp, and JID.
3. Open the message context menu.
4. Choose `Delete`.
5. Verify selected-message mode.
6. Click the selected-message action bar delete/trash control.
7. If the labeled control does not open a dialog, click the visual bottom-center trash fallback.
8. Click `Delete for everyone`.
9. Click the final admin `Delete` confirmation.

The hook refuses to proceed if the visible menu does not look like a WhatsApp message context menu. This avoids accidentally selecting `Delete` from an unrelated macOS menu.

## Remove Sender Flow

The `remove_sender` action removes a group member through group info:

1. Open the target chat.
2. Open group info from the chat header.
3. If header `AXPress` fails, click the header center point.
4. If the header route fails, right-click the chat list row and select `Group info`.
5. Open the `Members` pane.
6. Find the row matching the sender display name.
7. Open that member's `More options` menu.
8. Choose `Remove from group`.
9. Confirm `Remove`.
10. Click `Done` to return to the main chat screen.

The remove flow intentionally does not right-click the spam message. The message may already be deleted by the time removal runs, so sender removal must target group info and the member list.

## Screenshots

When `captureActionScreenshots` is true, the bundled hook captures screenshots around consequential actions:

- Context-menu delete selection.
- Selected-message delete/trash action.
- `Delete for everyone`.
- Final admin delete confirmation.
- Sender removal confirmation.

Screenshots are written to `data/moderation-screenshots/` by default and are ignored by git.

## Retry Behavior

Only selected UI lookup failures are retried automatically during the same `apply` attempt. Current retry logic is conservative and mainly targets flaky `delete_message` lookup failures.

Restart retry is different. It only happens when:

- `mode` is `apply`.
- `retryFailedActions` is true.
- The failed decision is newer than `retryFailedActionsLookbackHours`.
- The failed action is not `notify`.

When restart retry happens, the trace begins with a line indicating the action was resumed from the event log.

## Safety Boundaries

- Do not write to WhatsApp's database.
- Do not perform local-only deletes when the desired action is `Delete for everyone`.
- Do not moderate admin senders unless explicitly configured.
- Do not retry old destructive failures by default.
- Do not trust a context menu unless it looks like the expected WhatsApp menu.
- Prefer a loud failure over acting on the wrong UI element.
