# Integration and Data Exchange Foundation

Agent Engine 2.0, Step 5. This document is the entry point for the provider-neutral
integration foundation added in this step: what it is, why it's shaped the way it is, what
it deliberately does not do yet, and where to read next.

**No real integration has been completed by this step.** Every provider connection this
foundation can create is a mock (`mock_portal_v1`, `environmentClassification: "MOCK"`).
No live credential, sandbox account, or third-party network call exists anywhere in this
build. Where this document or its companions describe something as "working" or "proven",
that means proven against the mock adapter through the real, unmodified execution path a
future real adapter would also use — never against a live service.

## 1. Why this exists

AgentEngineEasy (AE) is, as of Step 5, a closed system: every domain engine (Launch,
Communications, Financial, Exceptions/Risk, Pit Crew, and the rest) reads and writes only
its own canonical tables. Nothing outside AE can currently push data in or pull data out
in a controlled way. The next phase of the program needs that boundary — real estate
portals, accounting and banking feeds, e-signature and AML providers, and so on — but
opening it carelessly would let an external event redefine canonical state, bypass
approval controls, or leak data across tenants.

This step builds the **common plumbing** every future provider connection will sit behind:
a typed adapter contract, a controlled connection lifecycle, a transactional outbox for
outbound calls, a webhook gateway with signature verification and idempotency for inbound
calls, external identity mapping, dead-letter recovery, and a credential-reference
boundary that structurally cannot hold a real secret. It does **not** build any specific
provider integration. Section 6 of this document (What is deliberately deferred) lists
what is intentionally left for later, controlled stages.

## 2. Scope actually built

The Step 5 brief (reproduced in full in the PR this ships with) describes a very large
foundation — 19 capability areas, a 22-step build order, four full domain proofs, and an
admin UI. Building and *verifying* the entire literal brief in one pass is not something
that can honestly be claimed complete; a document asserting otherwise would be exactly the
"document-only implementation" the brief itself rules out as insufficient (Section 17).

What was actually built, end to end, with real code and real tests run against a real
Postgres database, is:

- The schema (10 new tables — Section 3 below, and `INTEGRATION_ADAPTER_CONTRACTS.md`).
- Typed adapter contracts and a fail-closed provider registry/resolver.
- The full connection lifecycle (11 states) with an approval chain, transition-table
  enforcement, and an append-only audit ledger.
- A transactional outbox with retry/backoff/dead-letter, and an inbound webhook gateway
  with signature verification, idempotency, and dead-letter.
- External identity mapping with conflict detection.
- A credential-reference boundary (opaque secret identifiers only — see
  `INTEGRATION_SECURITY_BOUNDARY.md`).
- One deterministic mock adapter (`mock_portal_v1`) covering all ten required mock
  scenarios (Section 6 of the build brief) through the real adapter/registry/outbox/
  webhook path — no shortcuts.
- One complete domain integration proof: **Property Launch** (Proof A in the brief). It
  proves a mock portal event can flow all the way from an approved connection through the
  outbox, the adapter, a signed webhook, and Launch's own service boundary
  (`recordPortalSubmission` / `confirmPortalLive`) — and that it cannot flip a Launch
  Plan's `LISTING_LIVE` status, which stays gated behind Market Ready and an explicit
  human action.
- 21 automated tests, all passing against a real database, plus a full run of every
  existing relevant regression suite (538 tests total across the whole `apps/api` test
  script) with zero failures.

What was **not** built in this step: Proofs B (Communications), C (Financial), and D
(Workflow/Risk); the sync-cursor and reconciliation frameworks (schema concepts documented
but no service code); the import/export job foundation; the administration UI
(Section 10 of the brief); and most of the specific error-taxonomy/observability
instrumentation beyond what the outbox/webhook/dead-letter path already needed to be real.
`INTEGRATION_FOUNDATION_COMPLETION_REPORT.md` gives the exact PASS/FAIL/NOT EXECUTED
status of every one of the brief's 17 required acceptance scenarios — this is the honest
account of what's proven versus what remains.

## 3. What's new in the database

Ten tables, all under `packages/db/src/schema/integrations.ts`:

| Table | Purpose |
| --- | --- |
| `integration_providers` | The code-defined provider catalogue, upserted at boot. |
| `integration_connections` | One row per brokerage-provider connection; the lifecycle state machine lives here. |
| `integration_connection_transitions` | Append-only ledger of every lifecycle transition. |
| `integration_outbox` | Transactional outbox for outbound commands. |
| `integration_outbox_attempts` | Append-only per-attempt record. |
| `integration_inbox` | Inbound webhook receipt ledger — first receipt vs. duplicate, dedup keyed on `(connectionId, provider, providerEventId)`. |
| `integration_external_mappings` | External-ID ↔ AE-entity mapping, unique both directions. |
| `integration_dead_letters` | Unified dead-letter store for both outbox commands and inbox webhooks, with controlled replay. |
| `integration_credentials` | Credential *references* only — no secret-value column exists. |
| `integration_settings` | Per-brokerage `enabled` flag and connection cap. |

Several tables named in the brief's illustrative list were deliberately **not** added as
separate tables, in favour of reusing what already exists — the schema file's own header
comment documents each decision (e.g. no `integration_events` table, because
`packages/events`' existing `domain_events` table and bus already are the canonical event
model; no `integration_audit_events`, because `audit_logs` already serves that role; no
`integration_approvals` table, because approval state is fields + the transitions ledger
on `integration_connections` itself). This follows the same "reuse suitable existing
entities rather than duplicating them" instruction the brief itself gives.

Applied and verified against a real Postgres 16 database via `drizzle-kit push` — see
`INTEGRATION_OPERATIONS_AND_RECOVERY.md` Section 1 for the full migration story, including
a pre-existing, unrelated migration-history inconsistency discovered (and worked around,
not silently absorbed) during this step.

## 4. Non-negotiable rules this build actually enforces

These map directly to Section 4 of the build brief, with the concrete mechanism for each:

- **AE remains sole source of truth.** No new integration table is a second copy of a
  property, contact, transaction, or financial record. The one domain proof that exists
  (Launch) writes only through Launch's own existing service functions
  (`recordPortalSubmission`, `recordPortalFailure`, `confirmPortalLive`) — never a new,
  parallel write path. `confirmPortalLive` only updates the *destination's* status; it is
  a structurally different function from `confirmLaunchLive`, which alone can flip a
  Launch Plan's `LISTING_LIVE` status, and no integration code calls the latter.
- **Provider payloads are not canonical models.** Raw inbound payloads are stored on
  `integration_inbox` for audit/replay only. `launchProof.ts`'s webhook handler
  transforms the mock portal's own status vocabulary (`SUBMITTED`/`LIVE`/`REJECTED`) into
  calls against Launch's existing typed functions before anything touches Launch's schema.
- **Adapters are replaceable.** Every capability domain code can call is a verb —
  `portal.publishListing`, `portal.updateListingStatus` — never a provider SDK name. See
  `INTEGRATION_ADAPTER_CONTRACTS.md`.
- **No connection without approval.** Every connection starts `DRAFT` (unusable) and must
  pass through `PENDING_APPROVAL` → `APPROVED` → `CONFIGURING` → `VALIDATING` → `ACTIVE`
  before `resolveActiveConnection` (the single fail-closed chokepoint every dispatch and
  webhook lookup goes through) will use it. Proven directly by
  `connectionLifecycle.test.ts`.
- **No live credentials.** `integration_credentials` has no column capable of holding a
  secret value — see `INTEGRATION_SECURITY_BOUNDARY.md`.
- **Tenant isolation is airtight.** `resolveActiveConnection` checks that a connection
  belongs to the calling brokerage *before* any other check, and returns an identical
  `NOT_FOUND` whether the row is missing or belongs to another tenant. Proven directly by
  a dedicated cross-tenant test (see `INTEGRATION_SECURITY_BOUNDARY.md` Section 2).
- **Existing domain controls aren't bypassed.** The Launch proof is precisely the
  demonstration of this: a mock external event reaches Launch only through Launch's own
  guarded service functions, and the property-level `LISTING_LIVE` status — gated by
  Market Ready and a human `confirmLaunchLive` call — never moves as a side effect of a
  portal webhook.

## 5. Where to read next

- **`INTEGRATION_ADAPTER_CONTRACTS.md`** — the typed contracts, capability catalogue,
  provider registry, and how to add a new provider.
- **`INTEGRATION_EVENT_AND_DELIVERY_MODEL.md`** — the event envelope, outbox, inbox,
  webhook gateway, and idempotency in detail.
- **`INTEGRATION_SECURITY_BOUNDARY.md`** — tenant isolation, fail-closed authorization,
  webhook authenticity, credential handling, redaction.
- **`INTEGRATION_OPERATIONS_AND_RECOVERY.md`** — dead-letter replay, connection health,
  the migration-history finding, how to activate a real sandbox connection later.
- **`INTEGRATION_FOUNDATION_COMPLETION_REPORT.md`** — exact test evidence and the
  scenario-by-scenario PASS/FAIL/NOT EXECUTED account.

## 6. What is deliberately deferred

Per Section 18 of the build brief, none of the following exist in this build, and none
should be inferred from anything in this document set: a live provider connection; real
credentials of any kind; a real sandbox account; a vendor selection or commercial
decision; production payment movement; trust-fund authority; automatic financial
reconciliation that bypasses the Financial Transaction Engine; unrestricted webhooks or
outbound HTTP; a replacement for any AE canonical model; a completed security-hardening
program; or final operational-readiness sign-off. These belong to later, individually
approved stages.
