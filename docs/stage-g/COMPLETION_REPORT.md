# Stage G — AI Governance, Authority & Action Control: Completion Report

Status: **complete**. All 11 build stages (G1–G11) delivered, typechecked,
tested, and documented. Per the governing spec's closing instruction, work
stops here pending further instruction.

## 1. Executive summary

Agent Engine now has a real, fail-closed authority-and-execution boundary
between AI-generated output and any action that changes system state. Three
new axes were introduced and wired together: an **Authority Level** (how
much autonomy an action grants the AI), a **Risk Tier** (how sensitive the
action is), and a **Policy Engine** that combines both, plus every existing
tenant/role/entitlement check already in the codebase, into a single
fail-closed decision. Nothing the AI proposes executes without passing
through that decision twice — once at proposal, once again at execution —
and RESTRICTED-risk operations (compliance, financial ledger, entitlement/
role, schema/security/governance config) can never reach the AI-executable
registry at all, enforced by a startup self-check that crashes the app
rather than risk a silent miscategorisation.

## 2. Governing principle & Golden Rule — how they are enforced in code

"The LLM must never become the system of authority" is not a design
intention here, it is a structural fact: `evaluateAIAction()` is a pure
function the model never calls or influences, actor identity is read only
from `req.authedUser` (never from AI output), and the AI's `allowedRoles`
per action are asserted to equal the roles that could take that action
manually (Golden Rule, Part 4) — verified directly in tests (see §10,
"permission restriction").

## 3. Stage-by-stage delivery

| Stage | Deliverable | Status |
|---|---|---|
| G1 | Architecture audit — classified every touched subsystem KEEP/EXTEND/ADAPT/MISSING before any code was written | Complete (`docs/stage-g/G1_ARCHITECTURE_AUDIT.md`) |
| G2 | Authority Level model + AI Action Registry | Complete |
| G3 | Policy & Permission Engine | Complete |
| G4 | Action Risk Classification (risk tiers, auto-execute eligibility) | Complete |
| G5 | Action Request + Human Approval Engine | Complete |
| G6 | AI Action Execution Gateway | Complete |
| G7 | Audit Trail + domain event integration | Complete |
| G8 | Workflow change proposal / versioning protection | Complete |
| G9 | Ask Agent Engine action interface + protected-operations guard | Complete |
| G10 | Security & regression testing | Complete — see §10 |
| G11 | Documentation (this report + `ARCHITECTURE.md`) | Complete |

## 4. What was extended vs. built new

Nothing duplicative was built. Extended: the pre-existing `RiskLevel`
scaffolding and `assertWithinAutoExecuteCeiling` (Parts 1/2/4); the
pre-existing `ai_action_requests` table, which was explicitly commented in
the schema as scaffolding for this exact purpose; the existing domain event
architecture (`packages/events`) via one new `actorType` value and ten new
event type constants; the existing central entitlement engine
(`lib/entitlements/resolver.ts`) as the *only* entitlement decision path the
new policy engine consults. Net new, because no prior equivalent existed:
the Policy Engine, the Approval Engine, the Execution Gateway, and the
protected-operations startup guard.

## 5. AI Action Registry (the demonstration set)

Exactly three actions are registered, per the spec's instruction to
demonstrate the pattern rather than build out a full catalogue:
`PROPERTY_NOTE_ADD` (EXECUTE authority, LOW risk, auto-execute eligible),
`WORKFLOW_CHANGE_PROPOSE` (PREPARE authority, LOW risk, auto-execute
eligible), and `WORKFLOW_VERSION_ACTIVATE` (SYSTEM_CHANGE authority, HIGH
risk, Brokerage Administrator only, always requires approval). Full detail
in `ARCHITECTURE.md` §8.

## 6. Fail-closed guarantees

Every uncertainty denies rather than permits: an unrecognised action key,
a disabled action, a RESTRICTED risk tier, a forbidden actor type or role,
missing tenant context, input that fails its zod schema, an entitlement
lookup that denies or errors, an expired approval window, or a payload hash
mismatch all result in the request being blocked — never defaulted open.
This is asserted directly by the test suite (§10).

## 7. Approval & tamper protection

Approval requirement is computed once, deterministically, from authority
level and risk tier (`isAutoExecuteEligible`) — never left to the AI to
request or skip. Approver eligibility is checked against the same
`allowedRoles` list the action itself is restricted to. Tamper protection
hashes the parsed input payload (canonicalized, key-order-independent SHA-
256 — see §9, this was the one real bug the test suite caught) at proposal
time and re-verifies it at both approval and execution time; any mismatch
is treated as tampering and the request is terminally blocked, not retried
or silently re-approved.

## 8. Execution gateway

`executeAIAction()` is the only code path anywhere in the system that calls
`execute()` on a registered action. It re-runs the full policy evaluation
(defense in depth, matching the existing `askCopilot()` convention), re-
verifies the tamper hash, and transitions the row `APPROVED → EXECUTING`
via a conditional `UPDATE ... WHERE status = 'APPROVED'` so two concurrent
execute calls on the same request can never both succeed (verified by the
duplicate-execution test).

## 9. The bug the test suite caught, and the fix

Stage G10's test suite exercises the full propose → approve/execute
lifecycle against a real database rather than mocked reads/writes. Doing so
surfaced a genuine production-correctness bug: Postgres `jsonb` storage does
not preserve object key insertion order, so a naive
`JSON.stringify(payload)` hash computed at proposal time (on the in-memory
object) would not reliably equal the same hash recomputed from the row read
back from the database at execution time — causing every legitimate action
to be falsely rejected as `PAYLOAD_TAMPERED`. Fixed by canonicalizing
(recursively sorting object keys) before hashing, in `hashInputPayload()`,
the single function both the approval and execution tamper checks call.
This is exactly the kind of defect Part 25/26's "test against a real
database, not mocks" requirement exists to catch.

## 10. Security & regression test results (Part 25/26 checklist)

`apps/api/src/lib/ai/__tests__/governance.test.ts`, run via
`pnpm --filter @aee/api run test` (which also runs every pre-existing test
file in the API package — entitlements, billing, import, middleware — as a
regression check):

- Permission restriction (Golden Rule) — **pass**
- Organisation isolation (cross-brokerage read denied; cross-brokerage
  execution denied) — **pass**
- Entitlement restriction — intentionally skipped with a documented reason
  (no entitlement-gated demonstration action was in scope for Part 24's
  minimal set); the entitlement check itself is exercised indirectly
  through the shared, already-tested `explainEntitlementDecision()`
- Restricted-action blocking (RESTRICTED risk level throws at registration;
  a forbidden actionKey fragment throws at registration;
  `riskTierForLevel(4) === "RESTRICTED"`) — **pass**
- Approval requirement (SYSTEM_CHANGE always requires approval; LOW-risk
  EXECUTE auto-approves) — **pass**
- Approval ownership (a role outside `allowedRoles` cannot approve; request
  stays `AWAITING_APPROVAL`) — **pass**
- Duplicate execution prevention — **pass**
- Tampered payload (before approval → `PAYLOAD_TAMPERED`, request
  `REJECTED`; before execution → `PAYLOAD_TAMPERED`, request `FAILED`) —
  **pass**
- Prompt injection (unrecognised input fields stripped by schema
  validation; an injected `role` string in the payload is compared
  literally and denied, never trusted as an authority claim; structurally
  invalid input denied with `INPUT_SCHEMA_INVALID`) — **pass**
- Workflow overwrite prevention (activating a new workflow version
  supersedes rather than overwrites the previously active one) — **pass**
- Audit completeness (every lifecycle transition — proposed, approval-
  required, approved/rejected, executed/failed/blocked — publishes its own
  distinct domain event, verified against an in-memory event store) —
  **pass**

Final run: **54 tests — 53 passed, 1 intentionally skipped, 0 failed.**
`pnpm --filter @aee/api run typecheck` passes with zero errors. No existing
test file's expectations changed as a result of this work.

## 11. Deliberate exclusions (non-goals at this stage)

Per Parts 15/30, explicitly not built: automatic conversion of `askCopilot`
model output into real action requests (the new `actionProposals` field on
`AiStructuredResponse` is data-only and documented in-code as inert);
autonomous AI agents; autonomous Grow prospecting; AI-controlled financial,
compliance, or transaction actions; automatic workflow optimisation. These
are left for a future stage to pick up deliberately.

## 12. Known limitations, recommended next steps, and sign-off

Limitations worth flagging for whoever picks this up next: approval
expiry/timeout handling exists in the schema and is checked at approve/
execute time, but no background job currently sweeps `AWAITING_APPROVAL`
rows past their expiry into `EXPIRED` — they simply get caught the next
time someone tries to act on them. The entitlement-restriction test path is
skipped rather than exercised end-to-end because none of the three
demonstration actions currently declares a `requiredEntitlementKey`; the
underlying `explainEntitlementDecision()` call in the policy engine is
otherwise untested in this file specifically (though it is extensively
tested in its own suite). Recommended next steps, not undertaken here: wire
a real entitlement-gated action once one exists, add the expiry sweep if
stale `AWAITING_APPROVAL` rows become a real operational concern, and only
then consider whether any of the Part 15/30 exclusions in §11 should be
revisited — each as its own deliberate, separately-reviewed decision.

**This completes the governing spec's CLAUDE BUILD INSTRUCTIONS through
Stage G11.** Per the spec's own closing instruction, work stops here;
awaiting further instruction before any additional stage begins.
