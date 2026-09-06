# Agent Engine — AI Use Disclosure

**STATUS: DRAFT — LEGAL REVIEW REQUIRED. This document has not been reviewed or approved by a
qualified Australian lawyer and must not be relied upon or distributed to real pilot participants
until it has been.**

| | |
|---|---|
| Document | AI Use Disclosure |
| Version | 0.1 (draft) |
| Operator | [LEGAL ENTITY NAME] |

This document describes, factually, what the AI-assisted features of the Platform actually do as
built. It is a factual product disclosure, not a compliance certification, and not a statement that
any particular use of AI satisfies a legal or professional-conduct obligation the Brokerage or its
staff may have.

## 1. What the AI does

The Platform's AI-assisted features can: draft or summarise text relevant to a property or
transaction; suggest a next workflow step; and, for a bounded set of defined actions, propose a
specific change (for example, updating a record or progressing a workflow step) for a human to
review.

To do this, selected features assemble contextual information already held in the Platform about
the relevant property or transaction (via the Platform's context-assembly component) and pass it,
along with the request, to an AI processing capability. Which underlying AI provider is actually
processing that request for the pilot is stated in the Subprocessor and Third-Party Service
Disclosure document — it can be a locally simulated ("mock") response with no external call, or a
real third-party AI provider, depending on how the pilot is configured at the time.

## 2. The human-approval gate — how it actually works

This is the central control on AI behaviour in this system, and it is real and enforced in code,
not just policy:

- Any AI-suggested action that would change a record or move a transaction forward is created as a
  **pending request**, not applied immediately.
- That request must be explicitly approved by an authorised human user before a single, dedicated
  part of the system will ever execute it.
- Immediately before execution, the system re-checks that the approval is still valid (for example,
  that the approving user's permissions have not changed and the request has not expired) — an
  earlier approval sitting in a queue is not treated as sufficient on its own.
- Each approved request can be executed once; concurrent or repeated execution attempts are
  prevented at the database level, not just by application logic.
- Certain categories of action never reach the AI-executable queue at all and can only be performed
  by a human directly using the ordinary application, regardless of any AI suggestion.

In short: **the Platform's AI can propose, but a human must approve, before any AI-suggested action
takes effect on a real record.** This is a description of how the system is built, presented as a
factual disclosure — it is not a claim that this design satisfies any particular regulatory,
professional-conduct, or duty-of-care obligation the Brokerage or its licensed staff may have; that
assessment is the Brokerage's own responsibility.

## 3. Limits of the AI features

- AI-generated text and suggestions can be wrong, incomplete, or based on stale or incorrect
  underlying data. They are not verified for legal, financial, or factual accuracy before being
  shown to a user.
- AI output is not legal, financial, tax, or real estate licensing advice, and must not be treated
  as a substitute for the licensed judgement of Brokerage staff.
- The AI does not independently verify facts against any external authoritative source (for
  example, it does not itself confirm land title, verify an identity, or confirm a contract term
  against current legislation).
- AI features are not a substitute for the Brokerage's own review before any transaction step is
  actioned in the real world.

## 4. What data reaches the AI processing capability

Only the property/transaction context the requesting feature specifically assembles is sent to the
AI processing capability for that one request — not a general export of the Brokerage's data.
Whether that data leaves the Platform's own infrastructure at all depends on which AI provider is
configured (see the Subprocessor and Third-Party Service Disclosure document); if a third-party AI
provider is enabled for the pilot, this counts as a disclosure of personal information to that
third party for the purposes of the Pilot Privacy Policy.

## 5. Human oversight beyond the approval gate

A human user can, at any point, disregard an AI suggestion, edit it before approving it, or reject
it outright with no action taken. There is no feature in this pilot build where the AI completes an
entire transaction step end-to-end without a human review point.

---

### Assumptions requiring confirmation before legal review

- Assumes the human-approval gate described above remains unchanged for the duration of the pilot —
  confirm this document is updated before any change that weakens or automates around it.
- Assumes which AI provider (mock/simulated vs a real third-party provider) is active for the pilot
  is tracked accurately and kept in sync with the Subprocessor and Third-Party Service Disclosure
  document — confirm a change-control process exists.
- Assumes Brokerage staff will not treat any AI output as a substitute for their own licensed
  professional judgement — confirm this is reinforced in pilot onboarding/training, not just in this
  document.
- Assumes no AI feature will be extended to bypass the human-approval gate during the pilot without
  this document being reissued first.
