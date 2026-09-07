# Agent Engine — Pilot Privacy Policy

**STATUS: DRAFT — LEGAL REVIEW REQUIRED. This document has not been reviewed or approved by a
qualified Australian lawyer and must not be relied upon or distributed to real pilot participants
until it has been.**

| | |
|---|---|
| Document | Pilot Privacy Policy |
| Version | 0.1 (draft) |
| Operator | [LEGAL ENTITY NAME], ABN [ABN], [REGISTERED BUSINESS ADDRESS] |
| Privacy contact | [PRIVACY CONTACT EMAIL] |

This draft is written with reference to the structure of the *Privacy Act 1988* (Cth) and the
Australian Privacy Principles (APPs) **to be confirmed against** by a qualified Australian lawyer.
It does not claim that [LEGAL ENTITY NAME] currently complies with the Privacy Act or the APPs, and
it does not represent legal advice.

## 1. Who this applies to

This Policy covers personal information handled by the Platform during the single controlled pilot
with one Queensland, Australia real estate brokerage ("the **Brokerage**"). It covers two groups:

1. **Pilot Participants** — the Brokerage's staff/contractors invited to use the Platform.
2. **Transaction parties** — buyers, sellers, solicitors, and other individuals whose details a
   Pilot Participant enters into the Platform in the course of running the Brokerage's real
   property transactions ("**Party Data**"). For Party Data, [LEGAL ENTITY NAME] generally acts as
   a service provider processing information on the Brokerage's instructions, while the Brokerage
   remains the party with the direct relationship to those individuals — **this allocation of roles
   requires confirmation by a qualified Australian lawyer** before the pilot processes any real
   transaction party's information.

## 2. What personal information is collected

**About Pilot Participants**, tied to the new invitation-only authentication system:

- Name, email address, and role (set by a Brokerage administrator when the invitation is issued).
- A password **hash** (Argon2id) — the actual password is never stored or visible to anyone,
  including [LEGAL ENTITY NAME].
- Login and account-security metadata: sign-in timestamps, failed login attempts, temporary account
  lockouts, password-reset requests, and an audit trail of security-relevant account events (e.g.
  invitation issued, invitation accepted, password changed, account disabled).
- A signed session identifier stored in a browser cookie (see the Cookie and Tracking Notice).

**About transaction parties (Party Data)**, entered by Pilot Participants in the ordinary course of
running a real property transaction: name, email, mobile number, and residential address of
buyers, sellers, and their solicitors, plus records of AML/verification status, documents, and
communications related to the transaction.

**Operational and audit data**: workflow/task state, Pit Crew assignment records, and an audit log
recording who did what, when, against which record.

## 3. How AI-assisted processing works

Selected features build a prompt from property and transaction data already in the Platform (for
example, to draft a summary or suggest a next step) and send it to an AI processing capability. **No
AI-suggested action that would change a record or move a transaction forward is applied
automatically — it always requires a human user's explicit approval first.** See the AI Use
Disclosure and the Data Collection and AI Processing Consent Notice for detail, including which AI
provider is in use for the pilot.

## 4. Why this information is collected

To operate the pilot: to authenticate Pilot Participants; to let them record and progress real
property transactions; to generate AI-assisted suggestions on request; to maintain an audit trail;
and to support the Brokerage's own business operations. Information is not used for advertising,
and the Platform does not run third-party analytics or ad-tracking (see the Cookie and Tracking
Notice).

## 5. Storage and security

- Passwords are hashed with Argon2id and never stored in plain text.
- Sessions are authenticated with a signed, `HttpOnly` cookie; a session can be revoked instantly
  (e.g. on logout or password reset) by the underlying system.
- Data is scoped per brokerage in the system's data model.
- No system in this pilot build is described as encrypting data beyond standard
  transport/storage protections already documented in the platform's technical security
  documentation — **a qualified reviewer should confirm what level of at-rest/in-transit encryption
  the actual pilot hosting environment provides**, as this document does not independently verify
  infrastructure-level encryption.

## 6. Disclosure to third parties

Personal information may be disclosed to the limited set of third-party service providers
("subprocessors") described in the separate Subprocessor and Third-Party Service Disclosure
document. As at the date of this draft, the AML, e-signature, payment, and live property-data
integrations are in sandbox/test mode and are **not** sending real personal information to a live
external vendor for those functions. Any AI provider and any provider actually enabled for the
pilot is listed in that document — **check it for the current, accurate list** rather than assuming
this Policy's narrative text alone is exhaustive.

## 7. Overseas disclosure

Some potential service providers referenced in the Subprocessor and Third-Party Service Disclosure
document (for example, an AI processing provider or a mapping/property-data provider, if enabled)
may operate infrastructure outside Australia. **Whether this pilot actually sends personal
information overseas, to which countries, and what APP 8 cross-border disclosure steps apply, is
not yet confirmed and must be resolved before this Policy is finalised.**

## 8. No trust money

[LEGAL ENTITY NAME] does not hold, receive, or transmit trust money through the Platform. Financial
information handled by the Platform is limited to commission/fee calculation records and (in
sandbox mode only) payment-provider references — never trust account funds.

## 9. Retention

See the separate Data Retention Schedule for proposed retention periods by data category. All
periods in that document are proposed and pending confirmation.

## 10. Access, correction, and deletion

See the separate Data Access, Correction, and Deletion Request Process document for how an
individual can ask to see, correct, or request deletion of their personal information, and the
practical limits on deletion (for example, audit-trail integrity requirements).

## 11. Complaints

See the separate Complaints Handling Process document. A privacy complaint that cannot be resolved
directly may ultimately be referable to the Office of the Australian Information Commissioner
(OAIC) — **to be confirmed** as the correct external body once this Policy's compliance basis is
reviewed.

## 12. Changes to this Policy

This Policy may be updated during the pilot. Material changes will be communicated to Pilot
Participants. This is a draft and has not yet had its first real version issued to any participant.

## 13. Contact

[PRIVACY CONTACT EMAIL].

---

### Assumptions requiring confirmation before legal review

- Assumes the Brokerage, not [LEGAL ENTITY NAME], is the primary point of contact for transaction
  parties whose Party Data is entered into the system — confirm the controller/processor-equivalent
  allocation of responsibility.
- Assumes no special/sensitive categories of information (e.g. health information) are
  intentionally collected — confirm nothing in AML or party notes captures sensitive information
  beyond what is necessary.
- Assumes the AI provider and property-data provider configuration in effect during the pilot
  matches what is stated in the Subprocessor and Third-Party Service Disclosure document at any
  given time — confirm a change-control process keeps both documents in sync.
- Assumes the hosting environment's at-rest/in-transit encryption posture will be independently
  confirmed and, if needed, added to this Policy.
- Assumes 30 days as a starting point for responding to privacy requests, pending confirmation
  against the Privacy Act 1988 (Cth) timeframes.
