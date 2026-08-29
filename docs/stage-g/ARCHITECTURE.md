# AI Governance, Authority & Action Control Architecture

Stage G developer reference. Companion to `docs/stage-g/COMPLETION_REPORT.md`.

## 1. Governing principle

AI may analyse broadly, recommend intelligently, and prepare actions. **Agent
Engine — not the LLM — decides whether an action is permitted and whether it
can be executed.** No model output is ever trusted as an authority claim.
Concretely: actor identity always comes from `req.authedUser` (server-side
session), never from AI output; every write path re-checks policy at
execution time even if it was already checked at proposal time; and the
system fails closed on any uncertainty (unknown action, missing tenant
context, invalid input, entitlement lookup failure — all deny).

## 2. Two independent axes

Every AI-executable action carries two separate, composed values — they are
not the same axis and must never be collapsed into one:

- **Authority Level** (`apps/api/src/lib/ai/authority.ts`) — how much
  autonomy the AI has over this *kind* of action: `OBSERVE(1) < RECOMMEND(2)
  < PREPARE(3) < EXECUTE(4) < SYSTEM_CHANGE(5)`.
- **Risk Level / Risk Tier** — how sensitive the action is if it goes wrong.
  `RiskLevel` (0-4, pre-existing in `types.ts`) maps deterministically via
  `riskTierForLevel()` to `LOW | MEDIUM | HIGH | RESTRICTED`.

`isAutoExecuteEligible(authorityLevel, riskTier)` combines both: an action
may skip human approval only if its risk tier is LOW (regardless of
authority) or its authority is at or below RECOMMEND — and **never** if the
risk tier is RESTRICTED or the authority is SYSTEM_CHANGE or higher. Nothing
else in the system is allowed to bypass this function to decide
auto-execution eligibility.

## 3. Request lifecycle

```
PROPOSED (transient, never persisted alone)
   |
   v
policy evaluation (evaluateAIAction)
   |
   +-- auto-execute eligible --> APPROVED
   |
   +-- requires approval --> AWAITING_APPROVAL --> APPROVED
   |                                            \-> REJECTED
   |                                            \-> EXPIRED
   v
APPROVED --> EXECUTING --> COMPLETED
                       \-> FAILED
```

Every transition publishes a domain event (see §7) and every transition that
touches the row is a conditional `UPDATE ... WHERE status = <expected>`, so a
race between two callers (e.g. duplicate execute calls) can only let one of
them win.

## 4. Module map

| Module | Responsibility |
|---|---|
| `lib/ai/authority.ts` | `AuthorityLevel` enum, `RiskTier`, `riskTierForLevel()`, `isAutoExecuteEligible()` |
| `lib/ai/actions/registry.ts` | The closed set of AI-executable actions (`ACTION_REGISTRY`), each with its own zod input schema and `execute()` |
| `lib/ai/protectedOperations.ts` | Startup self-check: crashes the app if a registered action is miscategorised as AI-executable despite touching a protected operation category |
| `lib/ai/policyEngine.ts` | `evaluateAIAction()` — the single, pure, fail-closed authorization decision function |
| `lib/ai/actionRequests.ts` | `proposeAIAction()`, `approveAIActionRequest()`, `rejectAIActionRequest()`, `hashInputPayload()` (tamper-protection hashing) |
| `lib/ai/executionGateway.ts` | `executeAIAction()` — the *only* place a registry action's `execute()` is ever called |
| `lib/ai/actionEvents.ts` | `publishAiActionEvent()` — shared, never-throws domain-event publisher for the AI action lifecycle |
| `lib/ai/protectedOperations.ts` + `routes/ai-actions.ts` | HTTP surface — the only way a human reaches this subsystem |
| `lib/ai/__tests__/governance.test.ts` | Full lifecycle + adversarial test suite (Stage G10) |

## 5. Policy evaluation (`evaluateAIAction`)

Pure function, no side effects, called at propose time *and again* at
execute time (defense in depth — the same convention `askCopilot()` already
used for its own permission re-checks). Order of checks, each with its own
typed denial reason, first failure wins:

1. `ACTION_NOT_FOUND` — unknown `actionKey`.
2. `ACTION_DISABLED` — action exists but is administratively disabled.
3. `RESTRICTED_ACTION_BLOCKED` — risk tier is RESTRICTED. No RESTRICTED
   action is ever runnable through this path, full stop; this is enforced a
   second, independent time by `protectedOperations.ts` at process boot.
4. `ACTOR_TYPE_FORBIDDEN` — the caller's actor type (`USER`/`AI`) isn't in
   the action's `allowedActorTypes`.
5. `ROLE_FORBIDDEN` — the actor's role isn't in `allowedRoles` (**Golden
   Rule**: `allowedRoles` must always equal the roles that could perform
   this action manually — the AI is never granted a role a human in that
   seat couldn't already use).
6. `TENANT_CONTEXT_REQUIRED` — no `brokerageId` on the actor.
7. `INPUT_SCHEMA_INVALID` — the action's own zod schema rejects the raw
   input (this is also what strips any unrecognised/injected fields from
   the parsed input that downstream code actually uses).
8. `ENTITLEMENT_DENIED` — if the action declares a `requiredEntitlementKey`,
   `explainEntitlementDecision()` (the existing central entitlement engine,
   `lib/entitlements/resolver.ts`) is consulted — **not** a second,
   AI-specific entitlement path.

Only if every check passes does it return `allowed: true` plus
`requiresApproval = !isAutoExecuteEligible(...)`.

## 6. Tamper protection

`hashInputPayload(payload)` computes a SHA-256 hash over a **canonicalized**
serialization of the parsed input — object keys are recursively sorted
before `JSON.stringify()`. This matters because Postgres `jsonb` columns do
not preserve object key insertion order across a write/read round-trip, so a
naive `JSON.stringify()` hash computed at proposal time (in-memory object)
would not reliably match the same hash recomputed later from the row read
back from the database, even with zero tampering. Canonicalizing first makes
the hash a pure function of the logical value.

The hash is computed once at proposal time (`inputPayloadHash` column) and
re-verified by re-hashing the row's *current* `inputPayload` at both
approval time and execution time. Any mismatch — whether from a genuine
tamper attempt or a bug — is treated identically: the request is blocked
(`PAYLOAD_TAMPERED`) and moved to a terminal failure state, never silently
allowed through.

## 7. Audit trail / domain events

`publishAiActionEvent()` wraps the existing `publishDomainEvent()` /
`packages/events` publisher (no new event system). It never throws back into
the calling request — a broken event pipeline must never block or corrupt
the governed action itself, matching the existing publisher convention. Ten
event types were added to the existing `AgentEngineEasyEventType` registry:
`AI_ACTION_PROPOSED`, `AI_ACTION_APPROVAL_REQUIRED`, `AI_ACTION_APPROVED`,
`AI_ACTION_REJECTED`, `AI_ACTION_EXECUTED`, `AI_ACTION_FAILED`,
`AI_ACTION_BLOCKED`, and the workflow-versioning equivalents. Every event
carries `actorType` (`AI` or `USER`), `actorId`, `brokerageId`, a
`correlationId`, a `causationId`, and an `idempotencyKey` derived from
`ai_action_request:<id>:<eventType>` so replays/retries can never double
count.

## 8. The three registered demonstration actions

Deliberately a small, closed set (spec Part 24) — not a general-purpose
action framework:

- **`PROPERTY_NOTE_ADD`** — authority `EXECUTE`, risk `LOW`, auto-execute
  eligible. Adds a note to a property; lowest-consequence, fully reversible.
- **`WORKFLOW_CHANGE_PROPOSE`** — authority `PREPARE`, risk `LOW`, auto-
  execute eligible. Proposes (never activates) a workflow change.
- **`WORKFLOW_VERSION_ACTIVATE`** — authority `SYSTEM_CHANGE`, risk `HIGH`,
  `allowedRoles: ["Brokerage Administrator"]` only, **always** requires
  approval (authority ≥ SYSTEM_CHANGE forces this regardless of risk tier).
  Activating a version supersedes the prior active version rather than
  overwriting it — history is preserved.

No AML/compliance determination, financial ledger/commission mutation,
entitlement/role/permission change, or schema/security/AI-governance-config
change is registered, and `protectedOperations.ts` crashes the app at boot
if one ever is.

## 9. How to add a new AI-executable action (for future developers)

1. Add an entry to `ACTION_REGISTRY` in `lib/ai/actions/registry.ts`: a zod
   input schema, `authorityLevel`, `riskLevel`, `allowedActorTypes`,
   `allowedRoles` (must mirror who could do this manually — Golden Rule),
   optional `requiredEntitlementKey`, and an `execute(ctx, input)` that
   calls an **existing** domain service function — never new business logic
   inlined here.
2. If the action is RESTRICTED risk or touches a protected-operation
   category, **do not register it** — `protectedOperations.ts` will refuse
   to boot the app, by design.
3. Add/extend tests in `governance.test.ts` covering: role restriction, org
   isolation, approval requirement matching the authority/risk combination,
   and — if the action can be executed more than once — duplicate-execution
   safety.
4. Nothing else needs to change: the policy engine, approval engine,
   execution gateway, and audit trail are all action-agnostic and pick the
   new entry up automatically through the registry.

## 10. Explicit non-goals at this stage

Per spec Parts 15/30, this build does **not**: let `askCopilot()` or any
other model-output path automatically convert its own suggestions into real
`AIActionRequest`s (the `actionProposals` field on `AiStructuredResponse` is
data-only, documented in-code as inert); implement autonomous agents,
autonomous Grow prospecting, AI-controlled financial/compliance/transaction
actions, or automatic workflow optimisation. These remain explicitly out of
scope until a future stage deliberately picks them up.
