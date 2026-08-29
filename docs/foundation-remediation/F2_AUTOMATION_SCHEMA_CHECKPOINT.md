# F2 — Automation Schema Checkpoint

**Stage:** 2
**Purpose:** preserve the unfinished Workflow Automation Engine schema work identified by the audit as a clean, reviewable checkpoint — without extending it, without building anything on top of it, and without losing anything.

## What this stage did

1. Reviewed every uncommitted item the audit flagged: the event-type catalogue extension, the `domainEvents` schema extension, `packages/db/src/schema/automation.ts`, `docs/stage-wf/`, and six generated `tsconfig.tsbuildinfo` files.
2. Separated genuine source changes from generated build artefacts (see below).
3. Added `*.tsbuildinfo` to the root `.gitignore` so these files stop appearing as untracked noise in every future `git status`.
4. Verified the automation schema compiles: `pnpm -r run typecheck` — **10 of 11 workspace projects, every one reports "Done", zero errors**, including `packages/db typecheck: Done` (the package `automation.ts` lives in).
5. Made **no changes to the schema's shape** — no columns added or removed, no new tables, no evaluator, worker, executor, templates, or UI. The file transfers into this stage exactly as it was written in the earlier session.
6. Confirmed, by direct read-only query against the live database, that the five tables this schema describes (`automation_rules`, `automation_rule_versions`, `automation_executions`, `automation_actions`, `event_processing_receipts`) already exist there from the prior session's `drizzle-kit push`, and every one of them has **zero rows**. Nothing in this stage inserted, updated, or deleted a row in any of them.

## Genuine source changes vs. generated artefacts

| Item | Classification | Disposition |
|---|---|---|
| `packages/db/src/schema/automation.ts` (275 lines) | Genuine source — new schema module | Preserved unmodified, checkpointed in this stage's commit |
| `packages/db/src/schema/events.ts` (+13 lines) | Genuine source — extends the `domainEvents` envelope with `aggregateType`, `aggregateId`, `dataClassification` columns | Preserved unmodified, checkpointed |
| `packages/db/src/schema/index.ts` (+1 line) | Genuine source — barrel export (`export * from "./automation"`) | Preserved unmodified, checkpointed |
| `packages/events/src/types.ts` (+28 lines) | Genuine source — extends the versioned event-type catalogue | Preserved unmodified, checkpointed |
| `docs/stage-wf/WF1_DISCOVERY.md` (18,659 bytes) | Genuine source — the Stage 1 discovery/design document from the prior Workflow Automation Engine build attempt | Preserved unmodified, checkpointed |
| `packages/db/tsconfig.tsbuildinfo`, `packages/events/tsconfig.tsbuildinfo`, `packages/integrations/{aml,billing,esign,object-storage,payments,property-data}/tsconfig.tsbuildinfo` | Generated — TypeScript's own incremental-build cache, regenerated automatically by `tsc` on every run | Left untouched on disk (deleting them is unnecessary and would just cause them to regenerate); added to `.gitignore` so they are never committed going forward |

No file in either column was deleted, overwritten, or rewritten in this stage.

## What the schema currently provides

Five tables, fully typed, with Zod insert schemas and inferred TypeScript types for each:

- **`automation_rules`** — a named, tenant-scoped (`brokerageId`) container for one automation rule: its trigger event type, lifecycle status (`DRAFT`/`ACTIVE`/`PAUSED`/`ARCHIVED`), and whether it is a system template.
- **`automation_rule_versions`** — versioned WHEN/IF/THEN definitions (`conditionGroup`, `actions` as JSONB) bound to a rule, with its own DRAFT→PROPOSED→APPROVED→ACTIVE→SUPERSEDED lifecycle and an `createdByAi` flag, unique-indexed on `(ruleId, version)` so a rule's history can never collide.
- **`automation_executions`** — one row per (rule version, triggering domain event) pair, unique-indexed on exactly that pair — this is the idempotency guarantee that would stop the same event from ever creating two executions against the same rule version, once something actually calls this table.
- **`automation_actions`** — one row per action attempt within an execution, unique-indexed on `(executionId, sequence)`, with an `authorityDecision` column and an `aiActionRequestId` foreign key that would route any approval-requiring action through the existing AI Governance approval flow (`aiActionRequests`) rather than inventing a second approval mechanism.
- **`event_processing_receipts`** — the outbox-consumer idempotency ledger, unique-indexed on `(eventId, handlerName)`, distinct from `domainEvents.processingStatus` (which only reflects the publisher's own synchronous dispatch attempt).

## What remains inert

Every one of the above is a table definition and nothing more. Confirmed by direct repository search: no rule evaluator exists anywhere in the codebase, no worker or scheduler reads from `domainEvents` and writes into `automation_executions`, no action executor calls into `ACTION_REGISTRY` on this table's behalf, no route or UI reads or writes any of these five tables, and no code anywhere registers a handler that would ever cause a row to be inserted into them. The 0-row counts confirmed above are a direct consequence of that: nothing in the running application talks to this schema yet. It is exactly what the prior audit called it — **SCAFFOLDED ONLY** — and this stage does not change that classification. Building the evaluator, worker, executor, templates, or UI described in the original Workflow Automation Engine instructions was explicitly out of scope for this remediation and was not attempted.

## Checkpoint

This stage's commit (`Checkpoint automation schema and ignore build artefacts`) contains exactly the five genuine-source items listed above, plus the `.gitignore` addition. No other file is touched by that commit.
