# Agent Engine — Pit Crew (Property Coordinator) Service Terms

**STATUS: DRAFT — LEGAL REVIEW REQUIRED. This document has not been reviewed or approved by a
qualified Australian lawyer and must not be relied upon or distributed to real pilot participants
until it has been.**

| | |
|---|---|
| Document | Pit Crew Service Terms |
| Version | 0.1 (draft) |
| Applies to | Individuals using the Platform's "Pit Crew" (Property Coordinator) role during the pilot |

## 1. What the Pit Crew role is, on this Platform

"Pit Crew" is a role within the Platform for a Property Coordinator who claims, works on, and
resolves outstanding tasks/exceptions on a property transaction (for example, an AML follow-up, a
contract-condition chase-up, or a listing/settlement task) on the Brokerage's behalf. The Platform
provides the coordination screen, claiming/assignment mechanics, and a fee-calculation feature — it
does not itself define the employment, contracting, or licensing relationship between a Pit Crew
individual and the Brokerage. **That relationship is between the Pit Crew individual and the
Brokerage, and remains subject to whatever licensing Queensland law requires for the tasks actually
performed** — this is the Brokerage's responsibility to determine, not something the Platform
decides or guarantees.

## 2. How the success-fee calculation works, factually

Where a Pit Crew fee authority is configured for a transaction, the Platform calculates a fee, in
**Australian dollars (AUD)**, as a percentage of, or a fixed amount related to, the transaction's
commission figure (either commission excluding GST or commission including GST, depending on the
authority's configuration), plus GST at **10%, assumed pending confirmation of the operating
entity's GST registration status**, where the authority is flagged as GST-applicable. Every calculation is recorded as an immutable
record — a recalculation produces a new record rather than editing a prior one, so the calculation
history for a transaction is never silently overwritten.

**This is a calculation feature, not a payment feature.** Calculating a fee amount does not, by
itself, move any money.

## 3. Payment of the fee — sandbox only during the pilot

During this pilot, no automated payment or direct-debit collection of a Pit Crew fee is authorised
or active. Any debit-mandate payment integration in the Platform operates in sandbox/test mode only
— it can simulate a scheduled debit for testing purposes, but **no real bank debit occurs and no
real funds move through the Platform**. Any real payment of a Pit Crew fee during the pilot must
happen through the Brokerage's existing outside-the-Platform payment arrangements (for example,
direct arrangement between the Brokerage and the Pit Crew individual), consistent with the
commercial terms set out in the Pilot Terms of Use and Pilot Participation Agreement (free or
manually invoiced only).

## 4. No trust money

Pit Crew fees calculated by the Platform are not trust money, and the Platform does not hold,
receive, or transmit trust money in connection with the Pit Crew feature or otherwise.

## 5. Claiming and assignment

Work items are claimed or assigned through the Platform's coordination screen, with a defined set
of valid status transitions (for example, unclaimed → claimed → in progress → done). Concurrent
claiming conflicts are resolved so that only one claim can succeed for a given item at a time; a
Pit Crew individual whose claim attempt loses that race will be asked to refresh and try again
rather than silently overwriting someone else's claim.

## 6. Disputes about a fee calculation

If a Pit Crew individual or the Brokerage disputes a calculated fee amount, raise it with the
Brokerage administrator in the first instance; the underlying calculation record (including any
rounding adjustment applied) can be reviewed to understand how the figure was reached. See also the
Complaints Handling Process for how to escalate a dispute about the Platform itself.

## 7. No licensing or compliance transfer

Nothing in these terms, or in the Platform's Pit Crew feature, transfers any real estate licensing,
work-health-and-safety, contractor-classification, or tax-withholding obligation from the Brokerage
to [LEGAL ENTITY NAME], or vice versa. The Platform is a coordination and calculation tool only.

---

### Assumptions requiring confirmation before legal review

- Assumes the Brokerage — not [LEGAL ENTITY NAME] — determines and is responsible for the
  employment/contractor classification and licensing status of each Pit Crew individual — confirm.
- Assumes the 10% GST assumption used in fee calculations reflects the operating entity's actual
  GST registration status — confirm with the Brokerage's accountant before treating any calculated
  figure as final.
- Assumes no automated payment or direct-debit collection of a Pit Crew fee will be enabled during
  the pilot without this document being reissued first.
- Assumes fee-calculation disputes are rare enough during a small pilot to be handled manually via
  the Brokerage administrator — confirm this is acceptable, or whether a firmer dispute process is
  needed before go-live.
