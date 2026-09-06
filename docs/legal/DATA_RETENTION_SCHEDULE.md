# Agent Engine — Data Retention Schedule (Pilot)

**STATUS: DRAFT — LEGAL REVIEW REQUIRED. This document has not been reviewed or approved by a
qualified Australian lawyer and must not be relied upon or distributed to real pilot participants
until it has been.**

| | |
|---|---|
| Document | Data Retention Schedule |
| Version | 0.1 (draft) |
| Operator | [LEGAL ENTITY NAME] |

Every period below is a **proposed starting point**, not a confirmed policy. None of it has been
checked against the Brokerage's own Queensland real estate record-keeping obligations (for example,
under the *Agents Financial Administration Act 2014* (Qld)) or against the *Privacy Act 1988* (Cth)
requirement to not keep personal information longer than needed. A qualified Australian lawyer, and
the Brokerage's own compliance advisor, must confirm each row before this schedule is relied upon.

## Retention periods (proposed)

| Data category | Examples | Proposed retention (pending confirmation) | Basis / notes |
|---|---|---|---|
| Pilot Participant account data | Name, email, password hash, role | Duration of pilot participation + [PERIOD, e.g. 90 days] after account deactivation, then anonymise or delete | Needed to operate accounts; period after deactivation is a placeholder |
| Login/account-security metadata | Login timestamps, failed attempts, lockouts | Same as account data above, or a shorter rolling window (e.g. [PERIOD]) for granular login history | Security monitoring value diminishes over time |
| Party PII (transaction parties) | Name, email, mobile, address of buyers/sellers/solicitors | For the life of the relevant transaction, plus a statutory-style record-keeping period of **[PERIOD — assumed 5 years pending confirmation against Queensland real estate record-keeping requirements]** | Aligns with typical real estate record-keeping expectations; exact period not yet confirmed |
| Financial — commercial terms | Commission agreement terms, PC fee authority terms | Same as the related transaction/agreement record above | Tied to the underlying commercial record |
| Financial — provider references (sandbox) | Mock/sandbox payment or mandate references | Same as the related transaction, or shorter given no real funds move | No live financial data exists in sandbox mode |
| Documents | Generated/signed agreement content | Same proposed period as Party PII above | Documents are the primary evidentiary record of a transaction |
| AML/compliance records | Verification status, exceptions (sandbox in this pilot) | Same proposed period as Party PII above | Even sandbox-mode records should follow a documented, not ad hoc, retention rule |
| Communications | Message content, consent state (sandbox email/SMS in this pilot) | [PERIOD — proposed shorter than transaction records, e.g. 2 years] | To be confirmed against any applicable record-keeping expectation |
| Operational | Tasks, workflow state, Pit Crew assignments | Same as the related transaction record | Operational history supports dispute resolution |
| Audit trail | Who did what, when, against which record | Proposed to be retained for longer than the underlying record it documents (e.g. [PERIOD]), given its accountability purpose | Deleting an audit entry before the record it documents undermines its purpose — flagged as a tension to resolve with legal input, see Data Access/Correction/Deletion Process |
| Integration credential references | Opaque generated identifiers (never real secrets) | Deleted when the credential is rotated/revoked | Not personal information; included for completeness |
| Provider secrets | API keys, webhook secrets | Held only in environment configuration, not application data; rotated on a schedule set by operations | Not personal information |

## What happens at the end of the pilot

If the pilot does not continue into a further engagement, [LEGAL ENTITY NAME] proposes to, within
[PERIOD, e.g. 90 days] of pilot end: export or hand back to the Brokerage any data it wants to keep
for its own records, and then delete or irreversibly anonymise the remainder, subject to (a) any
audit-trail retention needed for accountability of the pilot itself, and (b) any legal hold notified
in writing. **This end-of-pilot process is a placeholder and has not been agreed with the Brokerage
or reviewed by a lawyer.**

---

### Assumptions requiring confirmation before legal review

- Assumes a 5-year-style record-keeping expectation for transaction and document records — this is
  a placeholder, not a confirmed figure; confirm against Queensland real estate record-keeping law.
- Assumes audit-trail records may need to outlive the records they document — flagged as a genuine
  tension with individual deletion requests; needs a lawyer's input on how to reconcile the two.
- Assumes an end-of-pilot data handback/deletion period of around 90 days is workable — confirm with
  the Brokerage.
- Assumes no data in this pilot is currently held outside Australia in a way that changes retention
  obligations — confirm against the Subprocessor and Third-Party Service Disclosure document.
- Assumes none of these periods have been implemented as automated deletion in the product yet —
  confirm this schedule is a policy target, not a description of an existing automated process.
