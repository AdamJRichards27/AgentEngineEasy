# Controlled Pilot Plan — Agent Engine 2.0

**Status of this document: contingent, not authorising.** The gate's current overall decision is
**REMEDIATION REQUIRED** as of 2026-09-07 AEST. B2 legal is separately **BLOCKED — HUMAN OR
EXTERNAL DECISION REQUIRED**: all 13 artifacts remain draft/unapproved despite the fail-closed,
SHA-256-artifact-bound acceptance control. No pilot, deployment, participant invitation, live
traffic, or legal approval is authorised by this plan.

---

## Part A — Pilot scope (Phase 2)

### A.1 What "the pilot" means

A small, invitation-only exercise of the current `staging`-branch build of Agent Engine 2.0
against **synthetic/test data only**: 5–10 individually invited real-estate agents (not a
public signup), running real transaction workflows end-to-end for the purpose of operational
and product rehearsal — not a commercial launch, not a source of real revenue, and not a
substitute for the legal/compliance readiness this platform has not yet reached (see the Gate
Report's blocker register).

### A.2 Jurisdiction — RESOLVED: Queensland, Australia

**This section originally read "flagged, not resolved" and is now updated to record the AE
Project Owner's decision.**

The instruction that originally produced this readiness gate assumed a **New Zealand** pilot.
Direct code inspection (Phase 6/7 of the Gate Report) found the codebase is built for the
**Australian** market throughout — AU GST (10%, hardcoded in the Pit Crew fee path with no
override), AUD currency literals, an AU Direct-Debit-Request-shaped mandate flow, AUSTRAC-style
AML/CTF terminology, and NSW-shaped test fixtures. No NZ-specific legal, tax, or regulatory
content exists anywhere in the repository.

**The AE Project Owner has confirmed, in writing, that this pilot's jurisdiction is Queensland,
Australia — not New Zealand.** This resolves the mismatch: the codebase's existing AU defaults
were the correct ones all along for the confirmed jurisdiction, not something requiring a
correction. The GST/currency/mandate-shape findings in Phase 6 have been re-checked against this
confirmed jurisdiction (see `docs/gate-evidence/PHASE6_JURISDICTION_CORRECTION.md`) and found to
already be correct as built. This pilot runs under **AUD currency, 10% GST, and Australian
Direct-Debit-Request-shaped mandate handling**, consistent with the code as it stands. This plan
does not describe, and does not authorise, any multi-jurisdiction or NZ operation.

**Tracked future item (non-blocking for this pilot):** the Pit Crew success-fee GST rate has no
per-brokerage/jurisdiction override field in the schema — fine at the confirmed 10% AU rate today,
but should be made configurable before any future extension to a second jurisdiction. See the
Gate Report's risk register and `docs/gate-evidence/PHASE6_JURISDICTION_CORRECTION.md`.

### A.3 Run / Grow / Scale inclusion boundary

The three-tier "Run / Grow / Scale" framing in the original gate instruction does not fully
match the product as coded (Phase 6 finding: the actual billing catalogue is "Starter" /
"Grow" / "Pro+Grow Bundle" — there is no "Scale" product, price, or entitlement anywhere in the
codebase). Mapping the instruction's intent onto what exists:

- **Run (core transaction platform) — IN SCOPE for pilot rehearsal**, on synthetic data, with
  the specific capability-by-capability inclusion/exclusion already recorded in the Gate
  Report's capability matrix (Phase 3). This is the best-evidenced, most solid part of the
  codebase — a full account-creation-through-closed-transaction path passes a real end-to-end
  test. It is **not** cleared for real customer use because of the platform-wide authentication
  and legal-document gaps described in the Gate Report, which apply regardless of tier.
- **Grow (CRM / lead nurture / Pit Crew / success-fee billing) — PARTIAL, not a blanket
  inclusion.** Entitlement gating for Grow is real and server-side enforced. Within Grow:
  - Relationships/Activities/Opportunities CRM record-keeping: real, tenant-isolated, testable
    — **include** as a manual CRM rehearsal (no automated nurture/lead-scoring exists to pilot).
  - Pit Crew delegated work-item lifecycle (claim/assign/complete/release): real and
    well-tested — **include**.
  - Administrator succession and last-admin protection are implemented with atomic audit and
    session revocation. Any remaining role-management boundary must be assessed against the
    current gate evidence rather than the historical “no user-lifecycle mechanism” finding.
  - Pit Crew success-fee **billing**: calculation math is real and tested, but **no real
    payment rail exists in code at all** (sandbox only) and invoicing is entirely
    unimplemented — **exclude live charging**; see the Gate Report's Phase 6 recommendation
    (free / manually-invoiced only).
  - AI coaching roles beyond the read-only Copilot widget: **not implemented** (each throws
    "not implemented in this build") — **exclude**; nothing exists to pilot there.
- **Scale — OUT OF SCOPE.** No code, schema, or entitlement for a "Scale" tier exists anywhere
  in this repository, and no owner authorization to build or include it has been sought or
  given. This is correctly absent, not a gap to remediate.

### A.4 What this pilot explicitly is not

No public signup. No unrestricted high-impact AI action (only the read-only Copilot widget, at
its existing Level-0 cap, would ever be enabled). No live billing or real charging on any of the
three billing subsystems found in the codebase — free or manually-invoiced only, and no automated
subscription, direct-debit, PC success-fee, or trust-money transaction is authorised. No real
email/SMS delivery (none exists to enable; test/sandbox email only). No live AML/e-signature
vendor calls (none is procured; test/sandbox modes only for any external service). No trust money
received, held, transferred, or disbursed by Agent Engine at any point — this boundary holds
today as an emergent property of what has and hasn't been built (Phase 6), not yet as a
technically enforced invariant, and the Gate Report recommends closing that gap before this claim
is relied on beyond a pilot with a small, reviewed set of callers. No New Zealand operation and no
multi-jurisdiction claim — this pilot is Queensland, Australia only (§A.2).

---

## Part B — Pilot operating plan (Phase 10)

### B.1 Participant selection and count

5–10 individually invited agents, selected and personally invited by the AE Project Owner (or a
role they delegate) — not opened to self-signup.

**Updated under the Critical Blocker Remediation pass:** the original text below described
sharing a brokerage name as a shared-secret workaround, because no invitation mechanism existed
in code at the time. That gap is now closed — see
`docs/gate-evidence/PHASE2_AUTHENTICATION_DESIGN.md` and
`docs/gate-evidence/AUTHENTICATION_THREAT_MODEL.md`. Onboarding is described in §B.4 below using
the real invitation flow; the original shared-brokerage-name approach is retained here, struck
through, purely as a historical record of what this plan said before that system existed:

> ~~Given the Phase 3 finding that no in-app invitation mechanism exists (dev-login is a
> self-serve "join by knowing the brokerage name" flow), the realistic pilot onboarding
> mechanism, until an invitation system is built, is: AE Project Owner privately shares a
> specific brokerage name (treated as a shared secret for the pilot's duration) with each
> invited participant individually, and AE Backend Engineering periodically audits the
> resulting user list (`GET /auth/known-users`) to confirm no unexpected accounts have
> joined.~~

### B.2 Jurisdiction

**Queensland, Australia — confirmed by the AE Project Owner (§A.2).** This plan does not
recommend, and this pilot does not run, simultaneously across two jurisdictions, and no
New Zealand operation is in scope.

### B.3 Functionality included / excluded

As defined in Part A, cross-referenced to the Gate Report's full capability matrix
(`docs/OPERATIONAL_READINESS_GATE_REPORT.md` §3) for the definitive per-capability list.

### B.4 Onboarding

1. AE Project Owner (or a Brokerage Administrator they designate) identifies each participant by
   name, email, and intended role.
2. The Brokerage Administrator sends each participant a real, admin-issued invitation
   (`POST /auth/admin/invitations`) — a single-use, expiring link emailed via the test/sandbox
    email provider in this environment (see `docs/gate-evidence/AUTHENTICATION_THREAT_MODEL.md`).
    This is a future operating procedure only: the current gate does not permit any participant
    invitation.
3. Each participant opens their invitation link, sets their own password, and must affirmatively
   accept the current (still DRAFT — see `docs/legal/LEGAL_APPROVAL_REGISTER.md`) Terms of Use
   and Privacy Policy before their account is created — there is no account creation path that
   skips this.
4. AE Support Lead sends each participant the welcome material referenced in
   `docs/PILOT_SUPPORT_AND_ESCALATION.md` (support channel, hours, what synthetic data means for
   this pilot, and the explicit statement that no real email/SMS/AML/e-signature/payment ever
   fires during this pilot).

**Historical note:** an earlier version of this section described `POST /auth/dev-login`
(name/email/brokerage name, no password, no invitation) as the onboarding mechanism, with the
first participant in a brokerage automatically becoming its Brokerage Administrator. That
mechanism is retained in the codebase only as a development/test fixture (disabled outside an
explicitly enabled development environment) and is no longer how a pilot participant is meant to
be onboarded — see `docs/gate-evidence/AUTHENTICATION_THREAT_MODEL.md` §6.

### B.5 Training

A short walkthrough (live or recorded) would cover the core transaction lifecycle (Scenario A
in the Gate Report), escalation through the support channel, and current documented operating
boundaries. The training must not be scheduled or delivered to participants while the gate
remains remediation-required.

### B.6 Test-to-live transition

**Not part of this plan.** This pilot never transitions to real customer data, real payments, or
real regulated communications while any of the Gate Report's blockers remain open. A future,
separate readiness gate — not a mid-pilot flip of a configuration flag — is required before any
such transition is considered.

### B.7 Support hours, escalation, and severity definitions

Defined in full in `docs/PILOT_SUPPORT_AND_ESCALATION.md` and `docs/INCIDENT_RESPONSE_RUNBOOK.md`
— not duplicated here. Four severities (Critical/High/Medium/Low) with target first-response
times of 15 minutes / 1 hour / 4 business hours / 2 business days respectively.

### B.8 Daily/weekly reviews

Per `docs/PILOT_SUPPORT_AND_ESCALATION.md` §5: a daily 15-minute standup between AE Support Lead
and AE Backend Engineering (on-call) on open items, and a weekly written/verbal summary with the
AE Project Owner covering new/closed issues, anything trending toward a stop-pilot condition, and
incident-log entries.

### B.9 Recommended minimum measures to track during the pilot

1. Number of transactions started and successfully closed end-to-end.
2. Number and category of exceptions/risk-engine findings raised per transaction.
3. Number of manual database interventions still required, if any, recorded against the current
    access-control design. Administrator succession/last-admin protection is implemented and
    must not be described as the former manual-only gap.
4. Number of support requests by severity, and whether each met its target response time.
5. Number of incident-log entries opened (Incident Response Runbook), by scenario number.
6. Number of times a transaction became "stuck" with no clean state to move to (the
   cancellation/fall-through gap).
7. Number of AML/e-signature "review required" or "failed" outcomes and their resolution time.
8. Any instance of a webhook endpoint receiving traffic that failed signature verification (the
   mandate-payments and Grow-billing endpoints in particular — see the Integration Fallback
   Matrix) — a non-zero count here during a pilot with mock providers only would itself be a
   signal worth investigating immediately.
9. Participant-reported confusion patterns (flagged in the weekly review) as possible product
   gaps, not just one-off bugs.
10. Backup/restore evidence, including a successful restoration from the configured **offsite**
     recurring backup destination. The prior local drill is not sufficient on its own.
11. Alert delivery and acknowledgement evidence from the configured external receiver.
12. Uptime / extended-outage count (Incident Runbook scenario 5).
13. Time-to-close per transaction, compared against the Scenario A trace's expected steps.
14. Actual AI (Copilot) usage volume and any cost data, even though no spend cap exists in code.
15. Every stop-pilot condition check (§B.11) reviewed explicitly at each weekly review, whether
    or not it was triggered.

### B.10 Duration and exit criteria

**Recommended duration: 60 days**, matching the gate instruction's own suggestion, provided the
pilot has not been paused under a stop-pilot condition for cause. Exit criteria at the end of the
window: AE Project Owner reviews the retrospective described in
`docs/PILOT_SUPPORT_AND_ESCALATION.md` §5 ("End of pilot") and makes one of three calls —
extend the pilot under the same terms, formally close it out with findings feeding a future
readiness gate for wider launch, or stop it early for cause per §B.11. This plan does not
pre-authorise progression beyond the pilot; that requires a fresh readiness assessment against
whatever has changed by then (in particular: has the authentication gap been fixed, have the
missing legal/privacy documents been supplied and formally approved, has a real payment rail been
built if live billing is ever wanted).

### B.11 Mandatory stop-pilot conditions

Any of the following pauses the pilot immediately, per
`docs/INCIDENT_RESPONSE_RUNBOOK.md` scenario 15:

1. Confirmed cross-tenant data exposure.
2. A material privacy or security incident.
3. An incorrect financial charge actually reaching a participant (should not be structurally
   possible under this plan's no-live-billing constraint — its occurrence would itself indicate
   the no-live-billing control had been bypassed, which is independently Critical).
4. Data loss or corruption.
5. An unrecoverable service failure.
6. An uncontained AML/identity-handling failure.
7. Inability to restore data from backup when needed.
8. A critical defect with no safe workaround.
9. AE Project Owner's own judgment that continuing risks participant trust or data integrity
   beyond what the pilot is meant to accept.

---

## What must happen before this plan can actually start

This plan cannot start while the gate decision is **REMEDIATION REQUIRED**. Before any future
authorisation, the following must be independently evidenced: a real offsite backup provider and
recurring scheduler with recovery proof; external alert receiver delivery and acknowledgement;
the selected PostgreSQL-records plus durable-object-storage implementation including signed-byte
ingestion; and completed CI for the actual branch HEAD (currently pending, not a pass).

Separately, B2 remains **BLOCKED — HUMAN OR EXTERNAL DECISION REQUIRED**: all 13 legal/privacy
artifacts must receive formal approval. SHA-256-bound, fail-closed acceptance does not make draft
legal terms approved. Jurisdiction is resolved as Queensland, Australia, and authentication,
administrator succession, and the current webhook security matrix have technical evidence, but
none of those facts authorises a pilot before the remaining remediation and legal decision.
