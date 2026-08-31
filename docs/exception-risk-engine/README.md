# Exception & Risk Engine

Priority 4 build. Detects compliance and workflow risk across every active
property in a brokerage, turns each detection into a typed, tenant-scoped
**exception record** with a bounded lifecycle, and surfaces it to the people
who can act on it — without ever taking action itself.

This document is the architecture/operator reference (Build Instructions
§26). For a walkthrough of the feature running end-to-end in staging, see
`MANUAL_WALKTHROUGH.md` in this folder.

## What this is not

The engine detects and records. It does not decide, act, or clean up after
itself:

- No second workflow engine. Rule evaluation reads existing domain state
  (Appraisal, Listing, Offers, Contract Conditions, AML/CTF, Settlement,
  WAE task state) and writes exception records — it never mutates domain
  records, and it never calls a WAE action directly. A rule can *recommend*
  an action (`recommendedAction`, and for owned actions a link into the WAE
  action registry); a human decides whether to run it.
- No AI autonomy over exceptions. Ask Agent Engine can read and describe
  an exception's fields, but nothing in this system lets an AI open,
  acknowledge, escalate, resolve, or dismiss one at runtime (Build
  Instructions §19). Every state transition in `risk_exception_transitions`
  has a human `userId` actor.
- No silent absence-of-evidence-is-proof-of-completion. Rules that check
  "has X happened" only fire a PASS when the record shows completion; a
  missing or null field is treated as not-yet-done, never as done.

## Data model

Three tables in `packages/db/src/schema/exceptions.ts`, all `brokerageId`-scoped:

- **`risk_exceptions`** (43 columns) — one row per open-or-closed exception.
  Carries the full audit-friendly narrative for the record: category,
  severity, title, `problemDescription`, `businessImpact`, `detectedCause`,
  owner assignment, `recommendedAction`, `resolutionRequirements`,
  dismissibility, resolution/dismissal metadata, occurrence tracking
  (`occurrenceCount`, `lastDetectedAt`), and the two financial-redaction
  flags (`requiresFinancialEntitlement`, `redacted`).
- **`risk_exception_transitions`** (12 columns, immutable) — one row per
  status change: who, when, from/to status, note. This is the audit trail;
  nothing overwrites or deletes a row here.
- **`risk_exception_scan_runs`** (11 columns) — one row per detection pass
  (scheduled or manual), with counts (`brokeragesScanned`,
  `rulesEvaluated`, `exceptionsCreated`, `exceptionsUpdated`,
  `exceptionsAutoResolved`) and an `errorMessage` on partial failure. This
  is what the Engine Health panel reads.

**Severity** (`RISK_EXCEPTION_SEVERITIES`): `INFORMATION`, `ATTENTION`,
`AT_RISK`, `CRITICAL` — four levels, ascending.

**Status** (`RISK_EXCEPTION_STATUSES`): `OPEN → ACKNOWLEDGED →
IN_PROGRESS → AWAITING_EXTERNAL → RESOLVED` is the normal path;
`DISMISSED` is a terminal side-branch off `OPEN`/`ACKNOWLEDGED` for
rules marked `dismissible`; `REOPENED` is reachable if a rule re-detects
the same condition after resolution. Seven statuses total.

**Category** (`RISK_EXCEPTION_CATEGORIES`): `APPRAISAL_AGREEMENT`,
`LISTING`, `OFFERS`, `CONTRACT_CONDITIONS`, `AML_CTF`,
`SETTLEMENT_CLOSURE`, `WORKFLOW_OPERATIONAL`.

**Owner type** (`RISK_EXCEPTION_OWNER_TYPES`): `LISTING_AGENT`,
`TRANSACTION_OWNER`, `BROKERAGE_ADMINISTRATOR`, `PIT_CREW`,
`UNASSIGNED_QUEUE` — mapped from the app's existing 3-role model, not a
new role system.

## Rule registry and evaluation

`apps/api/src/lib/exceptions/registry.ts` exports `RISK_RULES`, assembled
from seven per-category files under `rules/` (`appraisalAgreement.ts`,
`listing.ts`, `offers.ts`, `contractConditions.ts`, `amlCtf.ts`,
`settlementClosure.ts`, `workflowOperational.ts`). Rule ids follow the
Build Instructions §10 catalogue numbering exactly (`A02_...`,
`B07_...`, `C13_...`, `E27_...`, `G39_...`); a handful of catalogue
numbers with identical detection logic are implemented as one merged rule
(e.g. `D20_29_SETTLEMENT_BLOCKED_BY_UNRESOLVED_CONDITION` covers
catalogue items 20–29), so the 40-item catalogue maps onto 30 concrete
`RiskRule` objects — the catalogue's rule *numbers* are complete; some
share an implementation rather than duplicating it.

Every rule is code, not configuration pulled from a table — this is
deliberately a controlled registry (Build Instructions §8), not a
mechanism to add arbitrary user-authored rules at runtime.

**One detection function, two triggers.** Each rule exposes a single
`scanBrokerage(brokerageId, now)` method. `apps/api/src/lib/exceptions/engine.ts`
calls that same method from both:

- **Event-driven**: `handleExceptionDomainEvent(event)`, invoked when a
  relevant domain event fires (offer accepted, condition resolved, AML
  status changed, etc.) — evaluates just the rules relevant to that event
  for the affected brokerage, so a change is reflected in near real time.
- **Time-driven**: `runScheduledScan(trigger)` → `scanBrokerageForExceptions`,
  a full sweep across every rule for every brokerage — the scheduled
  fallback that catches anything event-driven evaluation missed (a
  condition that becomes overdue purely because time passed, for
  example), and the same path a manual "Run Scan Now" click takes.

Because both triggers share one evaluation function, there's no risk of
the two modes drifting into different answers for the same input.

## Deduplication, ownership, escalation

**Dedup key** — `rules/shared.ts`'s `dedupKey(ruleId, brokerageId, scope)`
returns `` `${ruleId}:${brokerageId}:${scope}` ``, where `scope` is the
entity the rule is evaluating (a property id, transaction id, condition
id, or a composite like `propertyId:partyId` for per-party rules like
AML/CTF). Re-detecting the same condition updates the existing row's
`occurrenceCount` / `lastDetectedAt` rather than creating a duplicate
exception — this is what keeps a flapping condition from spamming the
Exceptions list.

**Ownership** maps to the existing three-role model (Listing Agent,
Transaction Owner/Pit Crew, Brokerage Administrator) plus an
`UNASSIGNED_QUEUE` fallback; brokerage admins can reassign owner type and
user via the reassign action, which is recorded as its own transition
with a reason.

**Escalation** is time-based (`escalatesAt`) and read-only from the
engine's side — it raises visibility (surfaces in admin-facing views,
can inform severity on re-evaluation) but never auto-executes a WAE
action or changes status on its own.

## Security and tenancy (§19–22)

- Every query and mutation in `apps/api/src/lib/exceptions/queries.ts`
  and `routes/exceptions.ts` runs through the same tenant chokepoint
  (`assertPropertyInBrokerage`) as the rest of the app — cross-tenant
  requests get a 404, not a 403, so existence is never leaked.
- Financial/commission-relevant exceptions carry
  `requiresFinancialEntitlement: true`; a non-entitled caller sees the
  row with sensitive fields redacted (`redacted: true`) rather than the
  row being hidden outright, matching the pattern already used elsewhere
  for financial data (`BROKERAGE_ADMIN_ROLES` / `requiresFinancialEntitlement`).
- `ops/health` and `ops/scan` are gated with `requireRole(...BROKERAGE_ADMIN_ROLES)`
  — a non-admin never even sees the Engine Health card client-side, and
  the server enforces it independently of what the client renders.
- Every transition writes an immutable row to `risk_exception_transitions`
  with the acting user id — full lifecycle audit trail, per §22.

## API surface

All under `apps/api/src/routes/exceptions.ts`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/properties/:propertyId/exceptions` | Property-level list + summary (`openCount`, `highestSeverity`, `byStatus`) |
| GET | `/exceptions` | Cross-property list, filterable (severity/status/search/overdue), paginated |
| GET | `/exceptions/:id` | Single exception detail |
| POST | `/exceptions/:id/acknowledge` | OPEN/REOPENED → ACKNOWLEDGED |
| POST | `/exceptions/:id/start-remediation` | ACKNOWLEDGED/REOPENED → IN_PROGRESS |
| POST | `/exceptions/:id/awaiting-external` | → AWAITING_EXTERNAL, with note |
| POST | `/exceptions/:id/resolve` | → RESOLVED, with note |
| POST | `/exceptions/:id/dismiss` | → DISMISSED (dismissible rules only), with reason |
| POST | `/exceptions/:id/reassign` | Change owner type/user, with reason |
| GET | `/exceptions/ops/health` | Recent scan run history (admin only) |
| POST | `/exceptions/ops/scan` | Trigger a manual scan (admin only) |

## Frontend surfaces (§16–18)

Two new UI surfaces, both built to the app's existing hand-written CSS
design system (no new component library, no fourth pill colour):

- **Property Workspace "Exceptions" panel** (`apps/web/src/pages/PropertyWorkspace.tsx`) —
  shown above Tasks & Attention when a property has any exceptions.
  Summary line, per-exception card with severity/status pills, a
  `<details>` progressive-disclosure block for business impact /
  recommended action / resolution requirements / detected count, and
  status-conditional lifecycle action buttons. It only calls the
  existing routes above — it makes no lifecycle decisions itself.
- **Cross-property `/exceptions` page** (`apps/web/src/pages/Exceptions.tsx`) —
  filterable, paginated list across every property the caller can see
  (server-enforced, not client-filtered), plus the admin-only Engine
  Health card. Explicitly scoped per §18 as a *foundation* for the future
  Agent Daily Command Centre — one list view, not a dashboard.
- **Property Timeline** needed zero frontend changes: `risk_exception_*`
  domain events already map to `category: "Compliance"` server-side
  (`apps/api/src/lib/timeline.ts`) and the existing generic Timeline
  renderer picks them up automatically. Verified live in staging — see
  `MANUAL_WALKTHROUGH.md`. Only the exception-*opened* event surfaces on
  the Timeline; intermediate status transitions (acknowledge, start
  remediation, etc.) are recorded in `risk_exception_transitions` for
  audit but deliberately don't add further Timeline noise for every
  micro-status-change — a design decision made when the Timeline
  integration itself was built, not something introduced by the UI work
  in this segment.

## Testing

- `apps/api/src/lib/exceptions/__tests__/engine.test.ts` — evaluation
  engine (5 cases)
- `apps/api/src/lib/exceptions/__tests__/model.test.ts` — data model,
  dedup, lifecycle transitions (19 cases)
- `apps/api/src/routes/__tests__/exceptions.test.ts` — route-level
  tenant isolation, entitlement redaction, role gating (12 cases)

Full workspace suite at time of writing: 260 tests, 259 pass, 1
pre-existing skip, 0 fail — the exception-engine suite integrates
cleanly with the rest of the app.

## Operating the engine

- **Scheduled scans** run automatically (see recent `SCHEDULED` runs in
  Engine Health); a brokerage admin can also trigger an immediate
  `MANUAL` scan from the `/exceptions` page.
- A scan run that partially fails records `status: FAILED` with an
  `errorMessage` on that run row rather than silently dropping
  detections for the brokerages that did succeed.
- If a rule needs to change, edit its file under `rules/` and add/update
  its test — the registry has no runtime-configurable state to reach for
  instead.
