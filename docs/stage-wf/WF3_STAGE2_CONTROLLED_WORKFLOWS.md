# WF3 — WAE Stage 2: Controlled Production Workflows

Status: **Stage 2 implemented, pending CI verification and review.**
Branch: `feat/wae-controlled-workflows`, created from `origin/staging` @
`5554ec9674f85613bac50ac370c5594379e43df4` (the WAE Foundation merge commit,
confirmed on `origin/staging` before any Stage 2 code was written).
Prior docs: `docs/stage-wf/WF1_DISCOVERY.md` (Foundation discovery),
`docs/stage-wf/WF2_FOUNDATION_IMPLEMENTATION.md` (Foundation implementation
and verification).

## 1. Objective

Prove that genuine Agent Engine events produce safe, visible, auditable
operational outcomes, using the WAE Foundation exactly as built — no second
workflow engine, no bypass of Stage 1's controls. Pattern: *domain event →
eligible workflow → conditions → authority decision → registered action →
execution evidence.* This stage does not build a workflow-management UI, a
drag-and-drop builder, or the full Exception & Risk Engine — see §10.

## 2. What Stage 2 adds, and what it deliberately reuses unchanged

Reused unchanged from the Foundation: `engine.ts`'s evaluate/execute loop,
`bootstrap.ts`'s generic per-event-type handler registration (already covers
every canonical event type, including the four new triggers below — zero
changes needed), `conditions.ts`/`templating.ts`'s closed operator set and
`$event.<path>` substitution, and the entire AI Governance pipeline
(`policyEngine.ts`, `actionRequests.ts`, `executionGateway.ts`).

New in Stage 2:

| File | Responsibility |
| --- | --- |
| `packages/db/src/schema/automation.ts` (extended) | Two new tables: `automation_tasks`, `automation_attention_items`. |
| `apps/api/src/lib/automation/types.ts` (extended) | `AUTOMATION_TASK_KEYS` (closed vocabulary, 23 keys across the 5 workflows), `AUTOMATION_ATTENTION_REASON_CODES`, `PROTECTED_FUTURE_ACTION_KEYS`. |
| `apps/api/src/lib/automation/facts.ts` (extended) | Additive: flattens `eventId`/`correlationId`/`causationId` onto the facts record alongside the fields the Foundation already exposed, so a rule template can set a task's `originatingEventId` to `"$event.eventId"`. Nothing existing reads these paths, so Foundation-stage tests are unaffected. |
| `apps/api/src/lib/automation/tasks.ts` (new) | `createAutomationTask` (create-or-supersede, idempotent), `assignAutomationTaskToRole`. |
| `apps/api/src/lib/automation/attentionItems.ts` (new) | `raiseAttentionItem` (idempotent), `resolveAttentionItem`. |
| `apps/api/src/lib/automation/rules.ts` (extended) | One additive export, `getAutomationRuleByTemplateKey`, so re-running the Stage 2 installer against a brokerage extends an existing rule instead of duplicating it. |
| `apps/api/src/lib/automation/templates.ts` (extended) | The five Stage 2 workflow templates (§4) and `installStage2WorkflowCatalogue`. |
| `apps/api/src/lib/ai/actions/registry.ts` (extended) | Five new registered actions (§5). |

## 3. Verification gate — WAE Foundation confirmed before any Stage 2 code

Per this stage's own instructions, the Foundation was verified on
`origin/staging` before any implementation began: PR #5 merged (merge commit
`5554ec9674f85613bac50ac370c5594379e43df4`), confirmed as `origin/staging`'s
HEAD, all ten Foundation components (versioning, event triggers, condition
evaluation, controlled action registry, execution/action records,
idempotency, tenant isolation, entitlement enforcement, authority/approval
controls, audit/correlation/causation, retry/failure handling) present and
covered by `engine.test.ts`/`rules.test.ts`/`conditions.test.ts` on that
commit. Recorded verbatim: **WAE FOUNDATION VERIFIED — STAGE 2 AUTHORISED.**

## 4. The five-workflow catalogue

Every workflow below is composed only of the six Stage 2-permitted actions
(§5), uses a deterministic condition group (no free-form config), and is
tenant-scoped and versioned via the unchanged `automationRules` /
`automationRuleVersions` tables.

### Workflow 1 — Agency Agreement Signed

Trigger: `AGENCY_AGREEMENT_SIGNED`. Installed as **version 2 of the existing
Foundation-stage rule** (`installAgencyAgreementSignedStage2Version`,
`createRuleVersion` on the same `ruleId` — never a second rule), per "do not
repeat the completed foundation work." Condition unchanged from v1
(`propertyId exists`). Actions: `CREATE_INTERNAL_TASK` ×4 — confirm AML/CTF
requirements, verify registered property owners, prepare listing-launch
requirements, request missing property/campaign information. None of these
order AML, publish a listing, engage a supplier, or incur a cost — each one
only creates the task that prompts a human to make that call.

### Workflow 2 — Offer Accepted

Trigger: `OFFER_ACCEPTED` (already published in production by
`apps/api/src/lib/transactions.ts`'s `acceptOffer()`, with a real
`transactionId`). Condition: `propertyId` and `transactionId` both exist.
Actions: `CREATE_INTERNAL_TASK` ×5 — prepare/confirm contract documentation,
confirm buyer/seller legal representatives, record required transaction
dates and conditions, follow up on exchange/unconditional status, identify
missing transaction information. None sends a binding instruction, alters a
contract, or initiates financial activity.

### Workflow 3 — Contract Signed

Trigger: `CONTRACT_SIGNED` (published by `recordContractSigned()`).
Condition: `propertyId` and `transactionId` both exist. Actions:
`CREATE_INTERNAL_TASK` ×5 — confirm exchange status, capture
finance/building-pest/cooling-off/other condition dates, create
deadline-based follow-ups, identify missing legal-representative
information, prepare settlement tracking.

**Documented gap, not a fabricated capability**: `recordContractSigned()`
currently publishes `CONTRACT_SIGNED` with an empty payload — the
`transactions` schema has no structured per-condition date columns yet
(`offers.conditions` is free-form jsonb captured at offer stage and is never
carried onto the transaction or this event). Rather than invent a payload
shape nothing publishes, "capture condition dates" is implemented as a
deterministic task prompting a human to capture them — the same honest
"documented gap" precedent the Foundation stage set for
`AGENCY_AGREEMENT_SIGNED` having zero production publishers at the time.
See §9.

### Workflow 4 — Settlement Scheduled

Trigger: `SETTLEMENT_SCHEDULED` (published by `scheduleSettlement()`, always
carrying `payload.settlementDate`). Split into **two rules** under the same
trigger — the one workflow where a required field's absence is a fact the
engine can evaluate directly from the event, so it gets a genuine
conditional fail-safe rather than a prompting task:

- **Prepare** (`SETTLEMENT_SCHEDULED_PREPARE`): condition requires
  `payload.settlementDate` to exist. Actions: `CREATE_INTERNAL_TASK` (confirm
  settlement date/time), `CREATE_REMINDER` (pre-settlement milestone,
  `dueAt` = the authoritative `payload.settlementDate`, never re-derived),
  `CREATE_INTERNAL_TASK` ×2 (identify unresolved conditions; prepare
  internal pre-settlement tasks).
- **Missing-date fail-safe** (`SETTLEMENT_SCHEDULED_MISSING_DATE`):
  condition requires `payload.settlementDate` to be absent. Action:
  `RAISE_ATTENTION_ITEM` (`reasonCode: MISSING_SETTLEMENT_DATE`) instead of
  proceeding.

A later, genuine reschedule (a second `scheduleSettlement()` call with a
different date) **supersedes** the prior reminder rather than overwriting
it in place — see §7.

### Workflow 5 — Settlement Completed

Trigger: `SETTLEMENT_COMPLETED` (published by `completeSettlement()`).
Condition: `propertyId` and `transactionId` both exist. Actions:
`CREATE_INTERNAL_TASK` ×5 — confirm the transaction record is complete,
prepare a commission-processing checklist, a record-retention/closure
check, prepare a permitted (internal-only) client follow-up, prepare the
property/transaction for closure. Commission is never calculated,
transferred, reconciled, or released here — that remains the existing,
unmodified `calculateCommission()`.

## 5. Registered actions

Extended the registry (`apps/api/src/lib/ai/actions/registry.ts`) with five
new entries, plus reuse of the existing `PROPERTY_NOTE_ADD` — six permitted
action types total, matching the spec's list exactly ("creating an internal
task; creating a reminder; assigning a task to an authorised internal role;
recording a workflow-generated note; raising an internal exception/attention
item; requesting approval for a protected future action"):

| Action key | Authority / risk | What it does |
| --- | --- | --- |
| `CREATE_INTERNAL_TASK` | EXECUTE / 0 | Creates (or supersedes) an `automation_tasks` row from the closed `AUTOMATION_TASK_KEYS` vocabulary. |
| `CREATE_REMINDER` | EXECUTE / 0 | Same as above with `kind: REMINDER` and a required, validated ISO `dueAt`. |
| `ASSIGN_TASK_OWNER` | EXECUTE / 0 | Re-assigns the current ACTIVE task for a property/taskKey to an authorised internal role (`USER_ROLES`). Named to avoid `protectedOperations.ts`'s `"ROLE"` denylist fragment — the field is `assignedRole`, the action key deliberately is not. |
| `RAISE_ATTENTION_ITEM` | EXECUTE / 0 | Creates (idempotently) an `automation_attention_items` row from the closed `AUTOMATION_ATTENTION_REASON_CODES` vocabulary. |
| `REQUEST_ACTION_APPROVAL` | EXECUTE / 2 (MEDIUM) | Always requires approval (`isAutoExecuteEligible` is false for authority EXECUTE + risk MEDIUM). Once approved, records that a human approved proceeding **manually, outside this system** with one of the closed `PROTECTED_FUTURE_ACTION_KEYS` (e.g. `ORDER_AML_VERIFICATION`, `PUBLISH_LISTING`) — it never performs the protected action itself; there is no registered, executable path for any of them. Registered and fully tested but **not wired into any of the five production templates** — every in-scope Stage 2 outcome is itself internal/reversible and does not need approval; this action exists for a future workflow that references a genuinely protected action. |
| `PROPERTY_NOTE_ADD` | EXECUTE / 0 (reused, unchanged) | Workflow 1 v1's original note action; untouched by Stage 2. |

Every new action: has a typed zod `inputSchema`; is validated for
tenant/property/transaction consistency inside its domain function
(`tasks.ts`/`attentionItems.ts`); requires no new entitlement; carries its
own idempotency behaviour (§7); produces a full `aiActionRequests` +
`automationActions` audit row via the unmodified `proposeAIAction`/
`executeAIAction` pipeline; has a defined success/failure/retry
classification (identical to every other action — `engine.ts`'s retry
logic is action-agnostic); and is covered by dedicated tests (§9). No
action performs arbitrary code execution, unrestricted HTTP, or a direct
database operation outside its own two new tables.

## 6. Authority and approval boundaries

Unchanged from the Foundation: every action proposal still runs through
`evaluateAIAction()` as `actorType: "SYSTEM"`, still resolves the acting
authority from the rule version's `approvedByUserId` (never a synthetic or
inherited actor), and still fails closed (`BLOCKED`) if that approver can no
longer be verified. All five new actions are `riskLevel 0` (LOW tier) except
`REQUEST_ACTION_APPROVAL` (`riskLevel 2`, MEDIUM), which is deliberately
never auto-execute-eligible. Approval, when required, is enforced entirely
by the existing `aiActionRequests` state machine — never a boolean flag a
workflow sets on itself — and an approved request executes exactly the
recorded action (§5's `REQUEST_ACTION_APPROVAL` row) and nothing else.

## 7. Idempotency and supersede strategy

Two independent, deliberately layered idempotency boundaries:

1. **Duplicate-event-delivery protection** (unchanged Foundation
   infrastructure): `event_processing_receipts` + `automation_executions`'s
   unique index on `(ruleVersionId, triggeringEventId)` guarantee a
   redelivered event can never be *attempted* twice.
2. **Business-level idempotency** (new, in `tasks.ts`/`attentionItems.ts`):
   a read-then-write check against the current ACTIVE/OPEN row for the same
   `(property-or-transaction, taskKey/reasonCode)` scope — the same
   check-then-act convention every other domain service in this codebase
   already uses for business-rule idempotency (`acceptOffer`'s sibling-offer
   handling, `scheduleSettlement`'s reschedule handling), not a DB unique
   constraint. An identical repeat call is a no-op (`UNCHANGED`/
   `ALREADY_OPEN`). A **materially different** value (a rescheduled
   settlement date) **supersedes** the prior row — `status: SUPERSEDED`,
   `supersededByTaskId` set — and inserts a fresh `ACTIVE` row, so the
   superseded instance survives as historical evidence rather than being
   overwritten.

## 8. Task/reminder and failure/retry behaviour

Tasks and reminders share one table (`automation_tasks`, `kind: TASK |
REMINDER`) and one lifecycle (`ACTIVE → COMPLETED | SUPERSEDED |
CANCELLED`). A reminder's `dueAt` always comes from an authoritative
event-carried date (`$event.payload.settlementDate`), never a value
recomputed by automation itself; `originatingField` records which field it
came from. No general-purpose scheduler exists in this codebase and Stage 2
does not build one (out of scope, §10) — `automation_tasks` is the safe,
durable record a future scheduler would read from; that dependency is
recorded as deferred (§9).

Retry/failure classification is entirely the unmodified Foundation
mechanism (`engine.ts`'s `retryAutomationAction`, the
`NON_RETRYABLE_ERROR_PATTERN` classifier): a Stage 2 action fails and
retries through the exact same code path as `PROPERTY_NOTE_ADD` always did,
proven directly in `stage2Engine.test.ts`'s retry test against
`CREATE_INTERNAL_TASK`.

## 9. Exception integration and other deferred items

`automation_attention_items` is Stage 2's smallest compatible interface onto
a future Exception & Risk Engine (`EXCEPTION_CREATED`/`EXCEPTION_RESOLVED`
already exist in the canonical event catalogue with zero publishers). It
records the closed set of conditions a workflow cannot proceed past
(currently `MISSING_SETTLEMENT_DATE`, wired into Workflow 4; the vocabulary
also reserves `MISSING_REGISTERED_OWNER`, `MISSING_LEGAL_REPRESENTATIVE`,
`CONDITION_WITHOUT_DUE_DATE`, `INCOMPLETE_TRIGGERING_EVENT`, `OTHER` for a
future stage or a future Exception & Risk Engine to both publish against and
read from) without building that engine's full
routing/escalation/ownership model. "Wrong-tenant event", "authority not
held", and "entitlement unavailable" are **not** separately re-implemented
here — they are already fully and correctly handled by the unmodified
Foundation engine/policy layers (tenant-scoped rule lookup; the
authority-verification `BLOCKED` path; `evaluateAIAction`'s
`ENTITLEMENT_DENIED` branch), and are proven against Stage 2 triggers in
`stage2Engine.test.ts` rather than re-invented.

Other genuine, honestly-documented gaps carried forward into a future stage:

- **Condition/date fields not yet on the domain event payload** (Workflow
  3, §4) — requires new structured columns on `transactions` (or a
  dedicated conditions table) plus publishing them from
  `recordContractSigned()`/wherever they're captured. Out of scope here per
  "unrelated refactors."
- **No general-purpose scheduler** (§8) — `automation_tasks`/reminders are
  the safe record; nothing polls them yet. A future worker reading
  `dueAt`/`status = ACTIVE` rows to fire `TASK_OVERDUE` (already a canonical
  event type, zero publishers) is the documented integration point.
- **`AGENCY_AGREEMENT_SIGNED` still has zero production publishers** —
  unchanged from the Foundation stage; Workflow 1 is fully functional and
  fully tested against a directly published event in the interim.

## 10. Explicitly out of scope (unchanged from the brief)

Drag-and-drop workflow builder; broad workflow administration UI;
user-created executable workflow logic; autonomous AI workflow creation;
external email/SMS delivery; unrestricted webhooks; third-party supplier
orders; AML verification orders; listing publication; contract alteration;
trust-account/payment activity; commission calculation/payment; the full
Communications Hub; the full Exception & Risk Engine; the Financial
Transaction Engine; Pit Crew automation; unrelated UI redesigns/refactors.

## 11. How to add another workflow safely

1. Add any new task keys / attention-item reason codes to the closed
   vocabularies in `apps/api/src/lib/automation/types.ts` — never a
   free-form string.
2. If a genuinely new action type is required, register it in
   `apps/api/src/lib/ai/actions/registry.ts` with a typed `inputSchema`,
   backed by a plain domain function (never touch the database from the
   registry itself), and check its `actionKey` against
   `protectedOperations.ts`'s forbidden-fragment list before naming it.
3. Write the condition group and action list as a new
   `createAutomationRule` + `createRuleVersion` pair in `templates.ts` (or a
   new version on an existing rule via `getAutomationRuleByTemplateKey`, if
   extending one of these five). Reuse `eventFieldExists()` for simple
   existence checks.
4. `approveAndActivateRuleVersion` is a separate, explicit step — installing
   a template never makes it live.
5. If the new workflow can plausibly receive an event missing a field its
   actions need, add a second, inverse-condition rule under the same
   trigger (Workflow 4's pattern) that raises an attention item instead of
   guessing.

## 12. Deliverables

See the final PR description / task report for: feature branch name and PR
link; baseline commit; files changed; DB/migration summary; verification
results (install/typecheck/lint/migrate/schema-drift/test/build); evidence
of idempotency, tenant/authority enforcement, and end-to-end workflow
execution; and the final `READY FOR WAE STAGE 2 REVIEW` / `BLOCKED`
decision.
