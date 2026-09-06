# Agent Engine — Pilot Terms of Use

**STATUS: DRAFT — LEGAL REVIEW REQUIRED. This document has not been reviewed or approved by a
qualified Australian lawyer and must not be relied upon or distributed to real pilot participants
until it has been.**

| | |
|---|---|
| Document | Pilot Terms of Use |
| Version | 0.1 (draft) |
| Applies to | The single controlled pilot deployment of Agent Engine for one Queensland, Australia real estate brokerage |
| Operator | [LEGAL ENTITY NAME], ABN [ABN], [REGISTERED BUSINESS ADDRESS] |
| Governing law (proposed, pending confirmation) | Queensland, Australia |

This draft does not claim to be compliant with the *Australian Consumer Law* (Schedule 2 of the
*Competition and Consumer Act 2010* (Cth)), the *Property Occupations Act 2014* (Qld), the *Agents
Financial Administration Act 2014* (Qld), or any other law. It is a starting point for a qualified
Australian lawyer to review before any real pilot participant is asked to accept it.

## 1. What this pilot is

Agent Engine ("the **Platform**") is a workflow and record-keeping tool for real estate agency
transactions, being trialled in a single controlled pilot with one real estate brokerage licensed
in Queensland, Australia ("the **Brokerage**"). These Terms of Use apply to individuals the
Brokerage's administrator invites to use the Platform during the pilot ("**you**", "**Pilot
Participant**").

The Platform is a tool the Brokerage uses to run its own business. It does not replace, and does
not transfer to [LEGAL ENTITY NAME], any of the Brokerage's own legal, licensing, trust account, or
consumer-law obligations. See the separate AML/CTF Responsibility Statement and Pit Crew Service
Terms for more on this division of responsibility.

## 2. Access and accounts

- Access is **invitation-only**. An administrator at the Brokerage issues each account; there is no
  public sign-up during the pilot.
- Accepting an invitation requires setting a password. Passwords are stored using Argon2id hashing
  and are never visible to [LEGAL ENTITY NAME] staff, the Brokerage's administrators, or anyone
  else in plain text.
- After five consecutive failed login attempts, an account is temporarily locked as an automatic
  security control.
- You must keep your login credentials confidential and must not share your account with another
  person. Each Pilot Participant should hold their own individual account.
- Your access can be suspended or removed by a Brokerage administrator, or by [LEGAL ENTITY NAME],
  at any time during the pilot, including immediately, without that being treated as a penalty.

## 3. AI-assisted features

The Platform includes AI-assisted features (drafting suggestions, summaries, and workflow
suggestions). **No AI-suggested action that changes a record or moves a transaction forward takes
effect automatically — a human user must explicitly review and approve it first.** This is how the
underlying system is built, not a promise about future versions. See the separate AI Use Disclosure
for the full description of what the AI does and does not do.

## 4. Sandbox-only external services during the pilot

During this pilot, the following are **explicitly configured in test/sandbox mode only**, per the
AE Project Owner's remediation instruction: AML/identity verification, e-signature, payment
processing (including any direct-debit mandate), and property-data lookups against a live
third-party source. This means that, unless and until [LEGAL ENTITY NAME] tells you otherwise in
writing:

- No AML/identity check performed "through" the Platform is a real check with legal effect.
- No signature captured "through" the Platform is a legally effective electronic signature.
- No payment, invoice charge, subscription, or direct debit is actually processed by the Platform.
- No property-data lookup queries a live external data source unless separately confirmed.

Anything that needs to be legally or financially real — an actual signature, an actual AML check, an
actual payment, an actual trust account transaction — must be completed through the Brokerage's
existing outside-the-Platform processes, not assumed to have happened because the Platform's
interface shows a status of "sent" or "complete."

## 5. No trust money

The Platform does not hold, receive, transmit, or have custody of trust money at any point. All
trust money remains solely within the Brokerage's own trust account, governed by the Brokerage's
own obligations under Queensland property agent trust account law. This is a structural fact about
how the system is built, not a policy that could be switched off.

## 6. Fees

The pilot is provided free of charge, or on a manually invoiced basis only, in Australian dollars
(AUD), with GST (at the standard 10% rate, subject to the operating entity's GST registration
status being confirmed) applied where applicable. No automated subscription billing, direct debit,
or Property Coordinator success-fee payment is processed automatically by the Platform during the
pilot.

## 7. Acceptable use

You agree not to: use the Platform for any unlawful purpose; attempt to bypass or defeat any
security control; access another Pilot Participant's account or data outside your role; introduce
malicious code; or use the Platform to process data belonging to a minor as a Pilot Participant
(Pilot Participants are expected to be Brokerage staff/contractors, not members of the public).

## 8. No professional advice

Nothing generated by the Platform, including any AI-assisted output, is legal, financial,
tax, or real estate licensing advice. The Brokerage and its staff remain responsible for exercising
their own professional judgement and for meeting their own licensing obligations.

## 9. Disclaimer and limitation of liability (placeholder)

The Platform is provided during a controlled pilot on an "as is" and "as available" basis, without
warranty of any kind, express or implied. *[Placeholder: a qualified lawyer must draft the actual
disclaimer and liability-limitation clauses here, considered against the Australian Consumer Law's
consumer guarantees and any restrictions on excluding them.]*

## 10. Confidentiality

Pilot Participants must treat any non-public information about the Platform, the pilot, and its
outcomes as confidential, and must handle Brokerage client information in line with the Brokerage's
own confidentiality obligations and the Platform's Privacy Policy.

## 11. Ending the pilot

[LEGAL ENTITY NAME] or the Brokerage may end the pilot, or any individual's participation in it, at
any time. Provisions expected to survive ending the pilot include confidentiality, the disclaimer
of liability, and data handling obligations described in the Privacy Policy and Data Retention
Schedule.

## 12. Governing law (placeholder)

These Terms are proposed to be governed by the laws of Queensland, Australia, with the courts of
Queensland having jurisdiction — **pending confirmation by a qualified Australian lawyer**, including
whether this is appropriate given the Australian Consumer Law's non-excludable consumer
guarantees and any mandatory Queensland real estate regulation.

## 13. Contact

Questions about these Terms: [PRIVACY CONTACT EMAIL].

---

### Assumptions requiring confirmation before legal review

- Assumes all Pilot Participants are adult Brokerage staff or contractors, not members of the
  public and not minors — confirm.
- Assumes the pilot will remain free or manually invoiced only for its full duration, with no
  automated billing switched on partway through — confirm before any change.
- Assumes no live AML, e-signature, payment, or property-data provider will be enabled without this
  document being reviewed and reissued first — confirm change-control process.
- Assumes Queensland is the correct and sole governing-law choice for a single-brokerage Queensland
  pilot — confirm no other jurisdiction is engaged (e.g., a Brokerage office outside Queensland).
- Assumes [LEGAL ENTITY NAME]'s corporate structure and ABN are available before this document is
  finalised — currently placeholders.
