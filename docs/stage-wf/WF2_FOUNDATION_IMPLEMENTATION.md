# WF2 — Workflow Automation Engine: Foundation Implementation

Status: **Foundation slice implemented and verified; ready for PR review.**
Branch: `feat/wae-foundation`, created from `origin/staging` @ `c733b1104f5dfa344a4aace37df8ae8ac8b5d69b`
(the commit verified in `RECOVERY COMPLETE — STAGING VERIFIED`).
Baseline discovery doc: `docs/stage-wf/WF1_DISCOVERY.md`.

## 1. Objective

"WHEN an approved domain event occurs → evaluate applicable rules → create controlled,
auditable actions." This stage builds the foundation only: the persistence model, the
trigger/condition/action primitives, the engine that ties them together, and one vertical
slice (`AGENCY_AGREEMENT_SIGNED` → `PROPERTY_NOTE_ADD`). It deliberately does not build a
workflow designer, a management UI, a broad action catalogue, or any communications/financial
automation — see §6.

## 2. Architecture summary

The engine reuses four pieces of existing infrastructure rather than duplicating them:

- **Event architecture** (`packages/events`, `apps/api/src/lib/events.ts`). The engine's
  single entry point, `handleAutomationDomainEvent`, is registered via the existing
  `registerHandler(eventType, handler)` for every canonical event type
  (`apps/api/src/lib/automation/bootstrap.ts`). Before this change, `registerHandler(` had
  zero call sites anywhere in the repository — this is the first real consumer of the
  handler-dispatch path that `publishDomainEvent` already `await`s synchronously.
- **AI Governance / Authority pipeline** (`apps/api/src/lib/ai/*`). Every action the engine
  takes is proposed through the existing `proposeAIAction()` and, when auto-execute-eligible,
  run through the existing `executeAIAction()` — the same single choke point every
  human- and AI-initiated action already uses. The engine never calls an action's `execute()`
  itself and never re-implements policy, entitlement, or authority logic.
- **Action Registry** (`apps/api/src/lib/ai/actions/registry.ts`). The vertical slice uses the
  existing `PROPERTY_NOTE_ADD` action unchanged. `"SYSTEM"` was added to
  `PROPERTY_NOTE_ADD.allowedActorTypes` and `WORKFLOW_VERSION_ACTIVATE.allowedActorTypes` (the
  two actions this stage's slice and approval-required test coverage need) so the engine can
  act as `actorType: "SYSTEM"` — a value `aiActionRequests.actorType` and
  `addPropertyNote`'s `actorType` parameter already typed as valid before this change. No
  other field on either action (role, risk level, approval requirement, `execute()`) changed.
- **Tenancy and entitlements** (central resolver at `apps/api/src/lib/entitlements/resolver.ts`).
  The engine never re-derives tenant scope: every rule, execution, and action row carries the
  triggering event's `brokerageId`, and `getActiveRuleVersionsForTrigger` filters by it before
  a single condition is evaluated. Entitlement checks are not re-implemented — they run inside
  the reused `evaluateAIAction()` → `explainEntitlementDecision()` path exactly as they do for
  every other actor.

New code lives entirely under `apps/api/src/lib/automation/`:

| File | Component(s) | Responsibility |
| --- | --- | --- |
| `types.ts` | 5, 6, 8 | Closed status/decision vocabularies shared by the schema and the engine. |
| `facts.ts` | 3 | Flattens a `DomainEvent` into a plain fact object conditions can read; blocks prototype-pollution path segments. |
| `conditions.ts` | 3 | The typed, closed operator set (`eq/neq/gt/gte/lt/lte/in/notIn/exists/notExists/contains`), a recursive `ALL`/`ANY` group evaluator, and its zod schema. No operator ever coerces types. |
| `templating.ts` | 4 | Whole-value-only `$event.<path>` substitution for action params. Never evaluates expressions, never interpolates inside a larger string. |
| `rules.ts` | 1 | The rule/version service layer: create, version (numbered sequentially per rule), approve-and-activate-with-supersede, and tenant/trigger-scoped lookup. Rejects unknown trigger event types and unregistered `actionKey`s at write time. |
| `templates.ts` | — (slice) | The `AGENCY_AGREEMENT_SIGNED` system-template rule definition and installer. |
| `bootstrap.ts` | 2 | Registers `handleAutomationDomainEvent` against every canonical event type, once, idempotently. |
| `engine.ts` | 5, 6, 7, 8, 9, 10, 11, 12, 13 | The evaluate-then-execute engine: receipt-based duplicate-event protection, per-rule isolation, condition evaluation, authority resolution, per-action execution through the governance pipeline, structured audit-event publication, and explicit retry. |

## 3. The 14 foundation components — where each lives

1. **Workflow definition and versioning model** — `automationRules` / `automationRuleVersions`
   (pre-existing schema, unmodified) + `rules.ts`'s `createAutomationRule` /
   `createRuleVersion` / `approveAndActivateRuleVersion`. A version is immutable once
   activated; editing creates a new version, never rewrites history (mirrors
   `workflowProposals.ts`'s proven supersede-then-activate shape).
2. **Trigger definition on approved domain events** — `rules.ts`'s
   `assertValidTriggerEventType`, checked against `AGENT_ENGINE_EASY_EVENT_TYPES`, the single
   canonical catalogue. No free-text trigger is possible.
3. **Conditions with an explicit, typed operator set** — `conditions.ts` (11 operators, closed
   union, zod-validated at write time, evaluated with no type coercion at run time).
4. **Action definitions via a controlled action registry** — `rules.ts`'s
   `assertActionsAreRegistered` at write time, `engine.ts`'s `getActionDefinition` re-check at
   execution time. Both resolve against the existing `ACTION_REGISTRY`; nothing here can
   reference an action that isn't explicitly registered.
5. **Workflow execution records** — `automationExecutions` (pre-existing schema). `engine.ts`
   writes `EVALUATING → SKIPPED` or `EVALUATING → RUNNING → {COMPLETED,BLOCKED,FAILED,
   PARTIALLY_COMPLETED,AWAITING_APPROVAL}`, with `conditionResult`, `startedAt`/`completedAt`,
   and `errorMessage` populated at each transition.
6. **Per-action execution records** — `automationActions` (pre-existing schema). One row per
   `(executionId, sequence)`, unique-indexed; `engine.ts`'s `executeAutomationAction` is the
   sole writer.
7. **Idempotency and duplicate-event protection** — two independent layers: (a)
   `eventProcessingReceipts`, claimed with `onConflictDoNothing` before any rule is evaluated
   (`claimEventProcessingReceipt`); (b) the `automationExecutions` unique index on
   `(ruleVersionId, triggeringEventId)`, claimed the same way. A redelivered event can reach
   neither a second evaluation nor a second execution row.
8. **Execution status and failure recording** — the 10-state `automationExecutions.status`
   and 10-state `automationActions.status` vocabularies (`types.ts`), driven by
   `computeExecutionStatus` and the per-action outcome switch in `executeAutomationAction`.
9. **Correlation and causation traceability** — every execution carries the triggering event's
   `correlationId`; every `AUTOMATION_EXECUTION_*`/`AUTOMATION_ACTION_*` event `engine.ts`
   publishes sets `causationId` to the triggering event's `id` — the first genuine (non-null)
   use of `causationId` in this codebase (every existing `publishAiActionEvent` call site
   publishes `causationId: null`, per `actionEvents.test.ts`'s own regression coverage).
10. **Tenant and entitlement isolation** — `getActiveRuleVersionsForTrigger` filters by
    `brokerageId` before evaluation; every execution/action row is written with the rule's
    `brokerageId`; entitlement checks run inside the reused `evaluateAIAction()` path, so an
    entitlement gap denies exactly as it would for a human- or AI-initiated action.
11. **Authority and approval-policy enforcement** — `resolveVersionApprover` requires the rule
    version's `approvedByUserId` to resolve to a real user of the same brokerage; if it can't,
    the execution is `BLOCKED` before any action is attempted (fail closed, never a silent
    default actor). Actions the policy engine marks `requiresApproval` stop at
    `AWAITING_APPROVAL` and go through the existing, unmodified human approval endpoints.
12. **Structured audit events for evaluation and execution** — `AUTOMATION_EXECUTION_SKIPPED`
    and `AUTOMATION_EXECUTION_COMPLETED` (new canonical event types, added this stage) plus the
    pre-existing `AUTOMATION_ACTION_FAILED` / `AUTOMATION_ACTION_BLOCKED`, all published via
    `publishAutomationEvent`, which never lets a publish failure abort the execution it's
    describing (best-effort, logged, non-fatal).
13. **Safe retry behaviour for retryable actions** — `engine.ts`'s exported
    `retryAutomationAction`: reuses the same `(executionId, sequence)` row (never a new one),
    refuses to retry a `PAYLOAD_TAMPERED` / `POLICY_DENIED` / `ACTION_NOT_FOUND` failure, refuses
    once `attemptCount >= maxAttempts`, and re-verifies authority fresh before re-attempting.
14. **Tests covering successful, skipped, rejected, duplicated and failed executions** — see §7.

## 4. Vertical slice: `AGENCY_AGREEMENT_SIGNED`

`templates.ts` defines a system-template rule: condition `propertyId exists`, action
`PROPERTY_NOTE_ADD` with a templated note (`$event.propertyId` substituted). It reuses the
existing property-note action outright — no new action was written. Installing the template
(`installAgencyAgreementSignedTemplate`) creates the rule and a `DRAFT` version; a Brokerage
Administrator must still call `approveAndActivateRuleVersion` to bring it live, through the
same authority check every other version activation goes through. No HTTP route installs or
activates it automatically — deliberate, matching the "no workflow-management UI" exclusion.

**Documented gap**: a repository-wide search (`search_code` for `"AGENCY_AGREEMENT_SIGNED"`)
found zero call sites that actually `publishDomainEvent` this event type — the real
agency-agreement/e-sign flow does not yet emit it. Wiring that production trigger belongs to
the document/e-sign integration module and is out of scope for this foundation PR ("large
refactors unrelated to the foundation"). Test coverage instead publishes the event directly,
which exercises the entire engine identically to a real publisher.

## 5. Schema and migration summary

**No schema file was modified and no new migration was generated.** The five tables this
engine reads and writes (`automation_rules`, `automation_rule_versions`,
`automation_executions`, `automation_actions`, `event_processing_receipts`) already existed in
`packages/db/src/schema/automation.ts`, already baked into the single baseline migration
(`packages/db/migrations/0000_baseline_schema.sql`), and were confirmed present with zero rows
in `docs/foundation-remediation/F2_AUTOMATION_SCHEMA_CHECKPOINT.md` — "scaffolded only," no
prior reader or writer. This PR is their first consumer. Real execution of the CI schema-drift
check (`pnpm --filter @aee/db exec drizzle-kit generate`) confirmed this: `No schema changes,
nothing to migrate`, and `git diff --exit-code -- packages/db/migrations` reported no changes.

## 6. Explicitly out of scope (unchanged from the task)

Drag-and-drop workflow designer; full workflow-management UI; user-authored executable code;
unrestricted webhooks; AI-generated autonomous workflows; the complete workflow catalogue;
Communications Hub functionality; financial/trust-account automation; Pit Crew assignment
automation; brokerage-wide workflow administration; large refactors unrelated to the
foundation. Additionally deferred, and flagged as genuine gaps rather than silently skipped:

- No production code path publishes `AGENCY_AGREEMENT_SIGNED` yet (§4).
- No scheduler/worker calls `retryAutomationAction` automatically — it is a callable,
  tested primitive with no automatic trigger yet. Building that worker is next-phase work.
- No HTTP routes for rule authoring/management exist. Rules are created and activated at the
  service-function layer only, matching the "no workflow-management UI" exclusion.

## 7. Test coverage

`apps/api/src/lib/automation/__tests__/`:

- `conditions.test.ts` — pure-logic coverage of `facts.ts`/`conditions.ts`/`templating.ts`
  (fact flattening, nested paths, prototype-pollution guard, `ALL`/`ANY`/nested groups,
  `notExists`, no numeric type coercion, schema rejection of an unknown operator and of an
  empty condition list, whole-value-only templating substitution).
- `rules.test.ts` — integration coverage of the service layer against a real database
  (invalid trigger type rejected, unregistered `actionKey` rejected, malformed condition group
  rejected, sequential version numbering, approver-role/tenant enforcement, activate-supersedes-
  previous-active, tenant isolation, PAUSED-parent-rule exclusion).
- `engine.test.ts` — the twelve named scenarios end to end against a real database and the
  real event-dispatch path (`configureEvents()` + `registerAutomationEngine()`): eligible
  execution; condition mismatch/clean skip; duplicate event delivery; disabled workflow; wrong
  tenant; missing entitlement; unregistered action type; insufficient authority;
  approval-required action (including a genuine call to the existing, unmodified
  `approveAIActionRequest()`); retryable failure; non-retryable failure; audit/correlation
  continuity (`causationId` chains back to the triggering event across the whole run).

`apps/api/package.json`'s `test` script was extended to include
`src/lib/automation/__tests__/*.test.ts` so this suite runs in CI alongside the existing
suites; nothing else in that script changed.

## 8. Verification results (executed, not manually reasoned)

The Replit workspace this task normally verifies against reconnected during this session, so
every step below was actually run there against the real toolchain and a real Postgres
database — not inferred from reading source. This run found and fixed two genuine defects
that static review had missed:

- **`tsc` (real compiler) caught a bad import**: `engine.ts` imported `PolicyActor` from
  `../ai/actionRequests.js`, but that module only imports it from `policyEngine.ts` for its
  own internal use and never re-exports it (`TS2459`). Fixed by importing both `PolicyActor`
  and `PolicyDecision` directly from `../ai/policyEngine.js`, the module that actually defines
  them.
- **The real test run caught a wrong operator**: the "supports nested groups" test in
  `conditions.test.ts` asserted array membership with the `in` operator (scalar-is-member-of-
  list) against an array fact value, so it evaluated `false` unconditionally. Fixed by using
  `contains` (array-includes-scalar), the operator that actually expresses the test's intent.

With both fixes applied, the full CI-equivalent sequence was executed in order:

| Step | Command | Result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | Clean; no new/changed dependencies |
| Typecheck | `pnpm -r run typecheck` | All 10 workspace projects report `Done`; `apps/api` clean after the `engine.ts` fix |
| Migration (Replit dev DB) | `pnpm --filter @aee/db run db:migrate` | Failed — see below; does not reflect CI |
| Schema drift | `pnpm --filter @aee/db exec drizzle-kit generate` + `git diff --exit-code -- packages/db/migrations` | `No schema changes, nothing to migrate`; diff clean |
| Tests | `pnpm --filter @aee/api run test` | **171 tests: 170 pass, 0 fail, 1 skipped** (the skip is pre-existing and unrelated — an entitlement-restriction placeholder in `apps/api/src/lib/ai/__tests__`, documented in its own SKIP reason, not touched by this PR) |
| API build | `pnpm --filter @aee/api run build` | `esbuild` succeeded, `dist/index.mjs` 296.4kb, done in 126ms |
| Web build | `pnpm --filter @aee/web run build` | `vite build` succeeded, done in 1.31s (only output: a pre-existing Node-version advisory from Vite, unrelated to this PR and present regardless of it) |

**On the migration failure**: this Replit workspace's Postgres database is a long-lived dev
database, not the fresh, ephemeral instance CI provisions per run. Direct inspection
(`psql "$DATABASE_URL" -c '\dt'`) shows all 44 baseline tables — including all five
`automation_*`/`event_processing_receipts` tables this PR uses — already exist in this
database, while `select * from drizzle.__drizzle_migrations` returns zero rows. That
combination means this database's schema was created out of band at some point in this
workspace's history (e.g. via `drizzle-kit push` during earlier development) rather than
through the tracked `db:migrate` journal, so re-running `db:migrate` against it tries to
`CREATE TABLE "brokerages"` from scratch and fails on the first statement because the table is
already there. This is a pre-existing property of this one long-lived database, not a defect
introduced by this PR: it would fail identically on a pristine checkout of `origin/staging`
with zero WAE changes, and it is independent of anything this PR's code does. It is also not
the authoritative check — `.github/workflows/ci.yml` provisions a genuinely fresh, empty
Postgres 16 service container for every run, applies only the single baseline migration to it,
and that is the check whose result this PR's CI run reports.
