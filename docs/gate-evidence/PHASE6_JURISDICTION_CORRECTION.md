# Phase 6 — Jurisdiction Correction: New Zealand → Queensland, Australia

`docs/gate-evidence/PHASE6_JURISDICTION_CORRECTION.md`

**Owner instruction this document implements:** "AE Operational Readiness — Critical Blocker
Remediation," Owner decision: *"Jurisdiction: Queensland, Australia (not New Zealand)."* This is
a binding decision from the AE Project Owner, not an engineering judgment call.

## 1. What was wrong, and what has changed

The original 12-phase Operational Readiness Gate (PR #27) was run against an instruction that
described Agent Engine 2.0 as a New Zealand real-estate platform. Every phase of that gate that
touched jurisdiction — the main gate report (§0), the Controlled Pilot Plan (§A.2), and the
Phase 6 (financial/billing) and Phase 7 (privacy/legal) evidence documents — independently found
the same thing: the codebase itself is, and always has been, built for the **Australian** market
(AU GST at 10%, AUD currency, an AU Direct-Debit-Request-shaped mandate flow, AUSTRAC-style
AML/CTF terminology, NSW-shaped test fixtures). No New Zealand-specific legal, tax, or regulatory
content exists, or ever existed, anywhere in this repository.

That gate correctly refused to guess which was right, and listed it as blocker **B3**, requiring
an explicit AE Project Owner decision.

**That decision has now been made: Queensland, Australia.** This document is the record of that
decision and of the resulting fact-check against the codebase.

## 2. What this correction did and did not require

**No code change was required.** Every AU-shaped default the original gate found (10% GST, AUD
currency, AU Direct-Debit-Request mandate shape, AUSTRAC AML/CTF terminology) is the *correct*
default for Queensland, Australia. The codebase was never actually built for New Zealand and
required no adaptation to become correct for the confirmed jurisdiction — the original gate
instruction's premise was simply wrong, and the codebase's own defaults were right all along.

**What this correction did require:**

1. Correcting every gate document that stated or implied a New Zealand pilot, an unresolved
   jurisdiction mismatch, or GST being "wrong by default," so that a reader of the gate's own
   documentation record is not misled about the platform's actual, confirmed target market. The
   following documents were corrected (each retains its original evidence/citations — only the
   surrounding jurisdiction framing changed, and each correction is clearly marked as an update
   rather than silently rewriting history):
   - `docs/OPERATIONAL_READINESS_GATE_REPORT.md` (§0, blocker register B3, ownership matrix,
     §12, §14)
   - `docs/CONTROLLED_PILOT_PLAN.md` (§A.2, §B.2, closing "what must happen" section)
   - `docs/INCIDENT_RESPONSE_RUNBOOK.md` (scope paragraph)
   - `docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md` (§0, §3, §4, Recommendation §3)
   - `docs/gate-evidence/PHASE7_PRIVACY_AND_LEGAL_INVENTORY.md` (jurisdiction note, §8, §13,
     closing summary)
2. Ensuring no gate document, going forward, claims or implies multi-jurisdiction operation or
   an NZ launch. Every corrected document above now states plainly: Queensland, Australia only,
   synthetic/test data only, no automated financial collection, no trust money.
3. Directing the Phase 7 legal-document pack (`docs/legal/*.md`) to be written for Queensland,
   Australia specifically — Australian Privacy Principles (Privacy Act 1988 (Cth)), the
   Notifiable Data Breaches scheme, and AUSTRAC/AML-CTF Act 2006 (Cth) terminology, not New
   Zealand equivalents. See `docs/legal/LEGAL_APPROVAL_REGISTER.md`.
4. Confirming GST/currency/mandate findings against the now-confirmed jurisdiction (this
   document, §3 below) rather than leaving that re-check as an open item.

## 3. GST/currency/mandate re-check against the confirmed jurisdiction

Per the original gate's own required next step ("whichever answer is given, the GST/currency/
mandate-shape findings ... must be re-checked against it"):

| Finding | Original framing | Re-checked against Queensland, Australia |
|---|---|---|
| GST rate hardcoded at 10% (`pcFeeCalculations.ts`, `transactions.ts`, `commissionAgreements.gstRateBps` default) | "Wrong by a third if this is genuinely for NZ agents" (NZ GST is 15%) | **Correct.** 10% is the current Australian GST rate. No change needed. |
| Currency hardcoded `"AUD"` at every money-handling call site | "Wrong currency if genuinely NZ" (NZD expected) | **Correct.** AUD is the correct currency for an Australian pilot. No change needed. |
| Mandate flow modelled on AU Direct-Debit-Request shape | "Not a NZ direct-debit or Automatic Payment scheme" | **Correct.** The AU DDR shape is the right one for Queensland, Australia. No change needed. |
| AML/CTF terminology is AUSTRAC-shaped | "No NZ AML/CFT Act-specific concepts appear" | **Correct.** AUSTRAC is the right regulator/terminology for Australia. No NZ-specific concepts are needed. |

**Conclusion: every item the original gate flagged as a potential jurisdiction-driven defect is,
in fact, correct as built.** Nothing found in this re-check requires a code change.

## 4. Tracked future item: configurable GST rate

**This is the one genuine, non-blocking gap the jurisdiction correction surfaced, and it is
tracked here per the Owner's explicit instruction to "track [a] future configurable-GST item."**

The Pit Crew success-fee GST calculation (`apps/api/src/lib/financial/pcFeeCalculations.ts:14-19`)
hardcodes `GST_RATE_BPS = 1000` (10%) with a code comment stating this was a deliberate choice
not to add a configurable field. Separately, `financialSettings.defaultGstRateBps`
(`packages/db/src/schema/financial.ts:874-885`) exists in the schema but is not read by
`pcFeeCalculations.ts` at all.

This is **not a defect for the current, confirmed-single-jurisdiction (Queensland, Australia)
pilot** — 10% is the correct rate today, and nothing in this pilot's scope requires per-brokerage
or per-jurisdiction GST variation. It is tracked as a future item because:

- If the Australian GST rate itself ever changes, every Pit Crew fee calculation would need a
  code change (not a configuration change) to reflect the new rate.
- If this platform is ever extended to a second jurisdiction with a different GST/VAT rate (or
  no GST/VAT at all), the same code change would be required, and nothing in the current schema
  supports per-brokerage variation for this specific calculation (unlike
  `commissionAgreements.gstRateBps`, which is already a real, stored, per-agreement field).

**Recommended future fix (not performed as part of this bounded correction, since it is
out of scope for a single-jurisdiction pilot and the gate's remediation rules prohibit
speculative feature work):** wire `pcFeeCalculations.ts` to read
`financialSettings.defaultGstRateBps` (falling back to the current 1000 bps constant when unset,
so today's behavior is unchanged), or add a dedicated `gstRateBps` column to
`pcFeeAuthorities` mirroring the existing `commissionAgreements.gstRateBps` pattern. Either
approach closes the gap with a small, well-scoped, low-risk change whenever it becomes relevant —
there is no urgency to do so while this pilot remains Queensland, Australia only.

This item is also recorded in the risk register of `docs/OPERATIONAL_READINESS_GATE_REPORT.md`
(§6) and in `docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md` §4, so it is visible from
both the top-level gate report and the detailed financial audit.

## 5. Explicit non-claims

Consistent with the Owner's binding constraints for this remediation pass:

- This document does not claim, and no corrected document claims, that this platform operates in
  New Zealand, operates in more than one jurisdiction, or is ready for a jurisdiction other than
  Queensland, Australia.
- This document does not certify any of the Phase 7 legal drafts as legally sufficient — formal
  legal approval remains outstanding for all of them (`docs/legal/LEGAL_APPROVAL_REGISTER.md`).
- This document does not authorise live billing, real AML/e-signature/payment/property-data
  provider use, or public deployment — those remain governed by the Owner's other explicit
  constraints for this remediation pass.
