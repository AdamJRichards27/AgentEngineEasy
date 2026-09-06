# Agent Engine — Legal Document Approval Register (Pilot)

**OVERALL STATUS: REMEDIATION REQUIRED. B2: BLOCKED — HUMAN OR EXTERNAL DECISION REQUIRED.**

**Register status: DRAFT — LEGAL REVIEW REQUIRED.** This register and every document listed below
are drafts. None has been reviewed or approved by a qualified Australian lawyer; no approval
authority has been assigned; and no document may be distributed to real pilot participants or
activated in production. This register records no legal approval.

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

| Document | Status | Version | Reviewer | Approval authority | Approval date | Notes / Open Assumptions |
|---|---|---|---|---|---|---|
| [Pilot Terms of Use](./PILOT_TERMS_OF_USE.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Liability/disclaimer clauses and governing-law clause are placeholders |
| [Pilot Privacy Policy](./PILOT_PRIVACY_POLICY.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Controller/processor role allocation and overseas-disclosure position need confirmation |
| [Pilot Participation Agreement](./PILOT_PARTICIPATION_AGREEMENT.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Commercial terms, liability cap, insurance, and dispute resolution are placeholders |
| [Data Collection and AI Processing Consent Notice](./DATA_COLLECTION_AND_AI_PROCESSING_CONSENT_NOTICE.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Correct consent mechanism remains unconfirmed |
| [AI Use Disclosure](./AI_USE_DISCLOSURE.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Must match actual AI-provider configuration and human-approval behaviour |
| [Cookie and Tracking Notice](./COOKIE_AND_TRACKING_NOTICE.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Requires review against the live deployed build |
| [Data Retention Schedule](./DATA_RETENTION_SCHEDULE.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Retention periods are placeholders; audit-trail/deletion tension remains |
| [Data Access, Correction, and Deletion Request Process](./DATA_ACCESS_CORRECTION_DELETION_PROCESS.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Manual process; response-time targets are placeholders |
| [Incident Response and Breach Notification Summary](./INCIDENT_RESPONSE_AND_BREACH_NOTIFICATION_SUMMARY.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | NDB scheme applicability requires confirmation |
| [Complaints Handling Process](./COMPLAINTS_HANDLING_PROCESS.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | External escalation bodies remain to be confirmed |
| [Pit Crew Service Terms](./PIT_CREW_SERVICE_TERMS.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Employment/contractor classification is unresolved |
| [Subprocessor and Third-Party Service Disclosure](./SUBPROCESSOR_AND_THIRD_PARTY_DISCLOSURE.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Provider and hosting rows need live-configuration confirmation |
| [AML/CTF Responsibility Statement](./AML_CTF_RESPONSIBILITY_STATEMENT.md) | DRAFT — unapproved | 0.1 | Unassigned | Unassigned | — | Tranche 2 applicability remains unresolved |

## Production activation control — engineering only, not approval

Production startup and participant acceptance use a **SHA-256-bound artifact control** for the
active Terms of Use and Privacy Policy. In production the service requires the explicit deployment
input `LEGAL_DOCUMENTS_APPROVED=true`, readable artifact paths, and 64-character SHA-256 digests.
It reads the configured bytes, recomputes each digest, rejects a mismatch or an artifact containing
the draft marker, and records the digest (`sha256:<digest>`) as the acceptance version. Missing,
unreadable, draft, or mismatched artifacts fail closed.

This is an engineering integrity and configuration control: it binds the shown/accepted bytes to a
configured digest and prevents implicit activation of repository drafts. It does **not** determine
whether a document is legally sufficient, appoint an approver, evidence legal review, or create
legal approval. No hash or artifact path is populated for this draft pack.

## How to use this register

- **Status** must remain `DRAFT — unapproved`, and **Reviewer**, **Approval authority**, and
  **Approval date** must remain unassigned/empty, until actual legal review and a separately
  recorded decision by an assigned authority occur outside drafting work.
- The SHA-256 startup/acceptance control above must never be used as a substitute for those human
  decisions or as a reason to change this register's status.
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
- Production activation remains blocked pending assignment of an approval authority, qualified
  legal review, an actual approval decision, approved non-draft artifacts, and their deployment
  configuration.
