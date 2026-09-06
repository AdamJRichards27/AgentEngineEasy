# Phase 7 — Privacy, Compliance and Legal Readiness Inventory

**Scope:** Controlled-pilot operational readiness gate (5–10 real invited agents, real transaction workflows).
**Repo audited:** AgentEngineEasy / "Agent Engine 2.0", mirrored read-only at `/home/claude/work/AgentEngineEasy` (no `.git`; plain file mirror).
**Method:** Full-repository search (`docs/`, `README.md`, `ARCHITECTURE.md`, `apps/web/src`, `apps/api/src`, `packages/*`, built bundles in `apps/web/dist` and `apps/api/dist`). The 71 MB `apps/api/storage/packages/**` tree was identified as auto-generated runtime/test output (per-transaction placeholder documents), not source or policy content, and was excluded from the search after being sampled and confirmed as such.

**CURRENT GATE STATUS: REMEDIATION REQUIRED. B2: BLOCKED — HUMAN OR EXTERNAL DECISION REQUIRED.**
All 13 legal documents in `docs/legal/` remain draft and unapproved, with approval authority
unassigned. Their draft markers remain authoritative. Production activation is blocked; the
existence of a draft, a version string, or acceptance plumbing is not legal approval.

**Jurisdiction note — RESOLVED: Queensland, Australia (Critical Blocker Remediation, Phase 6).**
This section originally flagged a factual discrepancy: the task brief that produced this
inventory described the platform as "an NZ real-estate transaction-management platform," while
the repository's own `README.md` states it is "a simplified, property-led real estate
transaction platform for **Australian** real estate agents," and the codebase throughout uses
AU-specific regulatory concepts and constants (AU GST at 10%, AU Direct-Debit-Request-shaped
mandate flow, NSW test addresses, "AU real estate document content" in code comments, AUD
currency literals) with no New Zealand-specific legal or regulatory references found anywhere
(see §8 below). **The AE Project Owner has since confirmed the pilot's jurisdiction is
Queensland, Australia** — the codebase matches the confirmed jurisdiction, not the original
brief. Every legal-document gap identified below (§1–§14) should be read, and every document
drafted in response to it, as targeting Queensland/Australian law and terminology (see the
Phase 7 legal-document pack in `docs/legal/`, each file marked DRAFT — LEGAL REVIEW REQUIRED),
not New Zealand's.

---

## 1. Platform terms of service

**NOT FOUND anywhere in this repository** at the time of this audit.

- No file named or containing a platform Terms of Service existed in `docs/`, `apps/web/src`, or `apps/api/src`.
- The sign-in flow (`apps/web/src/pages/Login.tsx`) was, at the time of this audit, a passwordless "dev-login" prototype screen (find-or-create by name/email/brokerage) with no link, checkbox, or reference to any Terms of Service.
- The full frontend route table (`apps/web/src/App.tsx`, 13 destinations) contained no `/terms`, `/legal`, or equivalent route.
- A text-string search of the built frontend bundle (`apps/web/dist/assets/*.js`) for `"Terms of Service"` / `"Terms and Conditions"` returned no matches.
- The only occurrences of the phrase "terms and conditions" anywhere in the tree were inside auto-generated, per-transaction placeholder **agency agreement** documents (e.g. `apps/api/src/lib/documentTemplates.ts:65`, and their rendered output under `apps/api/storage/packages/*/documents/*.txt`), which is real-estate agency-agreement boilerplate for a property sale, not a platform ToS.

**Status update (Critical Blocker Remediation, Phase 7):** a draft `docs/legal/PILOT_TERMS_OF_USE.md` now exists, marked DRAFT — LEGAL REVIEW REQUIRED, written for Queensland/Australia. Formal legal approval is still outstanding — see `docs/legal/LEGAL_APPROVAL_REGISTER.md`. It is not yet linked into the sign-up flow beyond the required acceptance checkbox added under Phase 8 (see §3 below).

## 2. Privacy policy

**NOT FOUND anywhere in this repository** at the time of this audit.

- No file named or containing a Privacy Policy existed anywhere in the tree.
- No `/privacy` route, page, or component existed in `apps/web/src`.
- No API route served privacy-policy text (`apps/api/src/routes/*`).
- Built-bundle string search for `"Privacy Policy"` / `"privacy notice"` returned no matches in either `apps/web/dist` or `apps/api/dist`.
- `docs/DATA_CLASSIFICATION_AND_PROTECTION.md` documents internal data categories, sensitivity, and access control (engineering-audience) but is explicitly a security/engineering document, not a privacy policy directed at data subjects or platform users, and states no retention or disclosure-rights content.

**Status update (Critical Blocker Remediation, Phase 7):** a draft `docs/legal/PILOT_PRIVACY_POLICY.md` now exists, marked DRAFT — LEGAL REVIEW REQUIRED, written for Queensland/Australia (referencing the Australian Privacy Principles under the Privacy Act 1988 (Cth), not NZ's Privacy Act 2020). Formal legal approval is still outstanding.

## 3. Consent / data-use notices (e.g. shown at signup or first use)

**NOT FOUND** as an account-level/data-use consent notice at the time of this audit. A related but distinct mechanism existed for communications opt-in/opt-out.

- `apps/web/src/pages/Login.tsx` (the only sign-up/sign-in surface at the time) had no consent checkbox, no data-use disclosure, and no link to any notice.
- The party-capture UI where agents enter seller/buyer PII on a client's behalf (`apps/web/src/pages/PropertyWorkspace.tsx`) contained no consent, privacy, or "how this data will be used" text.
- What **did** exist, and is a different kind of consent: `apps/api/src/lib/communications/consent.ts` implements per-destination (email/SMS) **marketing opt-in / transactional opt-out** tracking for communications sent *to* sellers/buyers (a CAN-SPAM/anti-spam-style consent register, audited via `logAudit` and the `COMMUNICATION_CONSENT_UPDATED` event). This governs whether a message may be sent, not whether the platform may process the recipient's data, and was not surfaced as a notice to the agent/platform user at signup.
- `apps/api/src/lib/documentTemplates.ts` generates a per-transaction "CLIENT IDENTIFICATION & AML CONSENT" placeholder document (`amlConsentTemplate()`, lines 69–80) for the seller to sign in connection with a specific sale's AML/CTF identity verification — this is a transaction document artifact, explicitly marked `[Full consent text to be inserted — this is a structural placeholder only.]`, not a platform-level data-use consent notice.

**Status update (Critical Blocker Remediation, Phase 8):** account creation now requires
affirmative, recorded acceptance of both the current Terms of Use and Privacy Policy versions
(`POST /invitations/:token/accept`'s `acceptedTerms`/`acceptedPrivacyPolicy` fields, stored with
version + timestamp in the new `consentRecords` table) — this closes the account-level consent
gap for any new pilot account created going forward, while the documents themselves remain drafts
pending legal approval (§1–2 above).

## 4. Pilot-participation-specific terms

**NOT FOUND anywhere in this repository** at the time of this audit.

- A case-insensitive search for the word "pilot" across all source, docs, and markdown files (excluding false-positive matches on "Pit Crew"/"autopilot") returned zero results.
- No document, route, page, or comment referenced a pilot program, pilot participant, or pilot-specific terms distinct from general platform terms — and, per §1, no general platform terms existed either.

**Status update (Critical Blocker Remediation, Phase 7):** a draft `docs/legal/PILOT_PARTICIPATION_AGREEMENT.md` now exists, marked DRAFT — LEGAL REVIEW REQUIRED, written for Queensland/Australia. Formal legal approval is still outstanding.

## 5. PC (Pit Crew) service terms

**NOT FOUND anywhere in this repository** at the time of this audit.

- Searched `apps/web/src/pages/PitCrewCommandCentre.tsx`, `apps/web/src/lib/pitCrew.ts`, `apps/api/src/lib/pitCrew/*.ts`, and `apps/api/src/routes/pitCrew.ts` for terms/agreement/consent/policy language.
- The only hit was a code comment in `apps/api/src/lib/pitCrew/types.ts:12` referencing "appraisal agreement" as an unrelated exception category name — not Pit Crew service terms.
- Pit Crew is implemented purely as an internal delegated-operational **role** (task assignment/queries; see `apps/api/src/lib/pitCrew/assignment.ts`, `queries.ts`) with no associated service agreement, fee-disclosure document, or terms of engagement found anywhere.

**Status update (Critical Blocker Remediation, Phase 7):** a draft `docs/legal/PIT_CREW_SERVICE_TERMS.md` now exists, marked DRAFT — LEGAL REVIEW REQUIRED, written for Queensland/Australia. Formal legal approval is still outstanding.

## 6. Direct-debit authority / mandate document or in-app flow text

**NOT FOUND as an in-app document or user-facing flow.** The architecture explicitly delegates mandate origination outside the application — this remains true and is unaffected by the jurisdiction correction, since the mandate shape (AU Direct-Debit-Request) is confirmed correct for Queensland, Australia.

- `packages/integrations/mandate-payments/src/index.ts` (header comment, lines 1–24) states this is a "provider-neutral debit-mandate payment interface... modelling... an AU Direct-Debit-Request shape" and explicitly: *"the mandate itself (mandateProviderRef) is captured by an external, already-authorised process before anything here is called"* — i.e., by design, no direct-debit authority text, consent flow, or mandate-capture UI exists inside this codebase at all; it assumes that already happened via an outside (unbuilt/unspecified) channel.
- `apps/api/src/lib/financial/pcFeeAuthorities.ts` (header comment, lines 8–15) reinforces this: *"the agent's general-account debit mandate is authorised through an external, already-verified process, and THIS call merely records the resulting provider-issued reference — it never captures raw bank credentials and never originates a mandate itself."*
- No real bank-debit vendor is procured or wired in; only `SandboxMandatePaymentProvider` (in-memory sandbox) exists (`packages/integrations/mandate-payments/src/index.ts`).
- No UI component, form, or route was found presenting direct-debit authority language to an agent or brokerage for signature/acceptance.

**Status:** no automated direct-debit/mandate transaction is authorised for this pilot regardless
(Critical Blocker Remediation Owner decision: free or manually-invoiced only) — this gap is
therefore not a pilot blocker, but should be closed before any future live-billing phase.

## 7. Data-processing arrangements (sub-processors, AI model providers, storage providers)

**NOT FOUND as any document** (DPA, sub-processor list, or data-sharing disclosure) at the time of this audit. Named third-party providers exist only as environment-variable integration points in code, with no accompanying data-processing agreement or public disclosure of them as sub-processors.

- `.env.example` names/references the following third-party services as pluggable providers (most default to `mock`, i.e. not actually called in the current default configuration): Clerk (auth, `CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` — since superseded by the in-house invitation-based authentication built under Phase 4), Google Places (`GOOGLE_PLACES_API_KEY`, `PROPERTY_DATA_PROVIDER`), an unnamed AML vendor (`AML_PROVIDER=http`, vendor TBD), an unnamed e-sign vendor (`ESIGN_PROVIDER=http`, vendor TBD), Stripe (`PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`), and Anthropic (`AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_MODEL=claude-sonnet-4-5`).
- `ARCHITECTURE.md` Phase 9 confirms `AnthropicAiProvider` "calls the Anthropic Messages API directly via fetch" when enabled — i.e., real customer/party-context data can be sent to a real external AI model provider if this env var is set, with no corresponding data-processing arrangement, model-training opt-out statement, or sub-processor disclosure found anywhere.
- No file anywhere describes retention, processing purpose, cross-border transfer, or contractual terms with any of these providers.

**Status update (Critical Blocker Remediation, Phase 7):** a draft `docs/legal/SUBPROCESSOR_AND_THIRD_PARTY_DISCLOSURE.md` now exists, marked DRAFT — LEGAL REVIEW REQUIRED, listing each of the above providers, their test/sandbox-mode status for this pilot, and Queensland/Australia-appropriate cross-border-transfer language. Formal legal approval is still outstanding. Per the Owner's explicit instruction, only test/sandbox modes are authorised for this pilot — no real AML/e-signature/payment/property-data vendor call is permitted.

## 8. AML responsibility statement (platform vs. agent/brokerage)

**NOT FOUND as a stated responsibility document or notice** at the time of this audit. Substantial AML/CTF *workflow* exists, but no statement addressed to users about who bears legal AML compliance responsibility.

- `apps/api/src/lib/aml.ts`, `apps/api/src/lib/exceptions/rules/amlCtf.ts`, `packages/db/src/schema` (`aml.ts`) implement AML verification status tracking, exceptions, and a Brokerage-Administrator-only exception-resolution gate — but this is operational tooling, not a statement of legal responsibility.
- `apps/api/src/lib/documentTemplates.ts`'s AML-consent template is a per-sale document placeholder, not a responsibility statement.
- No text anywhere states, e.g., "the agent/brokerage remains the AML/CTF reporting entity" or "the platform does not perform AML compliance on your behalf" (or the converse).
- **Jurisdiction note (resolved):** the codebase's AML/CTF terminology, GST rate, and mandate structure are AUSTRAC/AU-shaped — this is the correct regime for the confirmed Queensland, Australia pilot. No NZ AML/CFT Act-specific concepts are needed and none should be introduced.

**Status update (Critical Blocker Remediation, Phase 7):** a draft `docs/legal/AML_CTF_RESPONSIBILITY_STATEMENT.md` now exists, marked DRAFT — LEGAL REVIEW REQUIRED, referencing AUSTRAC and the AML/CTF Act 2006 (Cth) as the applicable Australian regime, stating the agent/brokerage remains the reporting entity and the platform provides workflow tooling only. Formal legal approval is still outstanding.

## 9. AI-use disclosure

**PARTIALLY FOUND** at the time of this audit — a genuine, contextual in-product disclosure exists at the point of use; no dedicated/standalone AI-use policy or first-use disclosure was found.

- `apps/web/src/components/AskAgentEngine.tsx` (the only AI-facing UI surface, mounted on Home and Property Workspace) renders, every time the widget is shown:
  > `"Read-only. Copilot can only describe information already on this record - it cannot send anything or change anything."` (line 67)
  and every AI answer is labelled with its kind (Fact / Inference / Suggestion / Unknown, lines 29–34, 91) plus an optional `disclaimer` field surfaced to the user (line 93) — e.g. used when a live-provider outage caused silent fallback to the mock provider (`ARCHITECTURE.md` Phase 9: "every fallback is flagged back to the caller and surfaced to the end user as a disclaimer on the response").
- This is a real, working in-context AI disclosure, but it is scoped to the one Copilot widget. There is no standalone "About our use of AI" page, no AI disclosure at signup/first use, and no disclosure covering the broader AI Governance architecture (`apps/api/src/lib/ai/{governance,policyEngine,executionGateway,authority}.ts`) that exists in code for future AI-action features.

**Status update (Critical Blocker Remediation, Phase 7):** a draft `docs/legal/AI_USE_DISCLOSURE.md` now exists, marked DRAFT — LEGAL REVIEW REQUIRED, covering the platform-wide AI use and the human-approval-for-AI-actions principle. Formal legal approval is still outstanding.

## 10. Support / complaint process (documented, not just an email address)

**NOT FOUND anywhere in this repository** at the time of this audit — neither a documented process nor an email address.

- Searched for "support", "help", "contact us", "complaint", "dispute" (customer-facing) across `apps/web/src` and `docs/`. The only hits were: (a) `apps/web/src/pages/Settings.tsx:30` — the string `"Contact us"` used as a fallback label for an unset billing amount, not a support channel; (b) internal "dispute"/"escalation" terminology in the **Exception & Risk Engine** (`packages/db/src/schema/exceptions.ts`, `apps/api/src/lib/exceptions/*`) and **payment-dispute** webhook handling (`apps/api/src/lib/financial/paymentWebhooks.ts`), both of which are system-detected operational/financial risk flags routed to Brokerage Administrators — not a customer-to-vendor complaint or support-ticket process.
- No support email address, help-center link, SLA, or complaint-escalation path to the platform operator was found anywhere in the app UI, API, or docs.

**Status update (Critical Blocker Remediation, Phase 7):** a draft `docs/legal/COMPLAINTS_HANDLING_PROCESS.md` now exists, marked DRAFT — LEGAL REVIEW REQUIRED. It complements, and does not duplicate, the engineering-facing `docs/PILOT_SUPPORT_AND_ESCALATION.md`. Formal legal approval is still outstanding.

## 11. Data export / deletion process

**NOT FOUND — both as a documented process and as code/API endpoints** at the time of this audit.

- **Documented process:** no file anywhere described a data-export or data-deletion process for platform users or the parties (sellers/buyers) whose PII agents capture.
- **Code/API endpoints (checked separately, as instructed):**
  - Full route inventory of `apps/api/src/routes/*.ts` showed only two `DELETE` endpoints in the entire API: `paymentsRouter.delete("/payment-methods/:id", ...)` (`apps/api/src/routes/payments.ts:84`, a soft-deactivate of a stored payment method) and `partiesRouter.delete("/link/:linkId", ...)` (`apps/api/src/routes/parties.ts:157`, removes a property↔party link row, not the party's underlying PII record).
  - No `DELETE /users/:id`, no account-deletion endpoint, and no bulk personal-data-export endpoint existed anywhere. `apps/api/src/routes/auth.ts` (full file reviewed) had only `/known-users`, `/dev-login`, `/me`, and `/logout` — no deletion or export route.
  - The only "export" functionality in the codebase was `exportRejectedRecordsCsv` (`apps/api/src/lib/import/*`, `apps/api/src/routes/import.ts:263`), which exports rows that failed a CSV/XLSX bulk-import job for the importing agent's own correction — not a personal-data subject-access export.
  - No code implementing an "right to access"/"right to erasure" flow was found.

**Status update (Critical Blocker Remediation, Phase 8):** a real, authenticated request-and-review flow now exists — `POST /privacy/requests` (a signed-in user requests export or deletion of their own data), `GET /privacy/requests/mine`, `GET /admin/privacy-requests`, `POST /admin/privacy-requests/:id/resolve`. This flow only ever creates and tracks a request; it never performs an automated export or deletion itself, per the Owner's explicit instruction that regulated/AML records must never be auto-deleted — an admin reviews and fulfils each request manually. A draft `docs/legal/DATA_ACCESS_CORRECTION_DELETION_PROCESS.md` documents the participant-facing version of this process, marked DRAFT — LEGAL REVIEW REQUIRED. Formal legal approval is still outstanding.

## 12. Security-incident response process

**FOUND** — a substantial, concrete engineering-facing incident-response document exists.

- `docs/SECURITY_INCIDENT_RUNBOOKS.md` (353 lines) documents 12 named incident types (cross-tenant data exposure, compromised session secret, leaked API key, session token compromise, CORS misconfiguration, credential-stuffing, webhook signature-verification bypass, dependency vulnerability, database outage, malicious file-upload abuse, dev-login surface exposure, audit-log tampering), each with Detection / Immediate action / Containment / Recovery steps grounded in real controls in this codebase, plus a documented, actually-executed (not merely planned) backup/restore drill against a local test database.
- This is a genuine, usable engineering incident-response runbook. It is explicitly scoped to security/technical incidents and explicitly does **not** set an external disclosure policy (see §13).

## 13. Breach-notification process

**NOT FOUND as a policy** at the time of this audit. The one document that comes closest explicitly disclaimed setting this policy.

- `docs/SECURITY_INCIDENT_RUNBOOKS.md`, incident #1 ("Suspected cross-tenant data exposure"), states under **Escalation**: *"Affected Brokerage Contact(s) notified per the organisation's disclosure policy (**this document does not set that policy — it's a business decision, not an engineering one**)."* (lines 38–40, emphasis added.) This is the runbook itself stating that no breach/disclosure-notification policy exists in this repository.
- No other file specified notification timelines, regulator-notification obligations, or a template/process for notifying affected agents, brokerages, or the sellers/buyers whose PII is held.

**Status update (Critical Blocker Remediation, Phase 7):** a draft
`docs/legal/INCIDENT_RESPONSE_AND_BREACH_NOTIFICATION_SUMMARY.md` now exists, marked DRAFT —
LEGAL REVIEW REQUIRED, referencing the **Notifiable Data Breaches (NDB) scheme under the Privacy
Act 1988 (Cth)** as the applicable Australian regime for the confirmed Queensland, Australia
pilot (superseding the originally-considered NZ Privacy Act 2020 NotifiableHarm regime, which
does not apply). Formal legal approval is still outstanding.

## 14. Record-retention schedule

**NOT FOUND** at the time of this audit — no retention schedule existed for the platform's own held data. A related but distinct in-app *reminder feature* exists for agents' own external regulatory recordkeeping obligations.

- No document anywhere specified how long Agent Engine itself retains PII, audit logs, session data, documents, or financial/ledger records after a property closes, an account is deactivated, or a pilot ends.
- `docs/DATA_CLASSIFICATION_AND_PROTECTION.md` (data classification/sensitivity table) contained no retention-period column or retention statement.
- What did exist, and should not be conflated with a platform retention schedule: an automation-engine task template, `RECORD_RETENTION_CLOSURE_CHECK` (`apps/api/src/lib/automation/types.ts:130`, `apps/api/src/lib/automation/templates.ts:626–629`), which — when a transaction settles — creates a task for the *agent* reading: *"Confirm all required records for this transaction are retained ahead of closure."* This is a checklist nudge about the agent/brokerage's own external real-estate recordkeeping obligation; it does not define, or reference, any retention period or deletion schedule for data the platform itself stores.
- `docs/SECURITY_INCIDENT_RUNBOOKS.md`'s backup/recovery section (lines 344–349) explicitly flagged this as unresolved: *"[This drill] does not establish... retention window, storage location, encryption at rest for the dump file itself... those require... real infrastructure decisions... out of this step's reach and are not claimed to be settled by this drill."*

**Status update (Critical Blocker Remediation, Phase 7):** a draft `docs/legal/DATA_RETENTION_SCHEDULE.md` now exists, marked DRAFT — LEGAL REVIEW REQUIRED, written for Queensland/Australia recordkeeping norms and explicitly excluding any automatic deletion of regulated/AML records. Formal legal approval is still outstanding.

---

## Concerning implied claims found in product copy

**None found.** The audited user-facing text (React components under `apps/web/src`, rendered UI strings, and API response strings) does not claim or imply that the platform holds/operates a trust account, performs a statutory trust audit, replaces a lawyer/conveyancer's legal obligations, guarantees AI output accuracy, or autonomously performs a regulated action without human approval. Specifically:

- **Trust account / holding funds.** No user-facing string uses "trust account," "held by Agent Engine," "AE trust balance," or similar. The one relevant rendered string, `apps/web/src/components/FinancialSummarySection.tsx:235`, reads `` ` · held by ${deposit.externalHolderName}` `` — attributing custody to an externally-named holder (e.g. a solicitor's trust account), not to the platform. This matches the architecture's own internal custody-boundary rule (`packages/db/src/schema/financial.ts:59–62`, a code comment, not user-facing text): *"nothing in this file represents AE as holding, transferring, or disbursing money... never 'held'/'AE trust balance'/'disbursed by AE'."* `FUNDS_RECEIVED`/`AGENT_PAID` are documented (`ARCHITECTURE.md` Phase 7) as "manual bookkeeping confirmations, not real fund movement."
- **Statutory trust audit.** The "Audit Return Reminders" panel (`apps/web/src/pages/FinancialOperations.tsx:243`) only reminds a Brokerage Administrator of jurisdiction-specific audit-return due dates and lets them mark a return "submitted" — it does not claim the platform performs, prepares, or certifies the audit itself.
- **Replacing a lawyer/conveyancer.** Solicitors are only tracked as a party role/field for record-keeping (`apps/web/src/pages/PropertyWorkspace.tsx`); no copy claims the platform performs legal work. Generated transaction documents (`apps/api/src/lib/documentTemplates.ts`) carry an explicit disclaimer banner on every document: *"TEMPLATE PLACEHOLDER — NOT LEGAL ADVICE... Do not send this to a client for signature without review by a licensed conveyancer/lawyer."*
- **Guaranteeing AI output accuracy.** The one AI-facing UI surface (`AskAgentEngine.tsx`) explicitly labels every answer by kind (Fact/Inference/Suggestion/Unknown) and states it is "read-only" and "cannot send anything or change anything" — the opposite of an accuracy guarantee.
- **Autonomous regulated action without human approval.** No UI copy claims autonomous action. Consistent with this, the AI governance code itself (not user-facing, but checked for internal consistency with the "no autonomous regulated action" concern) enforces a "Golden Rule" that the AI can never hold more authority than the human actor (`apps/api/src/lib/ai/policyEngine.ts:10–14`), hard-blocks auto-execution of any RESTRICTED-risk action — defined to include AML/compliance determinations, financial ledger changes, commission calculation, and entitlement/permission changes (`apps/api/src/lib/ai/authority.ts:44–52`) — and, per `ARCHITECTURE.md` Phase 9, the only currently-implemented AI role (Copilot) is hard-capped at Level 0 read-only with "no code path in this phase creates, modifies or sends anything on a user's behalf."

---

## Closing summary: items completely missing from the repository (at the time of this audit)

Of the 14 items audited, the following were **completely missing** from this repository at the
time of this audit (no document, page, route, or in-app text found for them):

1. Platform terms of service
2. Privacy policy
3. Consent / data-use notice (account-level, shown at signup or first use)
4. Pilot-participation-specific terms
5. PC (Pit Crew) service terms
6. Direct-debit authority / mandate document or in-app flow text
7. Data-processing arrangements (sub-processors, AI model providers, storage providers)
8. AML responsibility statement (platform vs. agent/brokerage)
10. Support / complaint process (documented)
11. Data export / deletion process (both documented process and code/API endpoints)
13. Breach-notification process
14. Record-retention schedule (for the platform's own data)

The following two items have **partial** coverage and were not on the "completely missing" list above, but neither rose to a full, standalone policy/document at the time of this audit:

- **Item 9 (AI-use disclosure):** a real, working in-context disclosure exists on the one AI widget in the product (`AskAgentEngine.tsx`), but there is no standalone AI-use policy or first-use disclosure.
- **Item 12 (Security-incident response process):** a substantial, concrete engineering runbook exists (`docs/SECURITY_INCIDENT_RUNBOOKS.md`) — this item is FOUND, not missing.

**Status update (Critical Blocker Remediation, Phases 7–8):** items 1–8, 10, 11, 13, and 14 above
now each have either a full draft legal document (`docs/legal/*.md`, every one marked DRAFT —
LEGAL REVIEW REQUIRED and pending formal legal approval — see
`docs/legal/LEGAL_APPROVAL_REGISTER.md`) or a working in-app mechanism (items 3 and 11, per §3
and §11 above), written for the now-confirmed Queensland, Australia jurisdiction. This report
makes no determination as to whether any drafted document is legally sufficient — that
determination remains with the AE Project Owner and/or external legal counsel, per the original
scope of this inventory.

---

## Production legal activation and durable-record blockers

### SHA-256-bound legal artifact control

The production legal-document mechanism is an **engineering control, not an approval mechanism**.
At production startup and when serving the active Terms of Use/Privacy Policy for acceptance, the
service requires `LEGAL_DOCUMENTS_APPROVED=true`, configured artifact paths, and configured
SHA-256 digests. It reads the exact configured bytes, recomputes each digest, rejects unreadable
files, digest mismatch, and any artifact retaining `DRAFT — LEGAL REVIEW REQUIRED`, then records
the digest as the acceptance version. This prevents accidental or implicit deployment of a draft
and makes the accepted bytes identifiable. It neither establishes legal sufficiency nor assigns,
records, or substitutes for legal approval. No approved paths or hashes are populated for this
draft pack.

### Pilot blockers requiring remediation or a human/external decision

The following gaps prevent production activation for the controlled pilot:

1. No durable object-storage adapter exists for generated/signed document bytes; the implemented
   provider is local disk and remains the default.
2. The local-disk default is development/test only and is not an authoritative or durable
   production record store.
3. Webhook signature verification alone does not prove durable byte ingestion, checksum
   verification, or artifact/version provenance for AML, payment, or communications callbacks.
4. There is no production fail-closed configuration proving durable database and document-storage
   topology before production startup.
5. Approval authority for every legal draft is unassigned; qualified legal review and a separate
   approval decision are outstanding.

The selected target topology is PostgreSQL as the authoritative operational record store and
separate durable S3/GCS-compatible object storage for generated/signed bytes; see
`docs/adr/0001-production-storage-topology.md`. Until these blockers are resolved with evidence,
the overall status remains **REMEDIATION REQUIRED** and **B2 remains BLOCKED — HUMAN OR EXTERNAL
DECISION REQUIRED**.
