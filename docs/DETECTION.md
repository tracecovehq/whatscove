# Detection

Detection is the deterministic part of WhatsCove. It reads message-like fields from the WhatsApp database, scores them against configured spam rules, logs the strongest result per message row, and passes fresh strong matches to moderation.

## Database Input

`src/whatsapp-db.ts` reads:

```text
~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
```

The query filters with `m.ZISFROMME = 0`, so live scans only consider inbound messages. This is a safety boundary: the bot account may paste spam examples for testing, but its own outbound messages should not become live moderation targets.

The query joins:

- `ZWAMESSAGE`: Message rows.
- `ZWACHATSESSION`: Chat names and chat JIDs.
- `ZWAGROUPMEMBER`: Sender metadata and admin status.
- `ZWAPROFILEPUSHNAME`: Fallback sender names.
- `ZWAMESSAGEDATAITEM`: Link preview metadata.

WhatsApp stores message dates as seconds since Apple's 2001 epoch. The query adds `978307200` seconds to convert them to Unix time for readable UTC and local timestamps.

## Text Candidates

Spam does not always live in the visible message body. It can be split across the message text, link preview title, link preview summary, and link preview content.

`src/bot.ts` uses `createTextCandidates()` to evaluate:

- `text`
- `previewTitle`
- `previewSummary`
- `previewContent1`
- `previewContent2`

Only the strongest strong match per row is emitted. If there is no strong match, only the strongest weak match per row is emitted when weak matching is enabled. This prevents one physical WhatsApp message from producing multiple moderation actions.

## Rule Structure

Rules live in `config/spam-rules.yaml`.

Each rule can define:

- `id`: Stable machine identifier.
- `label`: Human-readable name in logs.
- `template`: Canonical spam text.
- `examples`: Alternate wording for the same spam family.
- `anchorPhrases`: High-signal phrases that strengthen a match.
- `signalBuckets`: Reusable semantic groups such as finance terms, promotional language, and join CTAs.
- `structuralPatterns`: Recipes that require hits across multiple signal buckets, often combined with an invite link.
- `minScore`: Optional rule-specific threshold.
- `requireInviteLink`: Whether the rule requires a WhatsApp invite link.
- `tags`: Metadata for humans or downstream automation.

## Scoring

`src/detection.ts` normalizes text, removes URLs for token comparison, and computes several signals:

- Token recall against the template and examples.
- Token precision against the template and examples.
- Balanced token coverage.
- Character n-gram similarity.
- Anchor phrase hits.
- Signal bucket hits.
- Structural pattern matches.
- WhatsApp invite link presence.

The detector picks the best exemplar match per rule and combines the signals into a score. The candidate is a strong match when the score meets the rule threshold and required structural conditions.

## Match Explanations

Every match carries `reasons`. These are intended to be shown to a human moderator, not just used by tests. Examples include:

- `contains a WhatsApp invite link`
- `covers 100% of the known us stock promo invite vocabulary`
- `matches 15 us stock promo invite anchor phrase(s)`
- `matches financial group invite spam pattern`

When a candidate has no detector signal but weak debug logging is enabled, it is reported as `No spam rule signal` with a debug reason. These entries should never trigger moderation.

## Strong, Weak, And System Entries

Strong matches are real spam-rule matches and can trigger moderation.

Weak matches are diagnostic entries used while tuning rules. They are printed only when `--weak-min-score` is provided.

System entries are WhatsApp group system rows rendered for debugging, such as member join/remove events. They may appear in weak output when `--weak-min-score 0` is used.

The CLI prints different markers and colors so operators can scan logs quickly:

- `SPAM`: Strong rule match.
- `WEAK`: Low-confidence rule similarity.
- `SYS`: WhatsApp system/debug row.
- `INFO`: Bot status.
- `ACTION` or `APPLY`: Moderation decisions.
- `TRACE`: UI automation trace details.

## Fingerprints And Duplicate Logging

Each `SuspiciousMatch` has a `fingerprint` built from:

- `messagePk`
- `messageTimeLocal`
- `chatName`
- `senderName`
- `ruleId`
- Candidate text

This lets WhatsCove treat two identical spam messages as separate events when they come from different WhatsApp rows.

During one watcher process, `seenFingerprints` prevents repeated console output and repeated moderation for the same match. If a spam match is ignored because it is a duplicate, the CLI should say so clearly instead of silently skipping work.

## Fixture Testing

The `fixture` command evaluates synthetic rows without touching WhatsApp Desktop or its database.

Use fixtures to test:

- Split-field spam across body and preview metadata.
- CTA link handling.
- Rule thresholds.
- Weak match behavior.
- Regression cases for new spam families.

Fixture input can be a single row, an array of rows, or an object with `messages`.

Example:

```json
{
  "messages": [
    {
      "chatName": "Fixture Community",
      "messageType": 0,
      "text": "TEST ONLY: detector exercise with CTA link.\nhttps://example.test/wa-preview",
      "previewTitle": "TEST ONLY - US stock knowledge group",
      "previewSummary": "Group chat invite",
      "previewContent1": "TEST ONLY - latest information of various stocks, information for free, welcome to join"
    }
  ]
}
```

Run:

```bash
node --experimental-strip-types ./src/cli.ts fixture \
  --fixture-file /absolute/path/to/test-fixture.json \
  --weak-min-score 0.10 \
  --no-notify
```
