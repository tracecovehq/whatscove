# Tracecove Moderation engineering

<!-- BEGIN TRACECOVE SHARED GUIDANCE -->
## Shared Tracecove guidance

Company policy and the current naming map are maintained in the active `platform-plan` checkout: `instructions/tracecove/AGENTS.md` and `offerings/product-module-api-naming.md` (guidance merged in platform-plan PR #68). Apply them across checkout locations alongside the host's instructions. Identify the owning repository, branch, HEAD and existing edits first; prefer a suitable managed worktree and resolve historical paths through the host's resolver.

Use current presentation: Tracecove Identity, Access, Workflows, Health, Hikes, Intros and Moderation. Library belongs inside Workflows; Preview, Mark, Crumb and Crossing retain their labels. Accounts/Tidekey/Grantbind, Capstan, Healthstory/Journal, Trailcall, Peertable/Hiringrooms, Whatscove and Patchbay are compatibility/history aliases. Preserve repositories, commands, package/storage/issuer identifiers, accepted routes, stable task IDs and dated evidence.

`docs/INDEX.md` and the existing detection, moderation, operations and development contracts own this local macOS product. Use the platform ledger for shared contracts, dependencies and acceptance, without creating a second product backlog. Read-only discussion or a routine local correction need not invent platform progress.

For material shared Identity, Access, provenance, security, delegation or related integration work, select the active plan checkout; a fixed sibling path is not proof of the current source. Start with its `references/active-work.md`, `references/engineering-workflow.md`, affected design sections and the product tracker. Set `PLAN_ROOT` to that actual checkout and replace `TASK-ID` with the affected stable ID:

```sh
python3 "$PLAN_ROOT/scripts/read_progress.py" --task TASK-ID --recent 3
python3 "$PLAN_ROOT/scripts/update_progress.py" --show-sha
python3 "$PLAN_ROOT/scripts/update_progress.py" --dry-run /absolute/path/to/event.json
python3 "$PLAN_ROOT/scripts/update_progress.py" /absolute/path/to/event.json
```

Use the observed `progress.json` content SHA-256 as `base_sha256`, not a Git commit SHA. Allocate shared records in the canonical ledger first; checkout-local locks do not reserve IDs globally. Reconcile isolated branches through the documented pinned-snapshot/alias workflow; preserve original receipts. Run the plan's `scripts/audit.py` with the workflow guide's applicable historical-reference/resolver arguments and `scripts/read_progress.py --check-overview`. Access tracker changes additionally require its own observed revision and `scripts/audit_access_plan.py`; the platform writer does not mutate the Access tracker. If a needed shared source is unavailable, identify that dependency and continue independent product work.

Define material slices by user outcome, existing task ID, acceptance and smallest useful implementation. Choose checks for the changed behavior/risk and retain required checks. Time-box investigations with bounds and an exit condition; record observed evidence, limitations, next dependency and owner. Keep local validation, CI, signed commit, push, deployment, live acceptance and provider acceptance separate.

Save durable work in its owning repository and use its existing GitHub review workflow within the task's authority. Automatic Pages/Spaces creation, sync, parity, readback and preview requirements are retired; preserve historical receipts. Use Pages only for an explicit request. Preserve repository visibility, signature verification, required reviews, product-specific rules and release gates. This guidance does not authorize deployments, purchases, messages or scheduled work. Shared login does not grant product permissions; Access company offboarding must preserve suite accounts and unrelated company relationships. Crossing stays optional, and local Health capture remains independent of online account status. Follow applicable credential, privacy and design instructions.
<!-- END TRACECOVE SHARED GUIDANCE -->

Read `README.md` and `docs/INDEX.md`, then the affected detection, moderation, operations and development contracts. Preserve `whatscove` CLI/package/configuration identifiers, rule IDs, detector thresholds and persisted moderation history.

Keep detect, queue and apply outcomes distinct. Preserve policy controls for admin senders, retrying failed actions and destructive executors. Changing a live policy or invoking message deletion/sender removal needs the task's actual authority; use synthetic fixtures for source validation. Do not commit private messages, phone numbers, participant rosters, invite links, live database copies or screenshots.

A rule match does not establish AI authorship or personhood. Hosted public APIs and cross-community collection remain separately deferred; instruction changes do not authorize them.
