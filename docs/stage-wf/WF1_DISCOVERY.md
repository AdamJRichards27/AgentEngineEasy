# Stage 1 — Discovery and Design Confirmation
## Workflow Automation Engine ("Agent Engine 2.0")

**Method:** every claim below was confirmed by direct inspection of the live
`AgentEngineEasy` repo (`staging` branch, via the Replit Shell) — `cat`, `grep -rn`,
`wc -l`, `find`, `ls` — never inferred from `ARCHITECTURE.md` narrative alone. Where
`ARCHITECTURE.md` describes something, the underlying code was independently checked
against it.

---

## 0. Repository / branch state

- Branch: `staging`. Working tree clean, fully in sync with `origin/staging` at
  commit `60eda42` (the AI Governance + Grow entitlements/billing + import-pipeline
  commit pushed earlier this session). No uncommitted work outstanding.
- Prior architecture audit **is locatable**: `docs/stage-g/G1_ARCHITECTURE_AUDIT.md`
  (the AI Governance Stage G1 audit, written and committed this session) plus the
  root `ARCHITECTURE.md`, which contains a "## 6. Event architecture" section
  (19 canonical events, persist-then-publish, idempotency-key-required-on-anything-
  retriable, isolated handlers — confirmed to match the actual code, see §3).
- **No mandatory stop condition is triggered by repo/branch state.**

---

## 1. Business-event source of truth

**Classification: KEEP (production side) / MISSING (consumption side)**

`packages/events/` + `apps/api/src/lib/events.ts` + the `domainEvents` table
(`packages/db/src/schema/events.ts`) is the existing, single, real event system —
confirmed live and wired into real business logic, not a stub:

- `publishDomainEvent()` (`packages/events/src/publisher.ts`): persist row →
  synchronously dispatch to any registered in-process handlers → never throws back
  to the caller (errors are captured per-handler into `handlerErrors`/`attemptCount`
  columns) → idempotency-key-aware (unique-indexed).
- Envelope columns confirmed: `id, eventType, eventVersion, occurredAt, recordedAt,
  propertyId, transactionId, partyId, brokerageId, agentId, actorType, actorId,
  source, correlationId, causationId, idempotencyKey, payload, metadata,
  processingStatus (default "PROCESSED"), handlerErrors, attemptCount`.
- Real, live call sites confirmed via grep across `transactions.ts` (8 sites:
  `CONTRACT_SIGNED, FINANCE_APPROVED, SETTLEMENT_SCHEDULED, COMMISSION_CALCULATED,
  SETTLEMENT_COMPLETED, FUNDS_RECEIVED, AGENT_PAID, TRANSACTION_CLOSED`),
  `aml.ts`, `documents.ts`, `offers.ts`, `billing/sync.ts`, `routes/properties.ts`,
  `routes/grow.ts`.
- `EVENT_TYPE_REGISTRY` (`packages/events/src/types.ts`) currently has ~50 versioned
  event types. Against the spec's required 26-type canonical catalogue (and the
  19-event list in `ARCHITECTURE.md` §6, which is a subset carried forward
  verbatim), **11 required types do not yet exist**: `APPRAISAL_CREATED,
  PROPOSAL_SENT, CONTRACT_PREPARATION_STARTED, CONTRACT_EXCHANGED,
  TRANSACTION_UNCONDITIONAL, TASK_COMPLETED, TASK_OVERDUE, WORKFLOW_ACTION_FAILED,
  WORKFLOW_ACTION_BLOCKED, EXCEPTION_CREATED, EXCEPTION_RESOLVED`. Additive,
  non-breaking — new entries in an existing catalogue.

**Gap (consumption side, confirmed, not inferred):** `registerHandler()`
(`packages/events/src/registry.ts`) has **zero call sites anywhere in the codebase
outside its own definition** (confirmed via a clean, zero-result grep). Dispatch is
synchronous, in-request, best-effort only — there is no async/durable retry loop,
and `processingStatus` is set once by the publisher and never revisited by any
consumer. This means: the event *envelope and production* side is strong and
reusable as-is; the *reliable delivery / retry / worker* side required by the spec
does not exist and must be built net-new (Stage 2/5).

**Verdict for Part 1 of the spec ("use the existing event system as source of
truth"):** **KEEP and EXTEND** `domainEvents`/`publishDomainEvent` as the single
source of truth. Do not build a second event table or a parallel event bus.

---

## 2. "Workflow" naming collision — critical finding

**Classification: DO NOT REUSE the name "workflow" for the new concept**

`packages/db/src/schema/workflow.ts` defines `workflows`, `workflowSteps`, and
`workflowChangeProposals` (94 + 214 lines respectively for the two service files
`workflowProposals.ts`/`workflowSteps.ts`, freshly re-confirmed this session, byte
counts unchanged since the original audit). This is a **per-property task-checklist
engine** — `workflows.status` is `Active | Completed | Abandoned`,
`workflowSteps.status` is `Pending | Ready | InProgress | Complete | Blocked`,
ordered steps against a `ReadyToList`/`Transaction` checklist type. It has nothing
to do with trigger-condition-action business-rule automation, and `workflows` has
no `brokerageId` column at all (tenant isolation is indirect, via `propertyId` →
property → brokerage — consistent with the rest of the app, not a new gap).
`workflowChangeProposals` (which I built in the prior Governance stage) adds a
DRAFT→PROPOSED→APPROVED→ACTIVE→SUPERSEDED→ARCHIVED versioning lifecycle for edits
to these checklists, and does carry `brokerageId` directly.

**This means the new spec's "workflow" (WHEN/IF/THEN automation rule) must be
named distinctly** to avoid confusion with this existing, unrelated, already-shipped
concept in both code and UI. Proposed name: **`AutomationRule`** (definition),
**`AutomationRuleVersion`** (versioned body), **`AutomationExecution`** (a run),
**`AutomationAction`** (one action within a run). This naming is used throughout
the rest of this document and the proposed implementation.

---

## 3. Property Timeline

**Classification: KEEP, but note the vocabulary split**

`apps/api/src/lib/timeline.ts::getPropertyTimeline()` (106 lines) is a read-only
projection over **`audit_logs`** (`packages/db/src/schema/audit.ts` — `userId,
userEmail, action, recordType, recordId, propertyId, previousValue, updatedValue,
providerReference, createdAt`), enriched with related party/AML/offer records at
query time, using its own `SIMPLE_LABELS` map keyed by `audit_logs.action` — a
separate vocabulary from `domainEvents.eventType`. The two systems currently run in
parallel: business logic publishes a `domainEvent` *and*, separately, writes an
`audit_logs` row for the human-readable timeline. Confirmed no unification exists
today.

**Verdict:** the new engine should read/write against `domainEvents` as its
authoritative trigger source (per Part 1 of the spec), and separately write to
`audit_logs` (the same way every other domain action in this codebase already
does) so that automation-triggered outcomes appear inline in the Property Timeline
the same way manual actions do — not a special case, not a new viewer.

---

## 4. Exception & Risk Engine

**Classification: MISSING (real gap) — closest existing analog is ephemeral, not
persisted**

`apps/api/src/lib/homeSummary.ts::getHomeSummary()` (Phase 8) is a live-computed,
**not persisted**, per-brokerage aggregation that reads current state directly to
surface `{exceptions, nextActions}` per property. Confirmed via grep: no
`dueDate`/`due_date` column exists anywhere in the schema, and no structured
Exception entity (owner, severity, deadline, resolution-state) exists — "overdue"
appears only as a prose comment in `homeSummary.ts`, not a real field.

**Verdict:** a persisted `Exception` table (owner, severity, deadline/dueAt,
sourceType, sourceId, status: Open/Acknowledged/Resolved/Escalated, resolvedAt,
resolvedBy) must be built net-new for Stage 5, distinct from and not replacing
`getHomeSummary()` (which can later be extended to read from it).

---

## 5. Background job / queue / scheduler / worker infrastructure

**Classification: MISSING (confirmed absent, not disguised)**

Confirmed via repeated targeted greps across `apps/api/src/lib/`,
`apps/api/src/routes/`, and `package.json` scripts: no cron, no queue library, no
scheduler, no worker process, no notification system of any kind exists anywhere in
the codebase (the one apparent grep hit during discovery was individually checked
and was a false positive — unrelated string match). `domainEvents.processingStatus`
is outbox-*shaped* but nothing ever reads it to retry.

**Verdict (per the spec's own instruction not to introduce unnecessary distributed
infrastructure):** build a **database-backed queue and worker**, not a new message
broker. Concretely: a new `automationExecutions`/`automationActions`-adjacent
"pending work" query against existing Postgres, polled by a lightweight in-process
worker loop (interval-based, using the existing `db:push`-managed schema, no new
infra dependency), with row-level locking (`FOR UPDATE SKIP LOCKED` or an
equivalent claim pattern) for safe concurrent execution and dead-letter handling via
a `status = 'DEAD_LETTER'` terminal state plus `attemptCount`/`maxAttempts`. This
satisfies "reliable, retryable, no duplicate consequential actions" without adding
Redis/SQS/etc.

---

## 6. Generic "task" concept (for TASK_COMPLETED / TASK_OVERDUE)

**Classification: MISSING beyond `workflowSteps`**

Confirmed: `workflowSteps` (the checklist-step entity, see §2) is the only
task-like entity in the schema, and it has no due-date field. There is no
standalone, assignable "Task" entity independent of a checklist.

**Verdict:** for Stage 6's `TASK_OVERDUE` template, the pragmatic, non-destructive
option is to add an optional `dueAt` column to `workflowSteps` (additive migration,
nullable, no data loss) and have the Stage 5 worker's periodic sweep publish
`TASK_OVERDUE` for any step past `dueAt` still not `Complete`. This avoids inventing
a second, competing task system inside this build, which is explicitly out of scope
per the spec's exclusions ("general scripting engine" etc. — a full task-management
rebuild is not requested and would be scope creep).

---

## 7. Tenant / role / entitlement / authority architecture

**Classification: KEEP — all reused as-is, re-confirmed fresh this session (not
assumed from the prior Governance audit)**

- `apps/api/src/middlewares/auth.ts` — re-checked this session, byte-identical
  (79 lines) to the version audited previously: 3-role model (`Agent`, `Brokerage
  Administrator`, `Pit Crew`), `req.authedUser = { id, role, brokerageId }`,
  `requireAuth`/`requireRole(...roles)`. Server-side, not a UI-layer check.
- `apps/api/src/lib/entitlements/resolver.ts` — the single, fail-closed,
  authoritative entitlement engine (`explainEntitlementDecision`/
  `requireEntitlement`, typed `DenialReasonCode` enum), wired into every route via
  `apps/api/src/middlewares/entitlement.ts`.
- `apps/api/src/lib/ai/` — the AI Governance/Authority/Action Control system built
  this session: `authority.ts` (5-level `AuthorityLevel` enum, `RiskTier`,
  `isAutoExecuteEligible()`), `actions/registry.ts` (closed action registry pattern
  distinguishing safe vs. consequential actions), `policyEngine.ts`
  (`evaluateAIAction()` — pure, fail-closed, 8 ordered checks →
  ALLOW/ALLOW_WITH_APPROVAL/DENY/BLOCK_*), `actionRequests.ts` (propose/approve/
  reject with tamper-evident canonicalized-key-order payload hashing),
  `executionGateway.ts` (sole caller of any registered action's `execute()`),
  `protectedOperations.ts` (startup self-check that crashes the app if a
  RESTRICTED-risk action is ever registered without going through the gateway).

**This is exactly the architecture the new spec requires for its central authority
decision** (ALLOW / ALLOW_WITH_APPROVAL / DENY / BLOCK_MISSING_CONTEXT /
BLOCK_MISSING_ENTITLEMENT / BLOCK_POLICY_CONFLICT maps directly onto the existing
`policyEngine.ts` outcome set with two additional BLOCK_* reasons to add). The new
Automation Action Registry must be a **new registry that calls through this same
`executionGateway`/`policyEngine`**, not a parallel authority path — this is the
single most important non-negotiable structural decision from the spec ("never let
a workflow definition grant itself additional authority") and this codebase already
has the correct shape to satisfy it without duplication.

**No mandatory stop condition is triggered here** — the authority architecture is
present, tested (53/54 tests passing, 1 skipped, from the Governance build), and
compatible.

---

## 8. Test / migration / API conventions

**Classification: KEEP — reuse existing conventions, no new tooling**

- Migrations: `drizzle-kit push` (schema-push, no versioned SQL files) — all new
  tables/columns in this build are additive (new tables, or nullable new columns on
  `workflowSteps`); nothing is destructive, nothing risks existing data.
- Tests: `tsx --test`, explicit per-module globs in `apps/api/package.json`'s
  `"test"` script. A new glob for the automation-engine test directory will be
  added the same way the AI/entitlements/billing/import globs were added earlier.
- API: existing Express route + middleware chain (`requireAuth` →
  `requireRole`/`requireEntitlement` → handler) — new routes follow the same
  pattern, tenant-scoped by `req.authedUser.brokerageId` server-side, never by any
  client-supplied value.

---

## Summary classification table

| Subsystem | Classification | Action for this build |
|---|---|---|
| `domainEvents` table + `publishDomainEvent` | KEEP (authoritative) | Add missing event types; add `aggregateType`/`aggregateId` columns |
| Event handler registry (`registerHandler`) | EXTEND | Register the new automation-rule dispatcher as its first real consumer |
| Reliable delivery / retry / worker | MISSING | Build net-new: DB-backed queue + poll worker (no new infra) |
| `workflows`/`workflowSteps` (checklist engine) | KEEP, unrelated | Do not touch; new concept gets a new name (`AutomationRule`) |
| `workflowChangeProposals` versioning pattern | REFERENCE PATTERN | Reuse the DRAFT→...→ARCHIVED lifecycle shape for `AutomationRuleVersion` |
| Property Timeline / `audit_logs` | KEEP | Write audit rows for automation outcomes, same convention as everything else |
| Exception & Risk Engine | MISSING (real gap) | Build a persisted `Exception` entity net-new (Stage 5) |
| Task / due-date concept | MISSING beyond `workflowSteps` | Add nullable `dueAt` to `workflowSteps`; no new task system |
| Job/queue/scheduler/worker/notifications | MISSING (confirmed absent) | Build DB-backed worker; notifications are new (Stage 5), routed through existing comms if any exist, else logged/audited only in this phase |
| Auth/role middleware | KEEP | No changes |
| Entitlement resolver | KEEP (authoritative) | New automation entitlement keys route through it, no parallel path |
| AI Governance/Authority/Action Control | KEEP (authoritative) | New Automation Action Registry calls through the existing `executionGateway`/`policyEngine`, not a new authority path |
| Migration/test/API conventions | KEEP | Same tooling, additive only |

**No case was found where building straightforwardly would require duplicating an
existing authority, tenant-isolation, or event-sourcing mechanism.** Every
"MISSING" item is a genuine, confirmed gap with a clear non-duplicative attachment
point onto something that already exists.

---

## Mandatory stop conditions — explicit check against all 10

1. Repo/branch state unconfirmable — **not triggered** (§0).
2. Prior architecture audit unlocatable — **not triggered** (§0).
3. Business event source of truth unidentifiable — **not triggered**, `domainEvents` is it (§1).
4. Tenant isolation absent/unreliable — **not triggered**, `brokerageId` propagation confirmed on events, entitlements, auth (§7).
5. Authority-control architecture missing/incompatible — **not triggered**, confirmed present and compatible (§7).
6. Database migration path unsafe — **not triggered**, all changes additive (§8).
7. Existing uncommitted changes overlap materially with this work — **not triggered**, tree is clean (§0).
8. Implementing the engine would require destructive changes — **not triggered** (§8).
9. Tests reveal a serious pre-existing security/data-integrity issue — **not triggered**; nothing found in this discovery pass rises to that level (the closest candidate, the AI entitlement stub being a second decision path, was already identified and fixed in the prior Governance build, not left open).
10. A critical architectural choice cannot be made safely from repository evidence — **not triggered**; the one genuine judgment call (naming the new concept to avoid the `workflows` collision) has a clear, low-risk resolution (`AutomationRule`) rather than an ambiguous one.

**Conclusion: no mandatory stop condition exists. Proceeding to Stage 2.**

---

## Proposed implementation sequence (unchanged from the spec's 8 stages)

1. ~~Stage 1 — Discovery~~ (this document).
2. Stage 2 — Core event/persistence foundation: extend `domainEvents` (new event
   types, `aggregateType`/`aggregateId`), add `AutomationRule`/
   `AutomationRuleVersion`/`AutomationExecution`/`AutomationAction` tables, DB-backed
   outbox-consumer worker skeleton, idempotency constraints.
3. Stage 3 — Deterministic condition/field/operator registries, ALL/ANY grouping,
   validation.
4. Stage 4 — Automation Action Registry + integration with the existing
   `executionGateway`/`policyEngine` for the central authority decision.
5. Stage 5 — Worker orchestration, retry/dead-letter, persisted `Exception` entity,
   structured audit/metrics logging (no sensitive values).
6. Stage 6 — 4 initial templates (Agency Agreement Signed, Offer Accepted,
   Settlement Completed, Task Overdue), created inactive/draft, never
   auto-activated.
7. Stage 7 — Secured API surface + guided (non-code) management UI, dry-run mode.
8. Stage 8 — Full test suite, manual end-to-end verification checklist, Final
   Report (sections A-F).

Each stage's foundational tests must pass before the next stage begins, per the
spec's explicit instruction.

## Open decisions flagged (none block starting Stage 2)

- **Naming**: proceeding with `AutomationRule`/`AutomationRuleVersion`/
  `AutomationExecution`/`AutomationAction` to avoid the `workflows` collision (§2).
  If a different name is preferred, it is a rename, not a redesign — flag now if so.
- **Notifications**: no notification system exists at all (§5). For this phase,
  "notify" actions in the Action Registry will write an audit-logged, in-app
  notification record only (no email/SMS integration exists to call) — this is
  consistent with the spec's scope exclusions (no "full communications campaign
  builder") and keeps the action safe/internal rather than external/consequential.
