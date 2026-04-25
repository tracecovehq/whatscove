# Development

This guide explains how to safely change WhatsCove.

## Local Workflow

Use Node's strip-types runtime. There is no separate TypeScript build step.

Run tests:

```bash
cd whatscove
node --experimental-strip-types test/*.test.ts
```

Typecheck the Swift hook:

```bash
/usr/bin/swiftc -typecheck src/whatsapp-hook.swift
```

Use `rg` to find code paths quickly:

```bash
rg "delete_message|remove_sender|ModerationDecision" src test
```

## Adding Or Changing Spam Rules

Prefer changing `config/spam-rules.yaml`.

A good rule has:

- A canonical `template`.
- A few realistic `examples`.
- High-signal `anchorPhrases`.
- `signalBuckets` for reusable concepts.
- `structuralPatterns` when spam can be split across body text and preview metadata.
- A calibrated `minScore`.
- A clear `label`.

After changing a rule:

1. Add or update a fixture case.
2. Add or update detector tests.
3. Run `node --experimental-strip-types test/*.test.ts`.
4. Run the fixture command against a representative sample.
5. Run live WhatsApp only after fixture behavior is understood.

You can append a rule from the CLI:

```bash
node --experimental-strip-types ./src/cli.ts add-rule \
  --label "Crypto signal promo" \
  --template "Join our free crypto signal team for daily bitcoin calls and market updates" \
  --anchor "free crypto signal team" \
  --anchor "daily bitcoin calls" \
  --tag crypto \
  --require-invite-link
```

## Changing Detection Code

Detection changes usually touch:

- `src/detection.ts`
- `src/bot.ts`
- `test/detection.test.ts`

Preserve these invariants:

- Empty or irrelevant text should not match.
- Invite-link-heavy spam should be caught when the rule says it should be.
- Normal finance/job/community chatter should not hard-match without enough spam structure.
- Weak matches should not trigger moderation.
- One WhatsApp row should emit at most one strong match.
- Identical spam text in two different message rows should produce distinct fingerprints.

## Changing Moderation Policy

Policy changes usually touch:

- `config/moderation-policy.yaml`
- `src/moderation-policy.ts`
- `src/moderation.ts`
- `test/detection.test.ts`

Preserve these invariants:

- Admin senders are skipped by default.
- Failed destructive actions are not retried on restart unless explicitly enabled.
- Per-rule overrides take precedence over default actions.
- `queue` mode never touches WhatsApp.
- `apply` mode records success and failure traces.

## Changing Moderation State

State changes usually touch:

- `src/moderation-state.ts`
- `src/moderation.ts`
- Tests covering decision planning and retry.

Preserve these invariants:

- `moderation-events.jsonl` remains append-only.
- `moderation-state.json` remains compact and reconstructable.
- Failed decisions do not remain permanently processed.
- Restart retry remains opt-in and bounded by lookback hours.

## Changing The Swift Hook

The Swift hook is the highest-risk part of the project because it automates a third-party desktop UI.

Changes usually touch:

- `src/whatsapp-hook.swift`
- `docs/MODERATION.md`
- `docs/OPERATIONS.md`

Before changing behavior, identify which UI flow is being changed:

- Delete message.
- Remove sender.
- Confirmation dialog handling.
- Menu discovery.
- Group info navigation.
- Member row matching.
- Screenshot capture.

Preserve these invariants:

- Prefer semantic AX actions first.
- Use coordinate clicks only as explicit fallbacks.
- Verify a state transition after a click whenever possible.
- Log visible options before choosing a destructive action.
- Refuse unexpected context menus.
- Capture screenshots around consequential actions when enabled.
- Prefer a clear failure over acting on the wrong UI element.

After Swift changes:

1. Run `/usr/bin/swiftc -typecheck src/whatsapp-hook.swift`.
2. Run Node tests.
3. Test in a controlled WhatsApp group.
4. Inspect trace and screenshots.
5. Update docs if the expected UI sequence changed.

## Adding A New Moderation Action

Add the action to `ModerationActionType` in `src/types.ts`.

Then update:

- `config/moderation-policy.yaml` if it should be configurable.
- `src/moderation-policy.ts` if config parsing/defaults need to know about it.
- `src/moderation.ts` if planning, local side effects, retry, or hook routing change.
- `src/whatsapp-hook.swift` if the bundled hook executes it.
- Tests for planning and policy behavior.
- Documentation in `docs/MODERATION.md` and `docs/OPERATIONS.md`.

For destructive actions, add:

- Trace lines before and after important UI steps.
- Confirmation detection.
- Before/after screenshots.
- A clear failure mode if the expected UI is not present.

## Code Comment Style

Comments should explain why the system behaves a certain way, not restate simple code.

Good comments explain:

- WhatsApp Desktop quirks.
- Safety boundaries.
- State/retry semantics.
- Why a fallback exists.
- What invariant a future change must preserve.

Avoid comments that merely say what a line of code already says.

## Documentation Style

Keep root `README.md` as the quickstart and product overview.

Keep topic docs focused:

- `ARCHITECTURE.md` explains how parts fit together.
- `DETECTION.md` explains matching and fingerprints.
- `MODERATION.md` explains decisions and UI automation.
- `OPERATIONS.md` explains how to run and debug.
- `DEVELOPMENT.md` explains how to safely change the code.

If a behavior changes in code, update the topic doc in the same patch.
