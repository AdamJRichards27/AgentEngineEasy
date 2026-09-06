# Agent Engine — Legal Document Approval Register (Pilot)

**STATUS: DRAFT — LEGAL REVIEW REQUIRED. This document has not been reviewed or approved by a
qualified Australian lawyer. No document listed below is approved, and none may be distributed to
real pilot participants until it has been reviewed and approved.**

This register tracks the status of every legal/privacy document drafted for the Queensland,
Australia controlled pilot under Phase 7 of the AE Project Owner's remediation instruction. It
exists so that "drafted" and "approved" are never confused with each other. **No row in the Status
column may be marked as anything other than "DRAFT — awaiting legal review" by anyone other than
the qualified Australian lawyer who actually reviews it, and even then only via a separate,
recorded approval action outside this pass.**

A review of the repository's existing documentation at the time of drafting found no pre-existing
customer- or participant-facing legal/privacy document (only internal technical and security
documentation, e.g. security architecture, threat model, and audit-related documents) — consistent
with the earlier finding that this category was almost entirely missing. This register therefore
lists only the 13 documents newly drafted in this pass.

## Register

| Document | Status | Version | Last Updated | Reviewer | Approval Date | Notes / Open Assumptions |
|---|---|---|---|---|---|---|
| [Pilot Terms of Use](./PILOT_TERMS_OF_USE.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | Liability/disclaimer clauses and governing-law clause are placeholders; see document's own assumptions list |
| [Pilot Privacy Policy](./PILOT_PRIVACY_POLICY.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | Controller/processor-style role allocation between Provider and Brokerage, and overseas-disclosure position, both need confirmation |
| [Pilot Participation Agreement](./PILOT_PARTICIPATION_AGREEMENT.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | Commercial terms, liability cap, insurance, and dispute-resolution clauses are placeholders |
| [Data Collection and AI Processing Consent Notice](./DATA_COLLECTION_AND_AI_PROCESSING_CONSENT_NOTICE.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | Correct consent mechanism (notice-and-use vs affirmative opt-in) not yet confirmed |
| [AI Use Disclosure](./AI_USE_DISCLOSURE.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | Must be kept in sync with actual AI provider configuration and the human-approval gate's real behaviour |
| [Cookie and Tracking Notice](./COOKIE_AND_TRACKING_NOTICE.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | Based on a point-in-time code review; must be re-checked against the live deployed build |
| [Data Retention Schedule](./DATA_RETENTION_SCHEDULE.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | All retention periods are placeholders pending confirmation; audit-trail-vs-deletion tension flagged |
| [Data Access, Correction, and Deletion Request Process](./DATA_ACCESS_CORRECTION_DELETION_PROCESS.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | Manual process only — no dedicated tooling exists yet; response-time targets are placeholders |
| [Incident Response and Breach Notification Summary](./INCIDENT_RESPONSE_AND_BREACH_NOTIFICATION_SUMMARY.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | Notifiable Data Breaches scheme applicability not yet confirmed; participant-facing companion to the internal engineering runbooks |
| [Complaints Handling Process](./COMPLAINTS_HANDLING_PROCESS.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | External escalation bodies (OAIC, Queensland real estate regulator) named as "to be confirmed" |
| [Pit Crew Service Terms](./PIT_CREW_SERVICE_TERMS.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | Employment/contractor classification of Pit Crew individuals is the Brokerage's determination, not the Platform's |
| [Subprocessor and Third-Party Service Disclosure](./SUBPROCESSOR_AND_THIRD_PARTY_DISCLOSURE.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | AI provider, property-data provider, and hosting provider rows need live-configuration confirmation |
| [AML/CTF Responsibility Statement](./AML_CTF_RESPONSIBILITY_STATEMENT.md) | DRAFT — awaiting legal review | 0.1 | 2026-09-06 | | | Current AML/CTF "Tranche 2" applicability to real estate agents deliberately left unresolved pending legal confirmation |

## How to use this register

- **Status** must always read "DRAFT — awaiting legal review" until a qualified Australian lawyer
  has completed a review and a person with actual authority to approve pilot-facing legal documents
  has separately signed off — at which point this register should be updated by that process, not
  by whoever drafted the document.
- **Reviewer** and **Approval Date** are intentionally left blank in this pass. They must not be
  filled in as part of drafting work — only as part of an actual, separate legal review and
  approval step.
- **Notes / Open Assumptions** is a summary pointer only — the authoritative list of assumptions for
  each document is the "Assumptions requiring confirmation before legal review" section at the
  bottom of that document itself.

---

### Assumptions requiring confirmation before legal review

- Assumes no pre-existing customer-facing legal/privacy document exists elsewhere in the repository
  outside what this register lists — confirm no such document was missed.
- Assumes all 13 documents will go through legal review together, as one pack, rather than
  piecemeal — confirm this is the intended review process.
- Assumes version numbers reset to 0.1 for this first drafting pass and will be incremented on
  substantive revision, not on every minor wording fix — confirm a versioning convention with
  whoever owns this register going forward.
