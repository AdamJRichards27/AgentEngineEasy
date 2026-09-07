# Agent Engine — Data Access, Correction, and Deletion Request Process

**STATUS: DRAFT — LEGAL REVIEW REQUIRED. This document has not been reviewed or approved by a
qualified Australian lawyer and must not be relied upon or distributed to real pilot participants
until it has been.**

| | |
|---|---|
| Document | Data Access, Correction, and Deletion Request Process |
| Version | 0.1 (draft) |
| Contact | [PRIVACY CONTACT EMAIL] |

This describes, in plain terms, how a Pilot Participant or a transaction party can ask to see,
correct, or have deleted the personal information the Platform holds about them during the pilot.
It is a manual process description for a controlled pilot, not a description of dedicated
self-service tooling — no such tooling exists in the product as built.

## 1. How to make a request

Send a request to [PRIVACY CONTACT EMAIL], or, if you are a Pilot Participant, ask your Brokerage
administrator to raise it on your behalf. Please tell us: your name, the account or transaction the
information relates to, and whether you want to **access**, **correct**, or **delete** it.

## 2. Verifying who is asking

Because this is a manual, small-scale pilot process, a request will be verified against the
account/contact details already on file (for example, confirming the request comes from the email
address already associated with the account) before any information is disclosed or changed. A
request that cannot be reasonably verified will not be actioned until identity is confirmed.

## 3. Access requests

We will confirm what personal information is held (account data, and, where relevant, Party PII
entered against a transaction you are named in), and provide a copy in a readable form. **Response
timeframe: proposed [PERIOD, e.g. within 30 days], pending confirmation** against applicable
Australian privacy law.

## 4. Correction requests

If information about you is inaccurate, out of date, or incomplete, tell us what should change. A
Pilot Participant's own account details can usually be corrected directly by a Brokerage
administrator through the ordinary application. A transaction party's details are corrected by the
Pilot Participant handling that transaction, at the Brokerage's direction. We will confirm once a
correction has been made.

## 5. Deletion requests — and their limits

We will action a deletion request as far as is reasonably practicable, but there are real,
disclosed limits during the pilot:

- **Audit trail.** The system's audit log records actions taken against a record (who did what,
  when) as an accountability mechanism. Deleting the underlying record does not necessarily delete
  the audit trail referencing it — the audit trail may be retained, in a minimised or anonymised
  form where reasonably possible, for accountability purposes. This tension is disclosed, not
  resolved, in this draft; **a qualified Australian lawyer must confirm how far a deletion
  obligation extends over an audit trail.**
- **Active transactions.** Information still needed to complete a live property transaction cannot
  be deleted until that need has passed, without compromising the transaction.
- **No automated purge tooling.** As built, there is no dedicated "erase this person's data" feature
  in the product — a deletion request during the pilot is carried out manually by engineering/admin
  staff, which may affect how quickly and how completely it can be done. This is disclosed here
  rather than promised away.
- **Sandbox/test data.** Any AML, e-signature, or payment reference tied to the sandbox-mode
  integrations does not represent a real external record and can generally be deleted or
  anonymised without needing to contact any external provider, since no live provider holds it.

## 6. What we will tell you

For every request, we will confirm what was done (or explain what could not be done and why, per
§5 above) in writing to the contact email used to make the request.

## 7. If you're not satisfied

See the separate Complaints Handling Process document for how to escalate if you are not satisfied
with how a request was handled.

---

### Assumptions requiring confirmation before legal review

- Assumes a manual, staff-mediated process is an acceptable interim approach for a small controlled
  pilot — confirm this is proportionate, or whether minimum tooling is required before go-live.
- Assumes a 30-day response target is an appropriate starting point — confirm against applicable
  Australian privacy law timeframes.
- Assumes the audit-trail-vs-deletion tension described in §5 will be resolved with legal input
  before any real deletion request is received, not reactively during the pilot.
- Assumes verification-by-known-contact-details is an adequate identity check for this pilot's risk
  level — confirm, particularly for a request claiming to be made on behalf of someone else.
