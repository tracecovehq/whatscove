# WhatsCove Documentation

WhatsCove is a local macOS moderation assistant for WhatsApp Desktop. It reads the local WhatsApp message database, detects spam using configurable rules, logs evidence, and can optionally perform destructive moderation actions through WhatsApp Desktop's UI.

This documentation is organized by topic so engineers can learn the system from the repository itself.

## Start Here

- [Architecture](./ARCHITECTURE.md): System overview, component map, data flow, runtime boundaries, and important files.
- [Detection](./DETECTION.md): How WhatsCove turns WhatsApp rows into spam matches, weak matches, fingerprints, and logs.
- [Moderation](./MODERATION.md): Policy modes, decision planning, persistence, retry behavior, and the bundled WhatsApp UI automation hook.
- [Operations](./OPERATIONS.md): Running the bot, safe rollout, testing against fixtures and WhatsApp, logs, screenshots, and debugging.
- [Development](./DEVELOPMENT.md): How to change rules, policies, TypeScript code, and Swift UI automation safely.

## Key Mental Model

WhatsCove has two halves:

- The TypeScript bot is the deterministic half. It reads `ChatStorage.sqlite`, scores messages, writes logs, plans moderation decisions, and persists state.
- The Swift hook is the UI automation half. It drives the live WhatsApp Desktop app through macOS Accessibility to delete messages and remove users.

Detection is database-backed. Moderation is best-effort GUI automation. A healthy production mindset is to make the TypeScript path boring and predictable, while making the Swift path heavily logged, screenshot-audited, and easy to debug.

## What WhatsCove Is Not

WhatsCove is not an official WhatsApp bot and does not use an official WhatsApp moderation API. It does not run server-side, does not write to WhatsApp's database, and does not have privileged access to WhatsApp group controls beyond what the signed-in desktop account can do in the UI.

## Repository Map

- `src/cli.ts`: CLI commands and console rendering.
- `src/bot.ts`: Scan/watch orchestration, freshness, duplicate tracking, output artifacts, and moderation entrypoint.
- `src/whatsapp-db.ts`: SQLite read path for WhatsApp Desktop's local database.
- `src/detection.ts`: Rule scoring and match explanations.
- `src/spam-rules.ts`: Spam rule loading and updates.
- `src/moderation-policy.ts`: Policy loading and defaults.
- `src/moderation.ts`: Moderation decision planning, queue/apply modes, hook execution, and retry.
- `src/moderation-state.ts`: Moderation queue, event log, and compact processed state.
- `src/whatsapp-hook.swift`: Bundled macOS Accessibility executor for WhatsApp Desktop.
- `src/fixture.ts`: Fixture coercion for offline detector testing.
- `config/spam-rules.yaml`: Default spam families.
- `config/moderation-policy.yaml`: Default moderation behavior.
- `test/detection.test.ts`: Detector, fixture, policy, and moderation planning tests.
