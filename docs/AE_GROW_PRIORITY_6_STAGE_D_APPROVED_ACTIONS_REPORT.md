# AE GROW Priority 6 — Stage D: AI-Proposed, Human-Approved Follow-Up Actions

**Status:** IN PROGRESS — Entry gate and pre-implementation governance audit complete. Implementation not yet started.

**Scope:** Exactly one new AI action type — `CREATE_GROW_COMMITMENT`. No other action type is introduced in this stage.

**Governing instruction:** Project Owner Authorisation, "AE Grow Priority 6 Stage D — AI-Proposed, Human-Approved Follow-Up Actions," received after Stage C's merge to `staging` (merge commit `847da0f9b2ba6b6cf6737e1a5264de807075115b`, closing PR #36).

**Explicit exclusions for this stage (do not build):** voice input, telephony/calls, call recording, transcription, automated email/SMS sending, automatic creation of opportunities, appraisals, campaigns, or transactions. This stage covers only a proposed *commitment* (a follow-up task against a contact), created solely after explicit human approval.

**Business outcome this stage enables:** Ask AE or Business Coach can notice something like "follow up with Sarah about the appraisal before Friday" and prepare a *proposed* commitment (contact, reason, suggested follow-up, due date, related property/opportunity where available, supporting evidence). Nothing is created until the authenticated agent reviews and explicitly approves it. The system must never imply an action has been completed merely because it was suggested.

---

## 1. Entry Gate

| # | Requirement | Result |
|---|---|---|
| 1 | Fetch latest `staging` | Done — `GET` commit for ref `staging` |
| 2 | Verify tip SHA | Confirmed: `847da0f9b2ba6b6cf6737e1a5264de807075115b` (re-verified immediately before branch creation, unchanged since Stage C closure) |
| 3 | CI run succeeded against this exact SHA | Confirmed during Stage C post-merge closure: run #324 (id `34741441288`), conclusion Success, duration 18m22s, all 19 required steps individually inspected via per-step DOM `data-conclusion` attributes, tested SHA on each step's log URL matched `847da0f9b2ba6b6cf6737e1a5264de807075115b` |
| 4 | Stage B and Stage C present on `staging` | Confirmed by direct re-read of `apps/api/src/routes/ai.ts`, `apps/api/src/lib/ai/orchestrator.ts`, `apps/api/src/lib/ai/tools/registry.ts`, `apps/api/src/lib/ai/coaching/timezone.ts`, `apps/api/src/lib/ai/entitlements.ts`, `apps/api/src/lib/ai/coaching/metrics.ts` and `period.ts`, fetched fresh from `ref=refs/heads/staging` (not the old PR branch) |
| 5 | Working tree clean | N/A / satisfied by construction — this workflow has no local clone; all changes are made as discrete, reviewed commits through the GitHub API, so there is no uncommitted or stray state to check |
| 6 | Create branch `feat/ae-grow-priority-6-stage-d-approved-actions` | Created from `staging` at the SHA above |
| 7 | Record starting SHA | `847da0f9b2ba6b6cf6737e1a5264de807075115b` |
| 8 | Create this report | This file, on the new branch |

Entry gate: **PASSED**. No blocking condition encountered.

---

## 2. Pre-Implementation Governance Audit

Before any code was written, the existing codebase was audited to answer the gating question: *can the existing schema and AI-governance pipeline support `CREATE_GROW_COMMITMENT` safely, without a migration and without a new billing entitlement?* The answer is **yes**, for the reasons below.

### 2.1 A generic propose → approve → execute pipeline already exists

This pipeline pre-dates and is independent of the "AE Grow Priority N" feature track. It is not Grow-specific; it is the platform's general AI-action governance layer, and Stage D's job is to add one new registry entry to it, not to build new infrastructure.

- **`apps/api/src/lib/ai/authority.ts`** defines two orthogonal axes: `AuthorityLevel` (1 OBSERVE, 2 RECOMMEND, 3 PREPARE, 4 EXECUTE, 5 SYSTEM_CHANGE) and a 0–4 `riskLevel` mapped to a `RiskTier` (LOW/LOW/MEDIUM/HIGH/RESTRICTED). `isAutoExecuteEligible(authorityLevel, riskTier)` is the single lever that decides whether a proposal can auto-execute or must wait for a human: it returns `false` for RESTRICTED tier, `false` for `authorityLevel >= SYSTEM_CHANGE`, and otherwise `true` only when `authorityLevel <= RECOMMEND || riskTier === 'LOW'`.
- **`apps/api/src/lib/ai/actions/registry.ts`** is the central `ACTION_REGISTRY` allowlist. There is no generic "update database" or "run SQL" capability anywhere in it — every action is a named, narrowly-scoped definition carrying its own `allowedRoles` (the Golden Rule already enforced here: AI can never exceed the authenticated human's own manual role) and `allowedActorTypes` (`USER | AI | PIT_CREW | ADMIN | SYSTEM`).
- **`apps/api/src/lib/ai/protectedOperations.ts`**'s `assertNoProtectedOperationsRegistered()` runs at startup and crashes the app if any registered action's key matches a forbidden fragment (AML, COMPLIANCE, LEDGER, COMMISSION, ENTITLEMENT, ROLE, PERMISSION, SCHEMA, SECURITY, AUTH, GOVERNANCE, USER_DELETE, USER_CREATE, CREDENTIAL, PASSWORD, SQL) or has `riskLevel >= 4`. `CREATE_GROW_COMMITMENT` matches none of these fragments and is being designed at `riskLevel` 2, so it will not trip this guard.
- **`apps/api/src/lib/ai/policyEngine.ts`**'s `evaluateAIAction()` / `evaluateAIActionCore()` is the single pure, fail-closed decision function. Both proposal creation and execution route through it — execution re-evaluates it immediately before running (defense in depth), so a policy change or a revoked entitlement between approval and execution is caught.
- **`apps/api/src/lib/ai/actionRequests.ts`** already implements the exact state machine Stage D needs: `PROPOSED → AWAITING_APPROVAL → APPROVED → EXECUTING → COMPLETED / REJECTED / EXPIRED / FAILED`, a SHA-256 tamper hash over the canonicalized, key-sorted input payload computed at proposal time and re-verified at approval and execution, a 24-hour default expiry, and conditional `UPDATE ... WHERE status = X` writes everywhere a race could otherwise allow double-approval or double-execution.
- **`apps/api/src/lib/ai/executionGateway.ts`**'s `executeAIAction()` is the sole caller of any action's `execute()`. It claims execution via `UPDATE ... WHERE status = 'APPROVED'`, so only one concurrent caller can ever win — this is the existing, already-generic no-double-execution mechanism; Stage D does not need to invent its own.
- **`apps/api/src/routes/ai-actions.ts`** already exposes generic `GET /`, `POST /:actionKey/propose`, `GET /requests/:id`, and `POST /requests/:id/{approve,reject,execute}`. Critically, `actorType` is hard-coded to `"USER"` in this router and is never accepted from the client. This is *why* AI is structurally unable to call approve, reject, or execute as a human substitute today, before Stage D adds any code — the AI-initiated path (`actorType: "AI"`) is reachable only from server-side orchestration code, never as a public endpoint. The one capability missing from this surface is a scoped "list current user's pending Grow proposals" read endpoint, addressed in §3.6 below.

**Conclusion:** the propose/approve/execute/tamper-detection/idempotency machinery Stage D's specification calls for already exists, is already tested, and needs no new infrastructure — only a new `ACTION_REGISTRY` entry, a new `execute()` implementation, orchestrator wiring, and one new narrow read route.

### 2.2 The target table already exists, with the right shape

- `growCommitments` is defined in **`packages/db/src/schema/contacts.ts`** (AE Grow Priority 2), not in `packages/db/src/schema/grow.ts` as the name might suggest — confirmed by tracing `apps/api/src/lib/ai/coaching/metrics.ts`'s import of `growCommitments` from `"@aee/db"` through the barrel export in `packages/db/src/schema/index.ts`.
- Columns: `partyId` (required), `propertyId` (optional), `opportunityId` (optional), `description`, `dueAt`, `status` (`Open | Completed | Cancelled`), `completedAt` / `completedByUserId`, `cancelledAt` / `cancelReason`, `createdBy` (required).
- **There is no `appraisalId` column.** The Stage D specification allows an appraisal reference "only if supported by the existing model" — it is not, so the new action's payload will carry an appraisal reference only as a free-text/evidence reference, never as a first-class relational column, and no migration will be added to introduce one.
- The existing manual flow, **`POST /grow/contacts/:partyId/commitments`** in `apps/api/src/routes/contacts.ts`, is the direct precedent for the new action's validation logic: it is gated by `requireEntitlement("grow.activities.manage")` and validates that the party, and any referenced property or opportunity, belong to the caller's own brokerage. The new action's `execute()` will mirror this validation rather than duplicate a divergent copy of it.
- **`apps/api/src/lib/relationshipTimeline.ts`**'s `getRelationshipTimeline()` already derives `COMMITMENT_CREATED` / `COMMITMENT_COMPLETED` / `COMMITMENT_CANCELLED` timeline events generically from the `growCommitments` table for any row, regardless of how it was inserted. This means the Stage D requirement for a Relationship Timeline event on commitment creation is already satisfied by a plain `growCommitments` insert — no new timeline code is required.

**Conclusion:** no schema migration is required for this stage.

### 2.3 Entitlements already cover this without a new grant

- **`apps/api/src/lib/billing/catalogue.ts`** confirms `grow.activities.manage` is one of 13 `grow.*` entitlement keys, granted to the `grow` product and to the `agent_engine_pro_grow_bundle` product, and never granted to `agent_engine_starter`.
- This one existing entitlement satisfies every entitlement requirement in the Stage D specification: STARTER denial, GROW authorisation, and PRO/Scale inheritance through the existing bundle — with no new entitlement key introduced.
- `packages/db/src/schema/users.ts` defines exactly three roles (`Agent`, `Brokerage Administrator`, `Pit Crew`); there is no distinct "read-only" role, so "read-only user denial" in the required test matrix is an entitlement-level distinction (a user without `grow.activities.manage`), not a role-level one — noted here so the test suite is not built around a role that does not exist.

**Conclusion:** no new billing entitlement is required.

### 2.4 Locked-in design decisions for `CREATE_GROW_COMMITMENT`

| Aspect | Decision | Rationale |
|---|---|---|
| `authorityLevel` | `EXECUTE` (4) | The action performs a real write once approved; it is not merely a recommendation. |
| `riskLevel` | 2 (→ `RiskTier.MEDIUM`) | Deliberately kept below the RESTRICTED ceiling so it stays outside `protectedOperations`'s reject list, but combined with `authorityLevel = EXECUTE` this still yields `isAutoExecuteEligible() === false` (`authorityLevel > RECOMMEND` and tier is not LOW) — i.e. **human approval is always required**, by construction of the existing formula, not by a special case added for this action. |
| `allowedRoles` | `["Agent", "Brokerage Administrator", "Pit Crew"]` | Mirrors the roles already permitted to use the manual commitment-creation endpoint; the Golden Rule (AI cannot exceed the human's own role) is enforced by the existing registry mechanism, unchanged. |
| `allowedActorTypes` | `["AI"]` only | The action is only ever *proposed* by the AI orchestration path; it is never invoked by a human calling `propose` directly, and — per §2.1 — can never be approved/executed by AI, since `routes/ai-actions.ts` hard-codes `actorType: "USER"` for those verbs. |
| Required entitlement | `grow.activities.manage` (existing) | See §2.3. No new entitlement. |
| New `resourceType` | A new discriminated member (e.g. `"grow_commitment"`) | Needed so the registry's existing typed payload validation can be extended without touching unrelated action types. |
| Input schema | `partyId` (required), `description`/title (required), `dueAt` (required), `propertyId` (optional), `opportunityId` (optional), `reason`, supporting source references, originating AI interaction/recommendation identifier, idempotency/dedup key. No `appraisalId` field (see §2.2). No brokerage ID, user ID, communication instructions, SQL, credentials, scripts, status, or authority level accepted from the payload — all of those are derived server-side. | Matches the Stage D specification's payload inclusion/exclusion list exactly. |
| Migration required | No | See §2.2. |
| New entitlement required | No | See §2.3. |
| New approval system required | No | Existing `actionRequests` / `executionGateway` / `ai-actions` router is reused unmodified in its core mechanics. |

### 2.5 Stop conditions checked against this audit

Per the Stage D specification, the audit explicitly checked for each condition that would require halting:

- **Governance architecture cannot safely support the action** → not triggered; §2.1–2.4 show it can, with one new registry entry and no new infrastructure.
- **AI self-approval or auto-execution risk** → not triggered; `isAutoExecuteEligible()` is `false` for the chosen authority/risk combination, and `routes/ai-actions.ts` structurally prevents AI from calling approve/reject/execute.
- **New billing entitlement required** → not triggered; `grow.activities.manage` already covers it.

No `BLOCKED —` condition applies. Implementation may proceed.

---

## 3. Remaining Work (tracked here as implementation proceeds)

This section will be updated commit-by-commit; each item below starts **Pending** and is updated in place (never replaced wholesale) as work completes.

1. **Pending** — Register `CREATE_GROW_COMMITMENT` in `apps/api/src/lib/ai/actions/registry.ts` per §2.4.
2. **Pending** — Implement the domain validation + insert logic (new lib module), mirroring `routes/contacts.ts`'s existing brokerage-scoped validation, without modifying that route.
3. **Pending** — Wire `apps/api/src/lib/ai/orchestrator.ts`'s `askCopilot()` (both plain Ask AE/Grow mode and Business Coach mode) to call `proposeAIAction()` with `actorType: "AI"` when a grounded follow-up exists, additively extending the response contract with an optional proposal summary. Existing responses without a proposal must remain byte-for-byte unchanged.
4. **Pending** — Add the one new route: list the current user's pending Grow action proposals (tenant- and user-scoped). All other verbs reuse the existing generic router unchanged.
5. **Pending** — Build the human review/approval UI surface within the existing Grow Ask AE / Business Coach experience, covering all required UI states and the "Approve & Create Commitment" explicit-outcome button label.
6. **Pending** — Security test matrix (~28 scenarios: cross-tenant read/list/approve/reject/execute, foreign-record references, client-supplied overrides, tampering, replay, concurrency, expiry, AI self-approval attempt, entitlement checks, prompt-injection-in-evidence, redaction, audit completeness).
7. **Pending** — Functional test matrix (grounded proposal creation from both surfaces, insufficient-evidence non-proposal, approval, rejection, execution, relationship/timeline/audit events, list filtering, expiry, idempotent retry, existing-behaviour regression).
8. **Pending** — No-side-effect proof (zero business records before approval; exactly one commitment and zero communications/other records after).
9. **Pending** — Full verification suite (typecheck, migration/schema-drift, full automated test suite, API/Web production builds, synthetic readiness) via CI, inspected job-by-job.
10. **Pending** — PR into `staging` (not merged, not deployed).

## 4. Carried-forward pre-pilot items (unchanged from Stage C; not addressed by this stage)

1. Stage B and Stage C (and now Stage D) require a live app-and-database smoke test before pilot release.
2. Every brokerage's IANA timezone must be confirmed during provisioning; the `Australia/Brisbane` fallback is suitable for the QLD pilot only and must not be relied on for interstate or New Zealand brokerages.
3. The in-memory rate limiter must become distributed before horizontal scaling.
4. The product-wide 32px `.btn-small` touch target requires later accessibility review.
5. Live property enrichment remains blocked pending Project Owner/legal approval.

These items do not block this stage's work and are recorded here only for continuity.
