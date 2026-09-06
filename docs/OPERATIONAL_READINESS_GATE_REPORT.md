# Agent Engine 2.0 — Operational Readiness and Controlled Pilot Gate Report

`docs/OPERATIONAL_READINESS_GATE_REPORT.md`

**Gate purpose.** This report is the output of a 12-phase operational readiness gate run
against the AgentEngineEasy / "Agent Engine 2.0" codebase to determine whether the current
`staging` build can safely operate a small controlled pilot (5–10 invited agents, real
transaction workflows, synthetic/test data only, no public signup, no NZ-wide or any other
launch, no unrestricted high-impact AI action). It does not assess, and must not be read as
assessing, production readiness or national launch readiness for any jurisdiction.

---

## FINAL DECISION

# BLOCKED — CRITICAL OPERATIONAL FAILURE

This build must not admit pilot participants in its current state. The blocking finding is a
**demonstrated, structural authentication and tenant-isolation failure** (§2 below) — not a
theoretical risk, a missing nice-to-have, or something a configuration change fixes. It is
compounded by, but does not depend on, a second and independent category of blocker —
essential legal/privacy documents that do not exist at all (§7).

This is not a comment on the engineering team's competence or the codebase's overall quality.
Large parts of this codebase — the core Run-tier transaction engine specifically — are unusually
well built, self-aware about their own limits, and genuinely tested end-to-end (§3). The finding
below is narrow, specific, and fully evidenced; it is also sufficient, on its own, to block this
gate.

**Status of this section as of the Critical Blocker Remediation pass:** this FINAL DECISION line,
and the rest of this report, describe the state of the codebase **before** the authentication
remediation, jurisdiction correction, legal drafting, and other work carried out under "AE
Operational Readiness — Critical Blocker Remediation." That remediation pass re-runs this gate
and issues its own renewed final decision in a separate completion report (Phase 12); it does not
edit this line, so that the original gate finding remains an intact historical record. See
`docs/gate-evidence/PHASE12_COMPLETION_REPORT_AND_RENEWED_GATE_DECISION.md` for the current
decision.

---

## 0. Jurisdiction — RESOLVED: Queensland, Australia (Critical Blocker Remediation, Phase 6)

**This section originally read as an unresolved blocker (B3). It has since been resolved by an
explicit decision from the AE Project Owner and is retained below, corrected, as the historical
record plus the current, confirmed fact.**

The gate instruction that originally produced this report described Agent Engine 2.0 as a New
Zealand real-estate platform. Direct code inspection found the opposite, repeatedly and
unambiguously — and that finding is exactly what the AE Project Owner has now confirmed is
correct:

**The AE Project Owner has confirmed, in writing, that this pilot's jurisdiction is Queensland,
Australia — not New Zealand, and not a multi-jurisdiction launch.** The codebase's existing
Australian defaults were not a mismatch to fix; they were, and are, the correct defaults for the
confirmed jurisdiction:

- `README.md`: *"a simplified, property-led real estate transaction platform for **Australian**
  real estate agents."*
- GST is hardcoded at the **Australian** 10% rate in the Pit Crew success-fee calculation
  (`packages/integrations` / `apps/api/src/lib/financial/pcFeeCalculations.ts`) — this is the
  **correct rate for Queensland, Australia** as now confirmed. There is still **no per-brokerage
  override field anywhere in the schema** for this specific calculation; that is tracked below as
  a non-blocking future item, not a jurisdiction error.
- Currency is hardcoded `"AUD"` at every money-handling call site — correct for the confirmed
  jurisdiction.
- The direct-debit mandate flow is modelled on Australia's Direct-Debit-Request shape — correct
  for the confirmed jurisdiction.
- AML/CTF terminology throughout is AUSTRAC-shaped — correct for the confirmed jurisdiction; no
  NZ AML/CFT Act-specific concepts appear anywhere in the codebase, and none are needed.

**Tracked future item (non-blocking):** the Pit Crew success-fee GST rate
(`pcFeeCalculations.ts`) remains hardcoded with no per-brokerage/per-jurisdiction override field
(no `gstRateBps` column on `pcFeeAuthorities`; `financialSettings.defaultGstRateBps` exists but is
not consulted by this specific calculation — see
`docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md` §3–4). This is not a blocker for a
Queensland/Australia-only pilot at the current 10% rate, but should be made configurable before
this platform is ever extended to a second jurisdiction, or if the Australian GST rate itself
changes. See `docs/gate-evidence/PHASE6_JURISDICTION_CORRECTION.md` for the full correction
record and this item's tracking entry.

Every dollar figure and every AML/compliance statement elsewhere in this report describes the
codebase as built (Australian, specifically Queensland for this pilot) — this is now a
confirmed fact, not an open question.

---

## 1. Gate scope, branch, and provenance

- **Base branch:** `staging`.
- **Working branch:** `feat/operational-readiness-pilot-gate`, created from `staging`'s actual
  HEAD at the time of branch creation, commit `1c6958a735f4ab1ce92d7d8177e9e4d447b1cbae` (the
  instruction's stated "expected" starting SHA, `399c8792...`, had already moved one commit —
  a docs-only, non-invalidating change recording PR #25's merge and post-merge CI result — so
  the branch was correctly cut from the true current head rather than the stale expected value).
- **Baseline verified before this gate began:** PR #25 (Step 2 — Security and Observability
  Hardening) merged into `staging` via a standard merge commit; post-merge staging CI run **#134**
  (run ID `33999674255`) green — 663 tests / 662 pass / 1 explicitly-documented skip / 0 fail,
  88/88 tenant-isolation tests passing, schema-drift check passing, clean-database migration
  passing, both API and web production builds passing.
- **Repository hygiene completed this pass (Phase 1):** `pnpm-lock.yaml.part2`, an inert scratch
  file left over from an abandoned earlier commit sequence, was verified as unreferenced anywhere
  in the repository and unnecessary for a frozen-lockfile install, then removed in its own
  commit (`25f5faae6d8120949128bd8e70af3faa74f839d1`).
- **This gate's own PR:** [PR #27](https://github.com/AdamJRichards27/AgentEngineEasy/pull/27),
  opened from `feat/operational-readiness-pilot-gate` into `staging` as a **draft**, **not
  merged** — see §13 for the final commit SHA on this branch as of this report's own closing
  update.
- **Method:** the repository has no working git credentials in this session (all commits go
  through the GitHub API with git-blob-SHA-1 verification on every push); a local, non-git file
  mirror of the repository was used for all reading, typechecking, test execution, and the
  bounded remediation described in §11. Five specialised research passes (Phases 3–7) plus this
  author's own direct reading of the authentication code (§2) produced the evidence in this
  report. Nothing here was asserted without a file:line citation or a locally-executed,
  witnessed command.

---

## 2. THE BLOCKING FINDING — no real authentication; demonstrated tenant-isolation failure

**This finding was independently verified by direct reading of the actual source files** —
`apps/api/src/routes/auth.ts`, `apps/api/src/middlewares/auth.ts`, and
`apps/api/src/lib/env.ts` — not inferred or reported secondhand.

Agent Engine 2.0 has no real identity provider anywhere in this codebase. The only way to sign
in is `POST /auth/dev-login` (`apps/api/src/routes/auth.ts:65-135`), which:

- Accepts a client-supplied `email`, `firstName`, `lastName`, and `brokerageName` — nothing else.
- **Finds-or-creates** a user by that email with **zero password, zero token, zero proof of
  identity of any kind.** If the email already belongs to an existing user, the caller is signed
  in *as that user* — full stop.
- **Finds-or-creates** a brokerage by name, and the **first** user ever created in a brokerage
  automatically becomes its **Brokerage Administrator** — the most privileged role in the system
  (refunds, transaction close, PC-fee-authority activation/revocation, billing checkout/cancel
  are all Brokerage-Administrator-only).
- Is gated only by `isDevAuthEnabled()` (`apps/api/src/lib/env.ts:19-31`) — an environment flag
  (`ALLOW_DEV_AUTH=true`, forced off when `NODE_ENV=production`) — **and this flag is the only
  login mechanism that exists.** There is no other route, anywhere in this codebase, that signs
  a user in. This means one of exactly two states is true for any environment this build ever
  runs in: either dev-auth is enabled, and **anyone who can reach the API can impersonate any
  existing user by typing their email**, or dev-auth is disabled, and **nobody — including
  legitimate pilot participants — can ever sign in.** A pilot requires the former.
- Is compounded by `GET /auth/known-users` (`apps/api/src/routes/auth.ts:30-47`), which — under
  the exact same flag a pilot must have enabled — returns **every user's name, email, and
  brokerage, completely unauthenticated.** An attacker does not even need to guess an email; the
  application will hand over the full pilot roster on request.

Separately, `apps/api/src/middlewares/auth.ts` confirms there is no second layer that would
catch this: `loadSession`/`requireAuth` validate only a self-issued HMAC session cookie
(`lib/session.ts`) against the database — genuine, well-built, and correctly fail-closed for what
it does (session-forgery detection, real logout-everywhere semantics via a `sessionEpoch`
counter) — but it verifies that a cookie is *internally consistent*, never that the person who
obtained it is who they claim to be. `CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` exist as unused
placeholder environment variables; no Clerk (or any other real identity provider) verification
code exists anywhere in this repository.

**Why this is a demonstrated tenant-isolation failure, not a theoretical one:** every other
tenant-isolation control in this codebase — and Phase 3's audit found many of them to be
genuinely well-built (in-query brokerage filters, identical 404s for cross-tenant reads and
writes, 88/88 passing tenant-isolation tests at the last verified staging CI run) — assumes the
session cookie in front of it belongs to who it claims to belong to. That assumption is false by
construction in this build. A pilot participant (or anyone who can reach the pilot's API) can
become any other participant, including a Brokerage Administrator of another pilot brokerage,
with a single unauthenticated HTTP request. This is precisely the gate instruction's own
mandatory stop-pilot condition — "confirmed tenant-data exposure" — except demonstrated *before*
the pilot would even start, not discovered during it.

**Why this cannot be closed by this gate's own bounded remediation:** the gate's remediation
rules explicitly prohibit "speculative features" and "major interface redesign." Building a real
identity-verification mechanism (wiring the placeholder Clerk keys into actual verification code,
or an equivalent) is exactly that — a genuine feature build touching the authentication surface
every route in the application depends on, not a bounded, evidenced correction to an existing
control. It is also not something this engineering process should self-approve as "good enough"
via a compensating control; a workaround like "treat the brokerage name as a shared secret and
manually audit the user list" (documented as an operational mitigation in
`docs/CONTROLLED_PILOT_PLAN.md`) reduces but does not close the exposure, and this report does
not represent it as sufficient to lift the block.

**Status as of the Critical Blocker Remediation pass:** this finding is addressed by a real,
invitation-only authentication system built under that pass — see
`docs/gate-evidence/AUTHENTICATION_THREAT_MODEL.md` and
`docs/gate-evidence/PHASE2_AUTHENTICATION_DESIGN.md` for the design, and the renewed Phase 12
completion report for the verification evidence. This section is left otherwise unchanged as the
original finding's historical record.

---

## 3. What this codebase does well (for balance — this finding does not mean the whole platform is unreliable)

The Run-tier transaction engine specifically is unusually solid: real transactional locking on
concurrent-offer races (`SELECT … FOR UPDATE`), append-only audit history for date changes,
idempotency chokepoints backed by database-level uniqueness constraints on every financial
mutation, tenant-isolation checks joined into the same query rather than bolted on afterward, a
self-correcting exception-engine catalogue that watches even for contradictions in its own
forced-override path, and — verified by actually executing it against a fresh local database
this pass — a **662/662-passing test suite (1 documented skip, 0 failures)** including one
genuine full-HTTP-stack end-to-end test that drives a property from first account creation
through offer, conditions, settlement, and closure. The gaps found across this gate (below) are
gaps in *scope* — features not yet built, or deliberately mocked pending a real vendor — rather
than evidence of an unreliable foundation for the parts that are built. That distinction matters
for whatever comes after this block is resolved.

---

## 4. Capability matrix and end-to-end scenario trace (Phase 3, full)

The complete capability matrix and Scenario A (successful transaction, start to close),
Scenario B (operational exceptions), and Scenario C (user/access lifecycle) traces are
reproduced in full at `docs/gate-evidence/PHASE3_CAPABILITY_MATRIX_AND_SCENARIOS.md` — every row
cites a specific file:line and, where applicable, a specific passing test. The highlights most
relevant to the decision above:

- **Include as pilot-ready today** (synthetic data, with caveats noted per capability): account
  creation & session security, transaction creation, offer/negotiation, conditions tracking,
  settlement, transaction closure, Pit Crew delegated work-item lifecycle, success-fee
  calculation, document management, data import (CSV/XLSX), audit logging, Timeline/Command
  Centre reporting, Run/Grow entitlement gating, Grow CRM record-keeping.
- **Manual-workaround-only** (no in-app mechanism exists; requires a direct database write by AE
  engineering for the pilot's duration): account/role onboarding generally (see §2), Pit Crew
  role grant/revoke, any role change, agent deactivation, and Brokerage-Administrator succession
  if the only admin is ever deactivated — there is **no safeguard anywhere** preventing a
  brokerage from being left with zero active administrators, and every Brokerage-Administrator
  -only action would then become permanently unreachable for that brokerage without another
  direct database intervention.
- **Exclude from this pilot:** transaction cancellation/fall-through (no system state exists for
  a deal that genuinely dies rather than stalls — the most common real-world exception in
  property transactions), real outbound email/SMS (no live provider exists at all — every
  message is a sandboxed no-op), real AML/e-signature vendor calls (mock providers only, no
  vendor procured), AI coaching roles beyond the read-only Copilot widget (each of the other four
  planned roles literally throws "not implemented in this build" if invoked).
- **Partial, with an explicit caveat required if included:** AML/CTF and e-signature workflows
  are real and well-tested as *workflow rehearsal*, but must never be represented, internally or
  to participants, as having exercised real compliance checks or captured a legally-binding
  signature — no real vendor is behind either.

---

## 5. Blocker register

| ID | Severity | Area | Finding | Evidence | Remediable within this gate? | Owner |
|---|---|---|---|---|---|---|
| B1 | **Critical — gate-blocking** | Security / tenant isolation | No real authentication exists; any user can be impersonated via `POST /auth/dev-login`, and `GET /auth/known-users` unauthenticated-ly enumerates every account | §2 above; `apps/api/src/routes/auth.ts:30-135`, `apps/api/src/lib/env.ts:19-31` | **No** — requires a real identity-verification feature build, explicitly out of this gate's bounded-remediation scope. **Addressed under the separate Critical Blocker Remediation pass** — see §2's status note. | AE Backend Engineering (build); AE Project Owner (accept/authorize any interim mitigation) |
| B2 | **Critical — gate-blocking** | Legal / privacy | 12 of 14 essential pilot legal/privacy artifacts are completely absent from the repository (platform ToS, privacy policy, consent notice, pilot-participation terms, PC service terms, direct-debit authority text, data-processing arrangements, AML responsibility statement, support/complaint process, data export/deletion process — code and documentation both, breach-notification process, record-retention schedule) | `docs/gate-evidence/PHASE7_PRIVACY_AND_LEGAL_INVENTORY.md` | **No** — this report does not draft or certify missing legal documents; supplying and approving them is a business/legal decision. **A full draft pack has since been produced under the Critical Blocker Remediation pass (Phase 7)** — every document marked DRAFT — LEGAL REVIEW REQUIRED and still pending formal legal approval; see `docs/legal/LEGAL_APPROVAL_REGISTER.md`. | AE Project Owner / external legal counsel |
| B3 | **Resolved (Critical Blocker Remediation, Phase 6)** | Jurisdiction | Codebase is built for Australia (AU GST, AUD, AU direct-debit shape, AUSTRAC terminology); gate instruction originally assumed New Zealand; no NZ-specific content exists anywhere. **The AE Project Owner has confirmed the pilot's jurisdiction is Queensland, Australia — the codebase's existing defaults are correct, not a mismatch.** | §0 above; `docs/gate-evidence/PHASE6_JURISDICTION_CORRECTION.md` | **Resolved** — Owner decision received; no code change required. A non-blocking future item (configurable GST rate) is tracked separately. | AE Project Owner (decision received) |
| B4 | **High** | Deployment | No configured path from this repository to a running pilot instance: `.replit` has no `[deployment]` section, its run command starts dev-mode processes only, and no code anywhere serves the built web frontend in any mode | `docs/gate-evidence/PHASE4_ENVIRONMENT_AND_DEPLOYMENT_AUDIT.md` §2 | Partially — configuring a real deployment is bounded infrastructure work, but the frontend-serving decision (API-served static vs. separate host) is a architecture choice this report does not make unilaterally | AE Backend Engineering / AE Project Owner (topology decision) |
| B5 | **High** | Backup / data integrity | Generated transaction documents (10,866 files / 71MB in this mirror) live on local disk via `LocalObjectStorageProvider` with **zero backup coverage of any kind**; the database backup/restore mechanism is proven mechanically but has no automated recurring schedule, no offsite copy, and no encryption at rest for the dump file | `docs/BACKUP_AND_RESTORE_RUNBOOK.md` | Partially — a recurring schedule and an offsite copy target are bounded operational work; a real object-storage backup mechanism may require more | AE Backend Engineering / Platform Ops |
| B6 | **High** | Security (webhook surface) | The only mandate-payment (direct-debit) webhook provider unconditionally accepts any signature and is reachable on the public internet with no per-brokerage scoping; the Grow subscription billing "real" Stripe adapter's signature check is an explicitly self-labelled non-cryptographic placeholder | `docs/INTEGRATION_FALLBACK_MATRIX.md` §"Webhook signature verification" | Partially remediated this pass (structured-logging of the provider-fallback path — see §11); the underlying missing real signature verification is not bounded remediation | AE Backend Engineering |
| B7 | **Medium** | Financial | No real payment rail exists for Pit Crew success fees (sandbox only); invoicing is entirely unimplemented across all billing subsystems | `docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md` §5–6 | N/A — resolved for this pilot by recommending free/manually-invoiced only, not by building a payment rail | AE Backend Engineering (future); AE Project Owner (billing-mode decision) |
| B8 | **Medium** | Operability | No in-app user-lifecycle management (role change, deactivation, admin succession) — every such action requires a direct database write | §4 above; `docs/gate-evidence/PHASE3_CAPABILITY_MATRIX_AND_SCENARIOS.md` | No — a feature build. **Partially addressed under Critical Blocker Remediation Phase 4**: disable/enable is now in-app (`POST /auth/admin/users/:id/disable|enable`); role change and admin succession remain out of scope. | AE Backend Engineering |
| B9 | **Medium** | Observability | No external alerting/paging pipeline exists at all; metrics are real but unscraped; no error-tracking service; no documented log-access mechanism beyond an open console tab | `docs/gate-evidence/PHASE4_ENVIRONMENT_AND_DEPLOYMENT_AUDIT.md` §9–10 | Partially — requires standing up external infrastructure, not a code change | AE Backend Engineering / SRE (role TBD) |
| B10 | **Low, resolved this pass** | Observability hygiene | 5 provider-fallback `console.warn` sites in `packages/integrations/*` bypassed the structured logger and its redaction layer | §11 below | **Yes — fixed this pass** | AE Backend Engineering |

---

## 6. Risk register (accepted, monitored, or carried forward)

| Risk | Status | Detail |
|---|---|---|
| `xlsx@0.18.5` — 2 high-severity advisories (prototype pollution, ReDoS), no patch published | **Accepted** (AE Project Owner, 2026-09-05, expires 2026-12-04) | Unchanged from Step 2 closure; conditions and tracked issue #26 remain in force — see `docs/DEPENDENCY_RISK_ACCEPTANCE.md`. Nothing in this gate expands its exposure or attempts the replacement. |
| Transitive `esbuild` via `drizzle-kit` — 1 moderate advisory, dev-tooling only | **Accepted** (AE Project Owner, 2026-09-05, reviewed at next `drizzle-kit` upgrade or 2026-12-04) | Unchanged from Step 2 closure. |
| Custody boundary ("AE never holds trust money") | **Holds today, not technically enforced** | True in effect — no trust-account model is wired to any charge path, and the only reachable value for `authorisedPaymentMethod` via the current route is the general-account mandate. But the field is unvalidated free text with no downstream check. Recommend a CHECK constraint or explicit assertion before this is relied on beyond a pilot with a fixed, reviewed set of callers. See `docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md` §16. |
| Financial disputes can be opened but never formally closed in-app | **Monitor** | Acceptable for a pilot on synthetic data with no live charging; must be resolved before any live-billing phase. |
| No timeout/circuit-breaker on AML/e-sign/payment/property-data outbound HTTP calls | **Monitor, low current risk** | Currently unreachable because every provider defaults to mock; becomes live risk the moment any is switched to its real HTTP-backed implementation. |
| Structured-logging migration is incomplete platform-wide | **Monitor** | `docs/OBSERVABILITY_STANDARD.md` self-discloses 92 of an original 109 raw `console.*` sites across 41 files remain unconverted, beyond the 5 fixed this pass (§11). Out of this gate's bounded scope; flagged for a dedicated future pass. |
| Communications webhook secret has an insecure, source-visible hardcoded fallback if `COMMUNICATIONS_WEBHOOK_SECRET` is left unset | **Monitor — operational control, not a code gap** | The cryptographic check itself is genuine (HMAC-SHA256, constant-time compare); the risk is an operator forgetting to set the env var, which is not documented in `.env.example`. Recommend adding it there and treating it as a required pilot-launch secret. |
| Pit Crew success-fee GST rate has no per-brokerage/per-jurisdiction override field | **Monitor — tracked future item (Phase 6)** | Correct at 10% for the confirmed Queensland, Australia pilot; not a blocker today. Should be made configurable before any future multi-jurisdiction extension, or if the AU rate changes. See `docs/gate-evidence/PHASE6_JURISDICTION_CORRECTION.md`. |

---

## 7. Operational ownership matrix

| Function | Accountable role |
|---|---|
| Pilot go/no-go, stop-pilot decisions, participant relationship | AE Project Owner |
| First technical response to any triggered incident | AE Backend Engineering (on-call) |
| Non-urgent fixes, code-level remediation, regression tests | AE Backend Engineering |
| Participant-facing communication, intake triage, tracking to closure | AE Support Lead |
| Privacy/security/AML-adjacent decisions, disclosure sign-off | AE Security/Compliance Owner |
| Authentication/tenant-isolation remediation (B1) | AE Backend Engineering, authorized by AE Project Owner |
| Legal/privacy document sourcing and approval (B2) | AE Project Owner / external legal counsel |
| Jurisdiction confirmation (B3) | **Confirmed: Queensland, Australia (AE Project Owner, Critical Blocker Remediation Phase 6)** |
| Deployment topology decision and execution (B4) | AE Project Owner (decision) / AE Backend Engineering (execution) |
| Backup schedule, offsite storage, document-store backup (B5) | AE Backend Engineering / Platform Ops |
| Real webhook signature verification before any real vendor goes live (B6) | AE Backend Engineering |
| Billing-mode decision (free / manually-invoiced only, per Phase 6) (B7) | AE Project Owner |
| User-lifecycle management feature (B8) | AE Backend Engineering |
| Alerting/paging pipeline (B9) | AE Backend Engineering / SRE (role not yet assigned) |

Full incident-specific ownership (16 named scenarios) is defined in
`docs/INCIDENT_RESPONSE_RUNBOOK.md`; day-to-day support ownership in
`docs/PILOT_SUPPORT_AND_ESCALATION.md`.

---

## 8. Pilot scope

Defined in full in `docs/CONTROLLED_PILOT_PLAN.md`. Summary: Run-tier core transaction platform
in scope for rehearsal on synthetic data; Grow CRM and Pit Crew work-item delegation in scope;
Grow billing/success-fee **live charging** excluded (free/manually-invoiced only, per
`docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md`'s explicit recommendation); AI
coaching beyond the read-only Copilot widget excluded (not implemented); Scale tier out of scope
(does not exist in code, no owner authorization sought). **This scope is documented for when the
blockers above are resolved — it does not itself authorise starting the pilot.**

---

## 9. Environment and deployment readiness (condensed — full detail in appendix)

Full findings: `docs/gate-evidence/PHASE4_ENVIRONMENT_AND_DEPLOYMENT_AUDIT.md`. Headline: the
application code itself is disciplined about fail-closed security gates (`NODE_ENV`-gated
session-secret/CORS/metrics-auth checks all correctly crash the boot in production if
misconfigured), but the repository describes a **development workflow, not a deployment** — see
B4. Health/liveness/readiness probes are genuinely well-built. Backup/restore is proven
mechanically twice over but has no real operational backing yet — see B5 and
`docs/BACKUP_AND_RESTORE_RUNBOOK.md`. No release/version identification exists anywhere in a
health response or log line. Capacity controls (request-size limits, rate limiting, AI
token/timeout bounds) are real and enforced.

---

## 10. Integrations (condensed — full detail in appendix)

Full findings: `docs/INTEGRATION_FALLBACK_MATRIX.md`. Every integration capable of a genuine
external side effect defaults to mock/sandbox, and no real vendor credential exists anywhere in
this mirror. Two webhook endpoints (mandate-payments, Grow billing) accept traffic with no
meaningful signature verification even though they are internet-reachable regardless of whether
their underlying provider is "live" — see B6. No live external transaction may be triggered
without separate owner authorization; nothing found in this audit changes that rule.

---

## 11. Remediation completed this pass

Per the gate's own remediation rules (evidenced, necessary for pilot safety, bounded, tested,
consistent with existing architecture; no speculative features, no redesign, no self-approval of
legal/risk decisions):

1. **Repository hygiene (Phase 1):** removed the inert `pnpm-lock.yaml.part2` scratch file after
   verifying zero references anywhere and a successful frozen-lockfile install without it.
   Commit `25f5faae6d8120949128bd8e70af3faa74f839d1`.
2. **Provider-fallback structured logging (Phase 9):** the AML, e-signature, mandate-payments,
   payments, and property-data provider factories (`packages/integrations/{aml,esign,
   mandate-payments,payments,property-data}/src/index.ts`) each had exactly one raw
   `console.warn(...)` call, firing when a real provider was requested but its credentials were
   missing, bypassing the structured logger's correlation-id attachment and redaction. Each of
   the 5 packages now depends on `@aee/events` (a leaf package with zero runtime dependencies —
   confirmed no dependency cycle is introduced) and calls `logger.warn(...)` with a structured
   event name and reason, matching the convention already used throughout `apps/api`.
   `apps/api/src/lib/__tests__/noConsoleUsage.test.ts` — an existing regression test that fails
   the build on any new bare `console.*` call in `apps/api/src` — was extended to also scan
   every `packages/integrations/*/src` directory (discovered dynamically, so a future new
   integration package is covered automatically), closing exactly the cross-package gap the
   original Step 2 pass identified but explicitly left unaddressed pending this decision.
   `pnpm-lock.yaml` was regenerated to record the five new workspace dependencies. Verified: a
   full `pnpm -r run typecheck` passes cleanly across all 13 workspace packages, and the full
   `apps/api` and `@aee/events` test suites pass (see §13) — no test needed to change, since
   `noConsoleUsage.test.ts`'s own logic is what changed and it now passes with zero violations
   across the expanded scope. This did **not** attempt the broader, self-disclosed 92-site
   `console.*` migration backlog (`docs/OBSERVABILITY_STANDARD.md` §6) — that remains a tracked,
   out-of-scope item (risk register, §6).

**Explicitly not attempted, per the gate's own prohibitions:** building real authentication
(B1), drafting or certifying missing legal/privacy documents (B2), resolving the jurisdiction
question (B3), implementing Scale, replacing the `xlsx` parser under issue #26, enabling live
billing, or weakening any existing security control. **B1, B2, and B3 have since been addressed
under the separate "AE Operational Readiness — Critical Blocker Remediation" pass** — see the
status notes in §0, §2, and the blocker register (§5) above, and the renewed Phase 12 completion
report for the full evidence.

---

## 12. Unresolved blockers and external/human decisions required

**Cannot be closed by further engineering work within this gate's rules — status as originally
written, with resolution notes added where applicable:**

- **B1 (Critical, primary):** real authentication must be designed, built, and reviewed as its
  own feature — or the AE Project Owner must explicitly accept a documented, bounded interim
  mitigation (e.g. IP-allowlisting the pilot API, or a genuinely reviewed shared-secret scheme)
  with eyes open about what it does and does not close. Either way, this is a decision and a
  build this report does not make unilaterally. **Addressed under the Critical Blocker
  Remediation pass — no interim mitigation was accepted; a real invitation-only authentication
  system was built instead. See the renewed Phase 12 report for verification evidence.**
- **B2 (Critical):** platform ToS, privacy policy, consent notice, pilot-participation terms, PC
  service terms, a data-processing disclosure covering the AI/AML/e-sign/payment sub-processors
  named in `.env.example`, an AML responsibility statement, a documented support/complaint
  process, a data export/deletion process, a breach-notification process, and a record-retention
  schedule must all be supplied and formally approved by the AE Project Owner and/or legal
  counsel. **This report does not supply, draft, or certify any of these. A full draft pack has
  since been produced (Critical Blocker Remediation, Phase 7) — every document is explicitly
  marked DRAFT — LEGAL REVIEW REQUIRED and formal legal approval is still outstanding; see
  `docs/legal/LEGAL_APPROVAL_REGISTER.md`.**
- **B3 (Resolved):** ~~the AE Project Owner must confirm which jurisdiction this pilot is
  actually for~~ — **resolved: the AE Project Owner has confirmed Queensland, Australia.** The
  GST/currency/mandate-shape findings in
  `docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md` have been re-read against this
  confirmed jurisdiction and found to already be correct as built; see
  `docs/gate-evidence/PHASE6_JURISDICTION_CORRECTION.md`.
- **B4 (High):** a deployment topology decision (how the built web SPA gets served) is an
  architecture choice for the AE Project Owner/Backend Engineering to make together, not
  something this report imposes.
- **B7 (Medium):** the AE Project Owner must confirm the pilot runs free or manually-invoiced
  only, per the Phase 6 recommendation, rather than assuming live charging is authorized by
  default. **Confirmed under Critical Blocker Remediation: free or manually-invoiced only; no
  automated subscription/direct-debit/PC success-fee/trust-money transaction is authorised.**

---

## 13. Test and CI evidence

- **Typecheck:** `pnpm -r run typecheck` — all 13 workspace packages pass cleanly (`packages/db`,
  `packages/domain`, `packages/events`, all 7 `packages/integrations/*`, `apps/web`, `apps/api`),
  including the 5 packages modified in §11.
- **`@aee/events` test suite:** 63/63 passing.
- **`@aee/api` test suite (run to completion against a fresh local Postgres 16 database, after
  the Phase 9 remediation in §11 landed):** `tests 664 / suites 82 / pass 663 / fail 0 /
  cancelled 0 / skipped 1 / todo 0`, wall-clock duration ≈797.8s (~13.3 minutes). The single skip
  is the same pre-existing, explicitly-documented skip noted in the Phase 1 baseline (§1) —
  it is not new, and its justification was not touched by this gate's changes. This is a
  strictly-better result than the 662/662+1-skip baseline recorded in §1: the increase to 664
  total tests reflects the one new sanity-check test this gate's own Phase 9 remediation added
  to `apps/api/src/lib/__tests__/noConsoleUsage.test.ts` (see §11), not a change to
  pre-existing coverage. Zero regressions were introduced by this gate's bounded remediation.
- **Migrations:** a fresh, disposable Postgres 16 database initialised cleanly via the documented
  migration runner (`pnpm --filter @aee/db run db:migrate`) with no manual schema step.
- **Backup/restore drill:** see `docs/BACKUP_AND_RESTORE_RUNBOOK.md` — mechanically proven twice
  over, against `aee_test`/local scratch databases only.
- **Starting branch SHA:** `1c6958a735f4ab1ce92d7d8177e9e4d447b1cbae` (`staging` HEAD at branch
  creation).
- **All commits landed on `feat/operational-readiness-pilot-gate` this pass, in order:**
  1. `25f5faae6d8120949128bd8e70af3faa74f839d1` — Phase 1 housekeeping (`pnpm-lock.yaml.part2` removal).
  2. `86b11c3c04f1a275f03e897520f93d43219c9270` — Phase 9: route the 5
     `packages/integrations/*` provider-fallback `console.warn` sites through the `@aee/events`
     structured logger (5 `src/index.ts` files + 5 `package.json` files).
  3. `2675a7db55e05bf86292a23588c06f4c0f329c71` — Phase 9 companion: extend
     `apps/api/src/lib/__tests__/noConsoleUsage.test.ts` to also scan `packages/integrations/*/src`.
  4. `9cedc8518a50a3afe34308a77e903cf481efe5f0` — Phase 9 companion: regenerate `pnpm-lock.yaml`
     for the 5 new `@aee/events: workspace:*` importer entries; pushed content verified
     byte-for-byte via git-blob-SHA1 (`8f9b5f2202ca36953f86724bc49439f721fa4757`) both before and
     after the push.
  5. `d1624015d848737262d07ffc0e46f1d1b8e5f36c` — `docs/CONTROLLED_PILOT_PLAN.md` and
     `docs/BACKUP_AND_RESTORE_RUNBOOK.md`.
  6. `939765f103b37b10245549fdda21bfbacbd9624e` — `docs/OPERATIONAL_READINESS_GATE_REPORT.md`
     (this report, first version with real test evidence).
  7. `5108bbdfdb7fd1f43234a9349749d3e483c04373` — `docs/PILOT_SUPPORT_AND_ESCALATION.md`,
     `docs/gate-evidence/PHASE3_CAPABILITY_MATRIX_AND_SCENARIOS.md`,
     `docs/gate-evidence/PHASE7_PRIVACY_AND_LEGAL_INVENTORY.md`.
  8. `db1a4aa0a9e65cc66ce805f9894f8045cf7e4f65` — `docs/INTEGRATION_FALLBACK_MATRIX.md`.
  9. `3f5ee1d5908f0d7c11d6f5a7e3082b8aba68a633` — `docs/INCIDENT_RESPONSE_RUNBOOK.md`.
  10. `d3a8ac203716fab5cd2f5c729e453ea60df73807` — `docs/gate-evidence/PHASE4_ENVIRONMENT_AND_DEPLOYMENT_AUDIT.md`.
  11. `f53f478caf60b3f6645f1668e8cf88a83db9ce6e` — `docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md`.
  12. This commit — closes out this section with the final SHA and PR link below.
- **Final branch SHA (this gate's branch):** `f53f478caf60b3f6645f1668e8cf88a83db9ce6e` immediately
  prior to this closing commit. This commit (updating only this section) is the final commit this
  gate's Phase 12 makes on the branch; the PR linked below tracks the branch reference directly, so
  it carries this commit too — see the PR itself, not a hardcoded SHA, for the always-current HEAD
  if the branch is ever updated again after this report is written.

  **Note (Critical Blocker Remediation pass):** the branch was updated substantially again after
  this SHA under the separate remediation instruction described at the top of this report. See
  `docs/gate-evidence/PHASE12_COMPLETION_REPORT_AND_RENEWED_GATE_DECISION.md` for the current
  final SHA and full commit list of that later pass.
- **PR:** [PR #27 — Agent Engine 2.0 — Operational Readiness and Controlled Pilot Gate]
  (https://github.com/AdamJRichards27/AgentEngineEasy/pull/27), opened from
  `feat/operational-readiness-pilot-gate` into `staging` as a **draft**, **not merged**. This
  report does not merge it.

---

## 14. Exact next action

1. AE Project Owner reviews this report and the six supporting deliverable documents.
2. AE Project Owner decides on B1's remediation path (build real auth vs. an explicit, accepted
   interim mitigation) and directs AE Backend Engineering accordingly — this is new work, tracked
   as its own effort, not a continuation of this gate. **Done under Critical Blocker
   Remediation: real auth was built, no interim mitigation accepted.**
3. AE Project Owner and/or legal counsel source and approve the documents listed under B2.
   **A full draft pack now exists (Phase 7); formal legal approval remains outstanding — see
   `docs/legal/LEGAL_APPROVAL_REGISTER.md`.**
4. AE Project Owner confirms the jurisdiction (B3) and directs a re-check of the GST/currency
   findings against it. **Done: confirmed Queensland, Australia; re-check performed and recorded
   in `docs/gate-evidence/PHASE6_JURISDICTION_CORRECTION.md` — the existing AU defaults are
   correct.**
5. Once B1–B3 are closed, re-run this gate (or a focused re-verification of just the closed
   items) before any participant is invited — do not treat this report's other, non-blocking
   findings as a substitute for that re-check. **B1 and B3 are closed; B2 has a draft pack
   pending formal legal approval. The gate has been re-run under the Critical Blocker
   Remediation pass — see its own completion report for the renewed decision.**
6. This gate's own PR ([#27](https://github.com/AdamJRichards27/AgentEngineEasy/pull/27)) stays
   open, as a draft, unmerged, as the durable record of this pass — merging it is a
   documentation-only integration decision for the AE Project Owner once ready, and does not
   itself authorise the pilot.

**This report does not merge its own PR and does not admit pilot participants. It stops here.**
