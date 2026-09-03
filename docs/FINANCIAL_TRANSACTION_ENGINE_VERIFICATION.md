# Agent Engine 2.0 — Financial Transaction Engine Verification

**Step 2 — Integration Readiness Program**

Repository: `AdamJRichards27/AgentEngineEasy` · Verification date: 2 September 2026 · Verifier: Claude (this session) · Verification type: primarily read-only verification, plus tightly-scoped remediation of exactly two named issues (COHERENCE-001, RISK-001) and defects found directly while verifying them. No unrelated financial features were added. No real bank, payment provider, or trust account was connected. No real debit, payment, invoice, email, or SMS was executed. No protected branch was merged.

---

## 1. Scope and method

This report continues directly from `docs/CONSOLIDATED_BUILD_STATE_AND_MERGE_AUDIT.md` ("Step 1"), which found two issues requiring incorporation into this step: **COHERENCE-001** (a live, reproduced contradiction between the legacy per-transaction commission figure and the new Financial Engine's "no commission agreement" state) and **RISK-001** (the CRITICAL-severity C13 risk-exception test not exercising its own assertion). The governing brief for this step authorised exactly four categories of change: (1) resolve COHERENCE-001, (2) resolve RISK-001, (3) correct defects directly discovered while verifying the Financial Transaction Engine, (4) complete missing tests/wiring/documentation/safety controls required by this verification. Nothing outside those four categories was implemented.

Every claim below carries the same evidence label Step 1 used:

- **[LIVE]** — this session read the actual file/commit/branch content directly from the repository via the GitHub MCP tool (`get_file_contents`, `pull_request_read`, `search_code`), or independently re-derived a conclusion from that content.
- **[DOC]** — taken from a prior report's own text, not independently re-verified this session, and always marked as such.
- **[GAP]** — explicitly not verified this session; stated as an open item rather than assumed true.

### 1.1 Environment facts re-established at the start of this step

This session has no local git checkout of the repository (`git clone`/`git pull` both 401 in this sandbox), no `gh` CLI, no `DATABASE_URL`, and no running instance of the application. All repository reads and writes went through the GitHub MCP tool (`get_file_contents`, `push_files`, `create_branch`, `create_pull_request`, `pull_request_read`, `search_code`), which talks to the real repository directly. This is a materially tighter environment than Step 1's, which at least had a local worktree it could run `pnpm test`/`typecheck`/`build` inside. **This session could not independently execute any test, build, typecheck, or migration.** Every automated-test claim below is qualified accordingly rather than presented as if it were run.

`mcp__GitHub_MCP__search_code` produced at least one confirmed false negative this session (a zero-result search for a CSS class, `btn-secondary`, that a direct file read confirmed does exist) and returned zero results for both `"RISK-001"` and `"C13"` as literal search strings even though both exist in `docs/CONSOLIDATED_BUILD_STATE_AND_MERGE_AUDIT.md`, which this session itself read successfully by path. GitHub's code-search index appears to lag recent pushes to non-default branches in this environment. Consequently, this verification relied on directory listings and direct `get_file_contents` reads to locate files, not on `search_code` as a source of "nothing exists" evidence.

### 1.2 Central verification question

> **Can AE reliably calculate, record, evidence and reconcile financial events without moving or claiming custody of funds?**

**Yes, on the evidence read this session.** The Financial Transaction Engine's only outbound payment mechanism (`apps/api/src/lib/financial/paymentOutbox.ts`) calls a single injected `MandatePaymentProvider` (`apps/api/src/lib/financial/provider.ts` → `@aee/integration-mandate-payments`). That package's `createMandatePaymentProvider()` (`packages/integrations/mandate-payments/src/index.ts`) resolves an env var (`MANDATE_PAYMENT_PROVIDER`) and, for every value other than `"sandbox"` — including any real vendor name — logs a warning and **falls back to `SandboxMandatePaymentProvider`** rather than connecting to anything real. The sandbox provider's own header comment states this in full: *"No real bank-debit vendor is procured for this build... only the sandbox adapter ships."* `SandboxMandatePaymentProvider` holds all state in an in-process `Map`, never opens a network connection, and its `scheduleDebit` mints a `sandbox-debit-<uuid>` reference rather than calling out to anything. This matches the brief's own constraint ("Do not connect a real bank, payment provider or trust account") as an already-true architectural fact, not something this remediation needed to enforce — there is nothing in this codebase capable of moving real money today.

Every money-bearing table this session read (`commission_agreements`, `commission_calculations`, `pc_fee_calculations`, `financial_payment_requests`, `financial_deposits`, `financial_reconciliations`, `financial_ledger_events` — full CREATE TABLE statements in migration `0008_striped_reaper.sql`) stores integer cents (never floating point), carries a `brokerage_id` tenant scope, and is append/evidence-oriented: `financial_deposits` and `marketing_payment_records` only ever record a *reported* external amount and an *evidence reference* — nothing writes to a real trust account. `financial_ledger_events` is the evidence bus every state change publishes to, immutable by construction (no UPDATE/DELETE route exists over it in `routes/financial.ts` — it is read-only via `GET /financial/ledger-events`). Answering the brief's own question plainly: AE calculates (commission/PC-fee calculation snapshots with state machines), records (every write goes through a service function that also writes a ledger event), evidences (`evidenceRef`/`evidenceAmountCents` fields throughout, plus the sandbox provider modelling real-world settlement lag deterministically), and reconciles (`financial_reconciliations`, `financialDisputes`) — and at no point does any code path in this codebase call out to, or hold state for, a real bank, PSP, or trust account.

---

## 2. COHERENCE-001 — investigation and remediation

### 2.1 The reproduced contradiction (from Step 1, re-confirmed by source inspection this session)

Step 1 observed live, on the running app: a **Closed** transaction's pre-existing Transaction section showed a real commission figure (*"Commission: $20500.00 + $2050.00 GST"*), while the new Financial Summary section said *"No commission agreement recorded yet"* / *"No commission calculation recorded yet"* for the same property. This session re-confirmed the root cause directly against source rather than trusting Step 1's description: `finalizeCommissionForSettlement` (`apps/api/src/lib/financial/settlement.ts`) is an explicit no-op — *"Requires an APPROVED commissionAgreement to exist — if none does, this is a no-op"* — and no code path in this repository ever backfills a `commissionAgreements`/`commissionCalculations` row for a transaction that closed before the Financial Engine's tables existed in this workspace. The legacy `transactions` table (`packages/db/src/schema/transaction.ts`) only ever stored the two *output* totals of a commission calculation (`grossCommissionCents`, `gstCents`) — never the method, rate, tiers, referral fee, or brokerage/agent split that produced them.

### 2.2 Why the brief's "preferred solution" (a full backfill) is unsafe, and was rejected

`commissionCalculations.commissionAgreementId` is `NOT NULL` and `commissionAgreements.method` is `NOT NULL` (confirmed directly in migration `0008_striped_reaper.sql`'s CREATE TABLE statements). Materialising either row for a legacy transaction would require inventing a calculation method and rate that were never recorded anywhere in this schema — exactly what the brief's own rules forbid ("Do not fabricate commission agreements. Do not infer PC service or PC fee authority from historical commission data."). This is true for **every** legacy transaction without exception; there is no subset that could be safely upgraded to a real, method-attributed calculation. This reasoning, and the decision it leads to, is recorded in full in `apps/api/src/lib/financial/legacyReconciliation.ts`'s module header comment.

### 2.3 Remediation implemented — the brief's safe fallback

Because the full backfill is unsafe, this remediation implements the brief's explicit **safe fallback** (§7): display the legacy commission with a clear source label, state that no Financial Engine agreement exists, provide an authorised reconciliation action, and create a structured reconciliation-required item. It never writes to `commissionAgreements` or `commissionCalculations`.

**Files changed, all on branch `remediation/financial-verification-step2` (forked from `feat/financial-transaction-engine` at head `53e9555a63546f9b30662a44294dcbf1d98f0b72`):**

| File | Change |
|---|---|
| `packages/db/src/schema/financial.ts` | Two additive string-literal enum values: `LEGACY_TRANSACTION_COMMISSION` (in `FINANCIAL_RECORD_TYPES`) and `LEGACY_COMMISSION_FLAGGED_FOR_RECONCILIATION` (in `FINANCIAL_LEDGER_EVENT_TYPES`). Both are plain `text()` columns validated at the TypeScript level (no Postgres `CHECK`/enum constraint exists on either column — confirmed by reading migration `0008` in full), so this required **no new migration**. |
| `apps/api/src/lib/financial/legacyReconciliation.ts` (new) | The safe-fallback service: `getLegacyCommissionContext` (reads the legacy figures for a Settled/Closed transaction only — an in-progress transaction is deliberately excluded since it can still get a real agreement), `hasFinancialEngineAgreement`, `reconcileLegacyCommission` (idempotent SELECT-before-INSERT create of a `financialReconciliations` row, `UNRECONCILED`, preserving the original amounts exactly, never inventing a GST figure it doesn't have), `findTransactionsNeedingLegacyReconciliation` and `runLegacyCommissionReconciliationBackfill` (the Section 7 "preferred solution" *shape*, adapted to write only the safe-fallback content). |
| `apps/api/src/lib/financial/queries.ts` | `getPropertyFinancialSummary` now also returns `legacyCommission: LegacyCommissionSummary \| null`, populated **only** when the property has no Financial Engine `commissionAgreement` at all (an in-progress DRAFT/AWAITING_APPROVAL agreement is a normal, non-contradictory "being set up" state and is correctly excluded). |
| `apps/api/src/routes/financial.ts` | New route: `POST /financial/transactions/:transactionId/legacy-commission/reconcile` — Brokerage-Administrator-gated (`requireFinancialAdmin`, matching every other route in this file), re-derives `propertyId`/`brokerageId` from the transaction's own property row via `resolveTransactionScope` (never a client-supplied tenant id — the same convention as every other route in this file), calls `reconcileLegacyCommission`. |
| `apps/web/src/lib/financial.ts` | Mirrors the new types/enum value on the client (`LegacyCommissionSummary`, `legacyCommission` field, `flagLegacyCommissionForReconciliation` fetcher) — same hand-mirroring convention this file already uses for every other server type. |
| `apps/web/src/components/FinancialSummarySection.tsx` | The Commission Agreement and Commission Calculation subsections now branch on `legacyCommission` instead of falling straight to a bare "No commission agreement recorded yet." when one exists — rendering a new `LegacyCommissionCard` (a "Legacy · pre-Financial Engine" pill, the amount + GST if known, explanatory text, and a "Flag for Reconciliation" button that calls the new route, or "Already flagged" text once it has been). |
| `apps/api/src/lib/financial/__tests__/legacyReconciliation.test.ts` (new) | 14-scenario test suite — see §2.5. |
| `apps/api/src/scripts/reconcileLegacyCommissions.ts` (new) | Optional CLI wrapper around the backfill scan, for an operator who later wants to run the safe-fallback scan across every historical transaction in a brokerage in one pass. Not required for either COHERENCE-001 or RISK-001 — the per-transaction "Flag for Reconciliation" action already satisfies the remediation on its own. |

All 8 files were verified byte-for-byte on the remote branch by reading them back from GitHub after pushing (§6.2) — this matters because one push in this session's own working history briefly corrupted one file with placeholder content before being corrected two commits later (disclosed in full in §6.1).

### 2.4 A defect found and fixed directly while verifying COHERENCE-001

While tracing `reconcileLegacyCommission`'s callers, this session found that `getPropertyFinancialSummary` only ever surfaces `legacyCommission` (and therefore the UI's "Flag for Reconciliation" button) when the property has **no** Financial Engine `commissionAgreement` — but the new route is independently reachable regardless of that UI gate. Without a guard, calling the route directly on a transaction that already has a real `commissionAgreement` would create a redundant, confusing `LEGACY_TRANSACTION_COMMISSION` reconciliation record sitting alongside a real agreement — reintroducing a smaller version of the exact two-systems incoherence COHERENCE-001 is about. **Fix:** `reconcileLegacyCommission` now calls `hasFinancialEngineAgreement(transactionId)` first and returns `{ created: false, skippedReason: "A Financial Engine commission agreement already exists for this transaction; legacy reconciliation does not apply." }` if one exists. This is in-scope under the brief's rule #3 ("correct defects directly discovered while verifying the Financial Transaction Engine") and is covered by Section 8 scenario 4 in the test suite.

### 2.5 Section 8 coherence remediation test coverage (14 scenarios)

`apps/api/src/lib/financial/__tests__/legacyReconciliation.test.ts` covers all 14 required scenarios:

1. Historical closed transaction with legacy commission, no Financial Engine record → creates an `UNRECONCILED` row preserving the original amount exactly.
2. Historical transaction with no commission data → no-op, nothing created.
3. Historical transaction with ambiguous (missing) GST → preserves `gstCents: null` rather than fabricating a figure; notes text never mentions GST.
4. Transaction already containing a Financial Engine calculation → skips (the §2.4 defect fix), asserts zero rows created.
5 & 9. Run twice → second call returns the identical row id, asserts exactly one row exists in the DB however many times it's called.
6. Legacy record with a manual adjustment already applied → a rerun does not reset a `RECONCILED` record back to `UNRECONCILED` (corrections are additive, never destructive).
7. Multi-tenant isolation → a transaction is not readable as legacy-commission-eligible under a foreign `brokerageId`.
8. Dry run → reports a preview, asserts zero rows written.
10 & 11. Never fabricates a PC fee, invoice, or debit request → asserts zero `pcFeeCalculations`/`financialPaymentRequests` rows are created as a side effect.
12. UI shows one coherent explanation → out of scope for a `node:test` suite (a rendering concern); verified by source inspection of `FinancialSummarySection.tsx`'s `legacyCommission` branch instead (§2.3), and would be the subject of the manual vertical-slice walkthrough this environment cannot run (§5).
13. Reconciled source is visible in history → asserts a `LEGACY_COMMISSION_FLAGGED_FOR_RECONCILIATION` ledger event exists, traceable back to the reconciliation row's id.
14. Uncertain records are flagged for manual review, never auto-resolved → asserts the created record is `UNRECONCILED` with guidance notes, never auto-`RECONCILED`.

Plus a `runLegacyCommissionReconciliationBackfill` block covering dry-run-then-apply, correct exclusion of still-open transactions from the scan, and idempotent reruns.

**This suite was authored but could not be executed in this session** — see §5.

---

## 3. RISK-001 — investigation and resolution

### 3.1 Step 1's root cause, re-confirmed

Step 1 root-caused the failure precisely: `apps/api/src/lib/exceptions/__tests__/engine.test.ts`'s CRITICAL scenario (`C13_MULTIPLE_OFFERS_ACCEPTED_FOR_PROPERTY`) called a `createOffer()` test helper that hit the real `POST /api/offers/by-property/:id` route to create a second "Accepted" offer on a property that had already moved out of `Listed` — and `lib/offers.ts`'s own real safeguard correctly 400s that request (*"This property already has an accepted offer."*) before the test ever reaches its intended assertion. Step 1's recommended fix: change the test's second-offer creation to a direct `db.insert(offers)` that bypasses the route, matching what the test's own comment already claimed it did.

### 3.2 Finding: the fix already exists on the branch under verification

This session read `apps/api/src/lib/exceptions/__tests__/engine.test.ts` in full, directly from `feat/financial-transaction-engine` at head `53e9555a63546f9b30662a44294dcbf1d98f0b72` (the same content the remediation branch inherits unchanged). The CRITICAL scenario's second-offer creation reads:

```ts
const [secondOffer] = await db
  .insert(offers)
  .values({ propertyId, offerPriceCents: 81000000, status: "Accepted" })
  .returning();
```

This **is** the direct `db.insert(offers)` fixture Step 1 recommended — the route-based `createOffer()` helper that produced the 400 in Step 1's reproduction does not appear anywhere in this file. The test proceeds to run a scan, assert a `CRITICAL` C13 exception is created referencing both offer ids, assert that a manual "just mark it resolved" is rejected with `REQUIRES_AUTHORITATIVE_EVIDENCE` (§14's authoritative-evidence guard), correct the anomaly, and assert auto-resolution on the next sweep — the complete scenario Step 1 found unreachable.

**Conclusion: RISK-001 requires no further code change under this remediation.** The brief's own RISK-001 instruction ("repair the C13 test fixture only via a test-only DB fixture, not production code") has already been satisfied, on this exact branch, using exactly that technique — a direct DB insert, never a production-code change. **Why this differs from Step 1's finding:** Step 1's reproduction ran against a fresh worktree of `staging` (via `git worktree add --detach`), not against `feat/financial-transaction-engine` — and `staging` does not yet contain PR #17's branch content, so `staging`'s own copy of this test file is presumably still the pre-fix version Step 1 saw fail. This session had no way to build a `staging` worktree to independently re-confirm that (no local git checkout is available in this environment — see §1.1) — but the file content on `feat/financial-transaction-engine`, read directly, unambiguously already contains the fix. **This fix will land in `staging` automatically once PR #17 merges** — it does not require a separate remediation PR of its own. No commit was made to the remediation branch for RISK-001; §3.1–3.2 above constitute its full resolution record.

---

## 4. Financial boundary / non-custody language audit

Every financial service module read this session states its trust boundary explicitly in its own header comment, and every one traced back to source confirms the claim:

- `apps/api/src/lib/financial/legacyReconciliation.ts`: "This module never writes to `commissionAgreements` or `commissionCalculations`." Confirmed — `reconcileLegacyCommission` only ever inserts into `financialReconciliations` and `financialLedgerEvents`.
- `apps/api/src/lib/financial/settlement.ts`: "a repeated `SETTLEMENT_COMPLETED` for the same transaction must never create a second `PC_SUCCESS_FEE` payment request" — backed by both an application-level SELECT-before-INSERT/`onConflictDoNothing` idiom **and** a real DB-level unique index, `financial_payment_requests_transaction_kind_idx` on `(transaction_id, kind)` (confirmed directly in migration `0008`).
- `packages/integrations/mandate-payments/src/index.ts`: "Custody boundary... this package only ever talks to an external provider's REST/webhook surface — it never holds funds, never stores raw bank credentials." Confirmed — see §1.2's full analysis; no real provider is procurable through this code today, by construction, not by policy alone.
- `apps/api/src/routes/financial.ts`: every route requires `BROKERAGE_ADMIN_ROLES` (the same precedent `routes/exceptions.ts`/`routes/commandCentre.ts` already established, reused rather than duplicated), gated per-route rather than via a blanket `.use()` — deliberately, because `financialRouter` is mounted unprefixed at the API root and a blanket gate would incorrectly 401 `financialWebhooksRouter`'s own provider-callback route, which by design carries no session cookie.
- Section 33 sensitive-data protection: `redactPcFeeAuthority` is applied to every PC fee authority response this session read (create/get/list/activate/revoke) — the raw `mandateProviderRef` is never serialised; only a `hasMandate` boolean crosses the API boundary. `financialPaymentProviderEvents` (raw provider webhook payloads) is never exposed by any route in `financial.ts` — `financialLedgerEvents` is the evidence surface external readers get instead.
- No route or service function in this domain issues a real email, SMS, or invoice send — `financial_payment_requests.noticeSentAt`/`invoiceIssuedAt` are simple timestamp fields set by application code, with no outbound provider call attached to setting them (confirmed by reading `advancePaymentRequestToNoticeSent` in full — it only updates the row and records a ledger event).

No violation of the brief's "do not connect a real bank, payment provider or trust account" / "do not execute real debits, payments, invoices, emails or SMS" constraints was found or introduced by this remediation.

---

## 5. Automated test results

**This session could not execute `pnpm test`, `pnpm typecheck`, `pnpm build`, or any migration.** As stated in §1.1, this environment has no local git checkout, no `DATABASE_URL`, no `gh` CLI, and no running instance of the application — only the GitHub MCP tool's read/write API access to the repository. This is a hard environment limitation, not a result being omitted or approximated.

What **was** done in place of execution:

- The new 14-scenario test file (`legacyReconciliation.test.ts`) was authored to the exact conventions of its sibling files in the same directory (`agreements.test.ts`, `settlement.test.ts`) — same `node:test`/`node:assert/strict` harness, same real-database-plus-real-HTTP-server fixture pattern via `routes/__tests__/testSupport.ts`, same test-only direct-DB-write convention for constructing an otherwise-unreachable fixture state (mirroring the exact justification RISK-001's own C13 fixture uses). It was re-read in full from the pushed branch content to check for syntax and structural correctness by inspection (no compiler was run).
- `apps/api/package.json`'s `test` script glob was confirmed (before this file was authored) to include `src/lib/financial/__tests__/*.test.ts`, so the new file will be picked up by the existing test command without any script change.
- The two pre-existing test files this session read in full for reference (`agreements.test.ts`, `settlement.test.ts`) were not modified.
- RISK-001's C13 scenario (§3) was verified by direct source read to already use the correct test-only fixture technique — no execution was needed to establish that finding, only reading the actual test code.

**This is recorded as an explicit [GAP], not a pass.** The new test suite has never been run against a real database. It should be run — and, per its own header comment, fixed on first try if anything doesn't compile or pass — as the immediate next step once an environment with `DATABASE_URL` and a working test runner is available. Every prior PR in this program's history (per Step 1's own audit) ran its own suite in its authoring environment before merging; this remediation could not do the same, and says so plainly rather than presenting authored-but-unexecuted tests as a passing result.

---

## 6. Git history for this remediation

### 6.1 A disclosed mistake, corrected within this session

While assembling one of the `push_files` calls for this remediation, this session mistakenly pushed the literal string `"PLACEHOLDER"` as the entire content of `packages/db/src/schema/financial.ts` (commit `a93f1efa9713ea2de0e24877adecdd1226b88342`). This was caught on the very next action in this session, before any further work depended on the corrupted state, and corrected two commits later (`85e9c9c207f468078aef4782f88c267c0c063b87`) with the file's full, correct, 881-line content — the commit message explains the mistake and the fix in plain text. This is disclosed here in full rather than omitted, consistent with this program's own standard of reporting what actually happened rather than a cleaned-up narrative.

### 6.2 Post-push verification

After all 8 remediation files were pushed, every one of them was independently read back from the branch (`get_file_contents` at `refs/heads/remediation/financial-verification-step2`, resolved head `aad70cc86f7df331a262d581a7f7539ef710aabd`) and confirmed to contain full, correct, uncorrupted content — including the two files most at risk from the §6.1 mistake. No residual corruption exists at the branch's current head.

### 6.3 Commit sequence on `remediation/financial-verification-step2`

Branch created via `create_branch` off `feat/financial-transaction-engine` at exact head `53e9555a63546f9b30662a44294dcbf1d98f0b72`.

| Commit | Content |
|---|---|
| `a93f1efa9713ea2de0e24877adecdd1226b88342` | (Mistake — see §6.1) placeholder content on `packages/db/src/schema/financial.ts`. |
| `85e9c9c207f468078aef4782f88c267c0c063b87` | Correction: full, correct `packages/db/src/schema/financial.ts` + full `apps/api/src/lib/financial/legacyReconciliation.ts` (including the §2.4 guard). |
| `7e8b58aa42461c9cfd1c72f87e877ffa3eaa97cf` | `apps/api/src/lib/financial/queries.ts` + `apps/web/src/lib/financial.ts`. |
| `1728cfbc95c22eaf4a1f7355d2f9b90980c63278` | `apps/api/src/routes/financial.ts` + `apps/web/src/components/FinancialSummarySection.tsx`. |
| `aad70cc86f7df331a262d581a7f7539ef710aabd` | `apps/api/src/lib/financial/__tests__/legacyReconciliation.test.ts` + `apps/api/src/scripts/reconcileLegacyCommissions.ts`. Branch head at time of this report. |

This report itself is added in a further commit on the same branch.

---

## 7. Merge Safety Gate (§4) re-confirmation

Re-checked this session via `pull_request_read(method: "get")` on PR #17: `state: "open"`, `merged: false`, `head.sha: "53e9555a63546f9b30662a44294dcbf1d98f0b72"`, `base.ref: "staging"`, `base.sha: "ea3bc79166729ab0b77fe2732794f35cf616414e"` — identical to Step 1's own reading. `staging` has not moved. PR #17 remains a zero-conflict fast-forward candidate. **No protected branch was merged or pushed to directly by this remediation.** All remediation work landed on a new branch (`remediation/financial-verification-step2`) and this report will be delivered via a pull request against `feat/financial-transaction-engine` (not `staging`, not `main`), per the brief's explicit instruction to target the branch under verification rather than the protected branch it will eventually merge into.

---

## 8. Findings register

### P1 (from Step 1) — now remediated

**COHERENCE-001** — Resolved via the safe fallback (§2). Status: **REMEDIATED, UNTESTED-IN-THIS-SESSION** (code authored and pushed; automated tests authored but not executed — §5; manual UI walkthrough not possible — no running app in this environment).

### P2 (from Step 1) — found already resolved

**RISK-001** — Found, on direct source inspection, to already be fixed on `feat/financial-transaction-engine` using exactly the technique Step 1 recommended. Status: **NO CHANGE REQUIRED**; will land in `staging` automatically when PR #17 merges.

### New findings from this step

**P2 — FIN-001 (new).** `financial_reconciliations` has no DB-level unique index backing `reconcileLegacyCommission`'s idempotency check — only a plain, non-unique `financial_reconciliations_record_idx` on `(record_type, record_id)` (confirmed in migration `0008`). The application-level SELECT-before-INSERT is safe for this action's actual usage pattern (an admin-triggered, sequential, low-frequency click or a one-time backfill script run — never an at-least-once-delivery webhook), so this is not a P1: a genuine concurrent double-submit race is a low-probability, non-financially-dangerous outcome (at worst one duplicate `UNRECONCILED` row for a human to notice and merge, never a duplicate payment or agreement). **Recommendation:** a follow-up migration adding `CREATE UNIQUE INDEX ON financial_reconciliations (brokerage_id, record_type, record_id)` would close this gap outright; left as an open recommendation rather than implemented here, since it is not required to prove financial safety and the brief's instruction is not to expand scope beyond what's necessary.

**P3 — FIN-002 (new, documentation).** `apps/api/src/scripts/reconcileLegacyCommissions.ts` is a convenience CLI wrapper that was authored but, like the rest of this remediation, never executed. It is optional — the per-transaction "Flag for Reconciliation" UI action fully satisfies COHERENCE-001's remediation requirement on its own — and should be treated as unverified until run once against a real database.

**Carried forward from Step 1, unchanged this session (not in this remediation's scope):** AI-001 (mock AI provider only), DOC-001 (stale event-count comment), REPO-001 (two dead branches), PROC-001 (PR #10 identity unconfirmed), CI-001 (CI status unreadable from this session's GitHub MCP token — confirmed unreadable again this session, same `403` pattern).

---

## 9. Manual verification results

**Not performed.** This environment has no running instance of the application (no `DATABASE_URL`, no way to start the API/web servers, no browser). The manual vertical-slice walkthrough the brief calls for (Section 27) — in particular, visually confirming the `LegacyCommissionCard` renders correctly on a real closed legacy transaction and that "Flag for Reconciliation" actually clears the coherence gap end-to-end in a live UI — could not be attempted and is recorded as a [GAP], not assumed to pass because the code reads correctly. This is the same category of limitation Step 1 flagged for its own AI-001 finding, applied here to the COHERENCE-001 UI fix specifically.

---

## 10. Final decision

**PARTIALLY VERIFIED — REMEDIATION REQUIRED.**

Reasoning: both named issues have a concrete resolution with a clear evidence trail — COHERENCE-001 has real, reviewed code implementing the brief's own prescribed safe fallback, and RISK-001 turned out to require no code change at all, its fix already present on the branch under verification. The financial custody boundary was independently confirmed sound by tracing the actual payment-provider code path to its sandboxed, non-networked implementation. However, this verification could not execute a single automated test, could not run a migration, and could not perform any live/manual walkthrough — every piece of runtime evidence a full "READY TO MERGE" or "READY FOR CANONICAL DATA & SOURCE-OF-TRUTH GATE" label would require is instead authored-but-unverified. This is not a safety failure (nothing found here contradicts the non-custody design, and no unsafe backfill was performed), and it is not an environment access failure in the sense of being unable to read or write the repository at all (every read and write this session needed did succeed) — it is squarely "the remediation is real and reviewable, but its own tests have not yet been run." The next authorised task (§11) is exactly the step that would close this gap.

---

## 11. Exact next authorised task

Run `apps/api/src/lib/financial/__tests__/legacyReconciliation.test.ts` (and the full existing suite, to confirm no regression) in an environment with a working `DATABASE_URL` and `pnpm`/`tsx` available — fixing anything that does not compile or pass on first try, per that file's own header comment — then re-confirm RISK-001's C13 scenario still passes unmodified (§3), and only then open the PR from `remediation/financial-verification-step2` against `feat/financial-transaction-engine` with this report attached, without merging anything to `staging` or `main`.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01C6398UV8VKXaKSVDRpLsQh
