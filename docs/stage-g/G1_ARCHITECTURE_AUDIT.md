# Stage G1 — Architecture Audit for AI Governance, Authority & Action Control

**Scope:** Per the governing spec's explicit non-negotiable requirement ("do not begin
implementation until this audit has established where the new architecture should
attach to the existing system"), every subsystem the 36-part spec touches was read
directly from the live AgentEngineEasy repo (not inferred from ARCHITECTURE.md alone)
before any code was written. This document is the KEEP / EXTEND / ADAPT / DO NOT TOUCH
/ MISSING classification the spec's FIRST TASK requires.

**Repo state note (relevant to how implementation should proceed):** `git status` shows
the `staging` branch is 6 commits ahead of `origin/staging`, with a large number of
modified and entirely untracked files (`apps/api/src/lib/ai/`, `apps/api/src/lib/entitlements/`,
`apps/api/src/middlewares/entitlement.ts`, `apps/api/src/routes/ai.ts`, `packages/db/src/schema/ai.ts`,
and more — i.e. all of "Phase 9" and the Stage A entitlement system exist only in this
Replit workspace, never pushed). This is a real data-loss risk independent of the
Governance work and worth a deliberate commit/push checkpoint before heavy new work
lands on top of it.

---

## 1. AI Authority Level / Risk Level framework (spec Parts 1, 2, 4)

**Classification: EXTEND**

`apps/api/src/lib/ai/types.ts` already defines `RiskLevel = 0 | 1 | 2 | 3 | 4`,
`RISK_LEVEL_DESCRIPTIONS`, and `AUTO_EXECUTE_CEILING: RiskLevel = 0`, and
`apps/api/src/lib/ai/orchestrator.ts` enforces it via `assertWithinAutoExecuteCeiling()`
(throws if `riskLevel > AUTO_EXECUTE_CEILING`), called at line 95 of `askCopilot()`
hardcoded as `assertWithinAutoExecuteCeiling(0)`. This is deliberately-built forward
scaffolding — ARCHITECTURE.md's own Phase 9 section calls it "a parallel action-risk-level
framework" that exists specifically so a future build doesn't have to invent one. The
new spec's 5-level Authority axis (OBSERVE/RECOMMEND/PREPARE/EXECUTE/SYSTEM_CHANGE) does
not map 1:1 onto the existing 0-4 Risk axis (they answer different questions — "how
sensitive is this action" vs. "how much autonomy does the AI have to act on it") but
they must compose, not duplicate: Authority Level should be a new, small enum module
that every action carries alongside its existing `riskLevel`, and `assertWithinAutoExecuteCeiling`
should become one input to the new Policy Engine rather than being replaced.

## 2. AI Action Registry / AIActionRequest entity (spec Part 5)

**Classification: EXTEND (strong)**

`packages/db/src/schema/ai.ts` already contains an `ai_action_requests` table
(`aiActionRequests`), explicitly commented as scaffolding for exactly this: *"Scaffolding
for the action-risk-level framework (Build Instructions §'Action Risk Levels', Level
0-4). Nothing in this build writes an 'executed' row: nothing implemented here lets the
AI independently execute Level 2+ actions. The table exists so a future Grow/Workflow AI
build has a durable place to request and record human-approved actions instead of
inventing one under time pressure."* Columns: `id, brokerageId, userId, interactionId
(→ai_interactions), actionType (text), riskLevel (int), payload (jsonb), status (text,
default "pending"), approvedByUserId (→users), resolvedAt, createdAt`.

Gaps vs. the new spec's Part 5 AIActionRequest shape: `status` is a free-text column
defaulting to `"pending"`, not the full PROPOSED → AWAITING_APPROVAL → APPROVED/REJECTED
→ EXECUTING → COMPLETED/FAILED/CANCELLED/EXPIRED state machine (Part 6); no rejection
reason, no execution result/error, no expiry, no actor-type column. Verdict: extend this
table with the missing columns and a real enum/constraint for `status`, don't create a
second table for the same concept.

## 3. Read-only Tool Registry (spec Parts 5, 9 context)

**Classification: DO NOT TOUCH / KEEP (build alongside, don't merge into)**

`apps/api/src/lib/ai/tools/registry.ts` (117 lines) — 6 tools, all `riskLevel: 0`,
brokerage-scoped via `ctx.property`/Context Engine tenant isolation, `selectToolsForContext()`
+ `runAllTools()`. This is purpose-built as read-only and works correctly as such. The new
write-capable Action Registry (spec Part 5) is a genuinely different concept — it needs
its own module (e.g. `apps/api/src/lib/ai/actions/registry.ts`) rather than extending this
one, so the read/write boundary stays a structural fact of the codebase, not a runtime
check that could be bypassed.

## 4. Central entitlement system (spec Parts 3, 17)

**Classification: KEEP (authoritative) / ADAPT the AI module's own stub to route through it**

`apps/api/src/lib/entitlements/` is a real, production-grade, fail-closed entitlement
engine (Grow Stage A): `resolver.ts` (138 lines) caches `entitlementGrants` per brokerage
(30s TTL), `explainEntitlementDecision()` returns a typed `EntitlementDecision` with a
`DenialReasonCode` enum (`NOT_AUTHENTICATED`, `TENANT_CONTEXT_REQUIRED`, `TENANT_MISMATCH`,
`ROLE_FORBIDDEN`, `ENTITLEMENT_MISSING`, `ENTITLEMENT_EXPIRED`, `SUBSCRIPTION_INACTIVE`,
`SEAT_NOT_ALLOCATED`, `LIMIT_REACHED`), and `requireEntitlement()` throws a typed
`EntitlementError`. `apps/api/src/middlewares/entitlement.ts` wires this into every route
as "the fourth access question, alongside requireAuth/requireRole's authentication and
role checks."

**This is the critical audit finding for Part 17 of the new spec** ("the AI must never
have an alternate route into Grow-gated functionality"): `askCopilot()` currently does
**not** call this system. It calls `isRoleEntitled(context.tier, role)` from the
AI-module's own `apps/api/src/lib/ai/entitlements.ts`, a 38-line stub with a hardcoded
`TIER_CAPABILITIES` table and a `resolveBrokerageTier()` that always returns `"STARTER"`
(documented in its own comment as a known gap pending a real subscription/tier concept
in the schema). Today this is low-risk only because the stub is *more* restrictive than
reality could ever be, not less — but it is a second, parallel entitlement decision path,
which is exactly what the spec's CRITICAL RULE prohibits building. **The Policy &
Permission Engine (Stage G3) must route AI authority/entitlement checks through
`explainEntitlementDecision`/`requireEntitlement`, and the AI-specific stub should be
adapted into a thin AI-role-to-entitlement-key mapping over the central system, not a
second source of truth.**

## 5. Auth / role middleware (spec Part 18's actor-type axis)

**Classification: KEEP**

`apps/api/src/middlewares/auth.ts` (79 lines): 3-role model (`Agent`, `Brokerage
Administrator`, `Pit Crew`), `req.authedUser = { id, role, brokerageId }`, `requireAuth`/
`requireRole(...roles)`. This is the existing USER/permission axis and is orthogonal to
the new spec's actor-type axis (USER/AI/PIT_CREW/ADMIN/SYSTEM) — no conflict, no
duplication risk. The new axis lives at the action-request level (who initiated this
specific action), not at the session-auth level, so it belongs on `aiActionRequests`
and on domain events, not in this middleware.

## 6. Event architecture / actor-type field (spec Part 11, Part 18)

**Classification: EXTEND**

`packages/db/src/schema/events.ts` — `domainEvents` table already has `actorType: text
("actor_type") // USER | SYSTEM | PIT_CREW | INTEGRATION`, plus `actorId`, `correlationId`,
`causationId`, `idempotencyKey`, `payload`/`metadata` jsonb, `processingStatus`,
`handlerErrors`, `attemptCount`, a unique idempotency-key index. This is materially more
mature than a minimal audit trail needs to be, and the `actorType` enum is one value away
(`AI`) from matching the new spec's actor-type axis. **AI_ACTION_* audit events (Part 11)
should be published through this exact table/publisher, adding `"AI"` as a valid
`actorType` value — not a new event system.**

## 7. General audit log (spec Part 11 — human-readable audit trail)

**Classification: KEEP / usable as-is for AI action audit, alongside `ai_interactions`**

`packages/db/src/schema/audit.ts` (19 lines) — simple `audit_logs` table (`userId,
userEmail, action, recordType, recordId, propertyId, previousValue, updatedValue,
providerReference, createdAt`), the ported Property-Timeline-projection pattern. An AI
action's human-readable trail can write here with `recordType: "ai_action"` the same way
every other domain action does, so the Property Timeline shows AI actions inline with
everything else rather than needing a separate viewer.

## 8. AI-specific audit/interaction tables (spec Part 11's per-request AI trail)

**Classification: KEEP**

`ai_interactions` and `ai_usage` (both in `packages/db/src/schema/ai.ts`) already give a
genuine per-request audit + cost trail: every `askCopilot()` call — including ones
blocked by a disabled flag or missing entitlement — writes an `ai_interactions` row
(`apps/api/src/lib/ai/audit.ts`, fire-and-forget, "a logging failure must never break the
response the user is waiting on"), and successful calls additionally write `ai_usage`
(tokens, cost, latency). This satisfies the spirit of Part 11 for the read/analysis side
already; it needs no changes for Stage G, only a new sibling write path for actions.

## 9. Orchestration layer — exact attachment point (spec Parts 2, 3, 6)

**Classification: EXTEND at a specific, now-identified line**

`apps/api/src/lib/ai/orchestrator.ts::askCopilot()` (193 lines) runs, in order: build
context (tenant-isolated) → `isRoleEntitled` (AI-stub entitlement check, see §4) →
`assertWithinAutoExecuteCeiling(0)` (**line 95** — hardcoded, read-only ceiling) → run
tool registry → call AI Gateway → `classifyResponseKind` → write `ai_interactions`/`ai_usage`.
**Line 95 is the precise point where the new Policy Engine (G3) and, for any future
write-capable role, the Execution Gateway (G6) attach**: today it's a static assertion
that nothing exceeds Level 0; the Governance work needs to turn this into a real
`evaluateAIAction()` call that can return "auto-execute", "requires approval", or "denied"
for higher levels, without changing anything about how `askCopilot()`'s read-only Copilot
path behaves today.

## 10. Provider-agnostic AI Gateway (context, not a Governance target)

**Classification: KEEP / not in scope for G-stages**

`gateway.ts` + `providers/provider.ts` (Mock + Anthropic, retry + single fallback) is the
"what can the AI know and say" layer; Governance is entirely about "what may the AI *do*"
and sits downstream of this, per the spec's own core principle keeping context and
authority separate. No changes needed here.

## 11. Five-role architecture (spec's role concept vs. actor-type concept)

**Classification: KEEP**

`apps/api/src/lib/ai/roles.ts` (50 lines) — `copilot` (implemented), `proactive_intelligence`,
`business_coach`, `workflow_ai`, `pitcrew_ai` (all `NotImplementedRole`, throw if called).
Feature-flagged per role in `featureFlags.ts` (`AI_ENABLED` master switch + per-role env
flags, all default off except copilot; checked server-side in the orchestrator, "never
only in the UI"). This is a clean, already-correct pattern for how new roles get added
later without becoming reachable before they're actually built — nothing to change for
Stage G itself, since Stage G only governs *actions*, not which roles exist.

## 12. Workflow / WorkflowStep versioning (spec Part 9)

**Classification: MISSING — genuine gap, needs new columns**

`packages/db/src/schema/workflow.ts` (37 lines): `workflows` (`id, propertyId,
workflowType: "ReadyToList"|"Transaction", status, createdAt, completedAt`) and
`workflowSteps` (`id, workflowId, stepKey, label, sequence, status: Pending|Ready|
InProgress|Complete|Blocked, blockedReason, completedAt, createdAt`). There is **no
version, history, or "changed by" column on either table** — every mutation happens
in place with no record of prior state beyond what the general `audit_logs`/`domainEvents`
tables separately capture. Part 9 ("Workflow Versioning & Rollback") is real net-new work:
add version/changedBy/previousStateSnapshot-style columns (or a companion
`workflow_step_versions` history table) rather than assuming anything here already
provides it. This should still attach to the existing `workflows`/`workflowSteps` tables,
not a parallel workflow engine — `lib/workflowSteps.ts` (214 lines, the existing
orchestration logic recomputing step status from live state) is the correct place to grow
this from.

## 13. User/role schema (spec Part 4/18 permission surface)

**Classification: KEEP**

`packages/db/src/schema/users.ts` (37 lines) — `USER_ROLES = ["Agent", "Brokerage
Administrator", "Pit Crew"]`, `brokerages`/`users` tables, deliberately small "grown by
decision, not accretion" per its own comment. No changes needed; Human Approval Engine
(Part 6) approver eligibility should key off this existing role, not invent a parallel
permission list.

## 14. Human Approval Engine, Execution Gateway, Ask Agent Engine action interface (spec Parts 6, 7, 15)

**Classification: MISSING — genuine net-new modules, but with clear attachment points already identified above**

No approval state machine, no execution gateway, and no action-capable Ask Agent Engine
response type exist anywhere in the repo today. These are real new work, not something to
extend from a near-miss. What the audit above establishes is *where* they attach:
Approval Engine reads/writes the extended `aiActionRequests` table (§2); Execution
Gateway is called from the orchestrator's line-95 attachment point (§9) and is the *only*
thing ever permitted to call existing domain service functions (`acceptOffer`,
`calculateCommission`, etc. in `lib/transactions.ts`, `lib/aml.ts`, `lib/payments.ts`) —
never a new copy of that business logic; the action-capable response type is an addition
to the existing `AiStructuredResponse` shape (`kind: fact|inference|recommendation|unknown`
in `types.ts`), adding `ACTION_PROPOSAL` alongside it rather than a new envelope format.

---

## Summary table

| Subsystem | Classification | Notes |
|---|---|---|
| Risk/Authority level framework | EXTEND | `types.ts` RiskLevel 0-4 + `assertWithinAutoExecuteCeiling` |
| AI Action Registry / AIActionRequest | EXTEND | `ai_action_requests` table pre-built as scaffolding |
| Read-only Tool Registry | DO NOT TOUCH | Build write-capable registry alongside, not inside |
| Central entitlement engine | KEEP (authoritative) | `entitlements/resolver.ts` — AI stub must route through it |
| AI-specific entitlement stub | ADAPT | Currently a second, parallel decision path |
| Auth/role middleware | KEEP | Orthogonal axis, no conflict |
| Domain event architecture | EXTEND | Add `"AI"` to existing `actorType` enum |
| General audit log | KEEP | Reuse for AI action audit trail |
| AI interaction/usage audit | KEEP | Already satisfies per-request AI audit |
| Orchestrator (`askCopilot`) | EXTEND | Attachment point identified: line 95 |
| AI Gateway | KEEP | Out of scope (context layer, not authority layer) |
| Five-role architecture | KEEP | No changes needed for Stage G |
| Workflow/WorkflowStep versioning | MISSING | Real gap — add version columns/history table |
| User/role schema | KEEP | Approval eligibility keys off existing roles |
| Approval Engine / Execution Gateway / Action response type | MISSING | Net-new, attachment points now established |

**No case was found where the spec's CRITICAL RULE would be violated by building
straightforwardly** — every "MISSING" item has a clear, non-duplicative attachment point
onto something that already exists, and the one real risk found (§4, the AI entitlement
stub as a parallel decision path) is a pre-existing gap this Governance work is well
positioned to close rather than worsen.
