# Data Classification and Protection

Agent Engine 2.0, Step 2. What data this system holds, how sensitive each category is, where
it lives, who can reach it, and what protects it — plus the two formal records this step's
instruction requires: the secrets scan, and the file/upload security boundary.

## 1. Data categories

| Category | Examples | Where it lives | Sensitivity |
|---|---|---|---|
| Identity/session | `SESSION_SECRET`-signed cookie, `users.sessionEpoch` | Cookie (client), `users` table | High — compromise impersonates a user |
| Party PII | Name, email, mobile, residential address | `parties` | High — real personal data of sellers/buyers/solicitors |
| Financial — payment references | Provider customer/payment-method references (never raw card numbers) | `paymentMethods`, `payments` | High |
| Financial — commercial terms | Commission-agreement terms, PC-fee-authority `feeBasis`/`rateBps`/`gciDefinition` | `commissionAgreements`, `pcFeeAuthorities` | High — confidential per-brokerage commercial terms (subject of finding #5 in the tenant-isolation doc) |
| Financial — ledger | Settlement/reconciliation records | `financial.*` tables | High |
| Documents | Generated/signed agreement content | `documents`, local object storage (`OBJECT_STORAGE_LOCAL_DIR`) | High |
| AML/compliance | Verification status, exceptions | `amlVerifications`, `riskExceptions` | High — regulated-adjacent data |
| Communications | Message content, consent state | `communicationMessages`, `communicationConsent` | Medium–High |
| Operational | Tasks, workflow state, Pit Crew assignments | Various | Medium |
| Audit trail | `logAudit` records | `auditLog` | Medium — must itself never carry the sensitive values above |
| Integration credential references | Opaque generated identifiers only | `integrationCredentials` | Structurally never a secret — see §4 |
| Provider secrets | API keys, webhook secrets, `DATABASE_URL` | Environment variables only | Critical |

## 2. Access control

Every row-level category above is `brokerageId`-scoped and reachable only through the
tenant-isolation convention documented in `AUTHENTICATION_AUTHORISATION_AND_TENANT_
ISOLATION.md` — this document doesn't repeat that audit, it assumes it. Role-level
restriction on top of tenant scoping: refunds, AML-exception resolution, and integration-
credential minting are Brokerage-Administrator-only (`requireRole(...BROKERAGE_ADMIN_
ROLES)`); everything else is available to any authenticated member of the owning
brokerage.

## 3. Provider secrets — configuration posture

Every provider credential (`CLERK_SECRET_KEY`, `AML_PROVIDER_API_KEY`, `AML_WEBHOOK_
SECRET`, `ESIGN_PROVIDER_API_KEY`, `ESIGN_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_
WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `SESSION_SECRET`) is read from
`process.env` with **no hardcoded fallback anywhere in the codebase** — `.env.example`
documents variable names only, every value is blank. `SESSION_SECRET` and (new this step)
`CORS_ALLOWED_ORIGINS` fail closed at boot in production if unset (`assertSessionSecret
Configured()`, `assertCorsConfigured()`, both called from `index.ts`); every provider
integration in this build is `mock` by default (`AML_PROVIDER=mock`, `ESIGN_PROVIDER=mock`,
`PAYMENT_PROVIDER=mock`, `AI_PROVIDER=mock`) and this step does not authorise switching any
of them to a real provider.

## 4. Secrets scan — formal record

**What was run:** a pattern-based scan of the entire working tree (not a subset) this
session, looking for: (a) any string literal shaped like a real secret (high-entropy,
`sk-`/`AKIA`/`ghp_`-style provider-specific prefixes, PEM key headers, JWT-shaped tokens)
outside of test fixtures explicitly generating synthetic values; (b) any `.env` file other
than `.env.example` checked into the tree; (c) any hardcoded fallback for `SESSION_SECRET`,
a database credential, or a provider API key.

**What was found:** no live secret values anywhere in the repository. The only `.env` file
present is the local development one (`apps/api/.env`, present in the working directory for
this session's own test execution, not part of the committed tree — `.gitignore` excludes
`.env`; `.env.example` is the only committed template and contains empty values only). No
hardcoded credential fallback exists anywhere in `apps/api/src` — confirmed directly by
reading `lib/session.ts`, `lib/cors.ts`, and every `packages/integrations/*` provider
adapter's credential-handling code.

**What this scan does not cover:** git history (this workspace has no local `.git`
directory this session — see the completion report's Git-and-PR-state section — so a
history scan for a secret committed and later removed was not possible from here) and any
secret that might exist outside the repository (a CI secret store, a hosting platform's
environment configuration) — neither is in scope for a source-tree scan.

Per this step's explicit instruction, this record states type and location of anything
found, never a value — and in this case nothing was found, so no such record is needed;
this section documents that the scan was actually executed rather than assumed clean.

## 5. File/document/import/export security

Untrusted file upload is the CSV/XLSX import pipeline (`apps/api/src/lib/import/`).
`fileValidation.ts`'s `validateUploadedFile` runs **before any parser touches the file**
and treats the upload as untrusted end to end:

- 25 MB size cap (`MAX_FILE_SIZE_BYTES`), 50,000-row cap (`MAX_IMPORT_ROWS`).
- Extension allowlist: only `.csv`/`.xlsx` accepted; macro-bearing and legacy formats
  (`.xlsm`, `.xlsb`, `.xltm`, `.xlam`, `.xls`, `.xlt`) explicitly rejected before any parse
  attempt, not discovered as a parser crash.
- Suspicious-MIME rejection (`application/x-msdownload`, `application/x-executable`,
  `application/x-sh`, `text/html`).
- Magic-byte verification for `.xlsx`: must start with the `PK` zip local-file-header
  signature (a real `.xlsx` is a zip archive) — rejects a renamed/corrupted/password-
  protected file with a clear message rather than letting the parser fail unpredictably
  several steps later.
- Every rejection returns a plain, user-facing message — never a raw parser stack trace.

Reached only through the authenticated, entitlement-gated `POST /import/*` surface
(`routes/import.ts`, confirmed tenant-scoped — see the tenant-isolation doc's PASS row for
`import.ts`), never from an unauthenticated path.

**Residual risk, disclosed:** the `xlsx` package itself (`^0.18.5`) has two known,
registry-unfixable advisories (prototype pollution, ReDoS — see
`SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md` §8). The compensating controls above bound the
blast radius (a malicious file is capped at 25 MB/50k rows and must pass the extension/
magic-byte gate before `xlsx` ever parses it, and only an authenticated, entitled user can
reach the endpoint at all) but do not eliminate the underlying library defect. Recorded as
a deferred, accepted risk pending either a reviewed switch to SheetJS's CDN-distributed
patched build or a migration to a different parsing library — a decision requiring human
sign-off, not made unilaterally this step.

**Document generation/storage.** Generated and signed document content
(`lib/documents.ts`) is stored via `OBJECT_STORAGE_PROVIDER=local` in this build and
retrieved only through the now-tenant-scoped `GET /documents/:documentId/content` route
(finding #2 in the tenant-isolation doc). Content is served with `res.type("text/plain")`,
not rendered as HTML, so a stored value cannot execute as script in a browser context that
requests it directly.

## 6. Sensitive data in logs — open gap

This step added a per-request correlation id (echoed as `X-Correlation-Id`) but did **not**
build a structured-logging/redaction layer — see `OBSERVABILITY_STANDARD.md` for the full,
honest state. Concretely: 109 raw `console.*` call sites exist across `apps/api/src`
(surveyed this session via `grep`, excluding test files), with no central logger and no
enforced redaction of PII/financial/credential fields. A manual read of the highest-count
files (`routes/automationOps.ts`, `lib/documents.ts`, `lib/aml.ts`, `routes/parties.ts`,
`lib/transactions.ts`) found no call site that logs a raw secret, session token, or full
card/payment-method reference — the existing convention is to log an error object or a
record id, not a full row — but this was a spot check, not exhaustive coverage, and there
is no structural guarantee preventing a future call site from logging a PII-bearing object
wholesale. `OBSERVABILITY_STANDARD.md` specifies the target logging field list and
redaction rule this gap should be closed against; it is listed as deferred work, not
completed work.

## 7. AI/automation data handling

`lib/ai/context/contextEngine.ts`'s `buildPropertyContext`/`buildTransactionContext` are the
only paths that assemble brokerage data into an AI prompt; both are tenant-scoped (verified
in the tenant-isolation audit) and return `null` rather than another brokerage's data on a
mismatch. `lib/ai/governance.ts`, `lib/ai/policyEngine.ts`, and `lib/ai/executionGateway.ts`
already gate any state-changing AI-initiated action behind an explicit approval step
(`REQUEST_ACTION_APPROVAL` → `AWAITING_APPROVAL` → human decision), exercised by the
existing `lib/ai/__tests__/governance.test.ts` and `orchestrator.test.ts` suites (7 test
files, reviewed this step, not modified — see the completion report's AI/automation
security finding for the specific scenarios those files already cover).
