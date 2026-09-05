# Static and dynamic security checks — Agent Engine 2.0, Step 2 closure (Part E)

## Scope and instruction

This closure pass was directed to run a recognised, repo-compatible static
analysis tool with full evidence, plus bounded, non-destructive local
dynamic security checks — or, failing that, to formally defer DAST/pentest
work to a later step with a named owner and criteria. Both halves were
completed; nothing here was deferred.

## Static analysis

### Tool selection

`semgrep` was tried first (it is the most commonly recognised tool for
this purpose) but its registry rulesets (`p/security-audit`,
`p/owasp-top-ten`, etc.) require fetching rule bundles from
`semgrep.dev`, which this session's network egress does not allow
(`403 Forbidden` at the proxy). Rather than substitute a much weaker,
hand-picked rule subset, this pass used **`njsscan` v1.0.0** instead — a
Node.js/Express-specific static analyzer (from the same OpenSecurity
project as `mobsfscan`) whose rules ship bundled with the package, so it
runs fully offline. It is a real, independently-maintained,
purpose-built tool for this exact stack (Node/Express), not a
custom/ad-hoc script written for this pass.

### Run

```
njsscan --json -o njsscan_results.json apps/api/src packages/events/src packages/db/src
```

(scoped to first-party source only — `node_modules`, `dist`, and build
output are never scanned by njsscan by design)

### Findings — full disclosure, triaged

njsscan reported 5 distinct rule categories. Every one was individually
reviewed against the actual surrounding code, not just the rule's generic
description:

| Rule | Severity | Files flagged | Verdict |
|---|---|---|---|
| `express_xss` | ERROR | `apps/api/src/routes/import.ts:261,262,266` | **False positive.** The flagged code reflects a `Number()`-coerced route parameter into a `Content-Disposition` filename header on a `text/csv` response (`GET /jobs/:id/rejected.csv`) — never into an HTML body, and never anything but a number. njsscan's generic "user input reaches `res.send`" heuristic doesn't distinguish response `Content-Type` or the numeric coercion; there's no HTML-rendering context here for reflected XSS to occur in. Investigating this finding is what surfaced the real, distinct issue below, though — see "A real finding this pass found and fixed". |
| `node_api_key` | ERROR | `apps/api/src/lib/ai/__tests__/gateway.test.ts`, `packages/events/src/__tests__/redaction.test.ts` | **False positive.** Both are test fixtures — deliberately fake API-key-shaped strings used to test that this repository's own redaction system detects and masks that exact shape (the same pattern already disclosed for the CI secret-pattern-scan step in `docs/CI_SCHEMA_DRIFT_FIX.md`). |
| `node_secret` | ERROR | `apps/api/src/lib/integrations/credentials.ts:27`, 3 test files | **False positive** on the non-test hit. Line 27 is `SECRET_IDENTIFIER_PREFIX = "mock-secret-ref:"` — a marker string, not a secret value. This module's own header comment (and Part C's/Step 5's own design) documents that it is structurally incapable of persisting a real secret: there is no "secret value" parameter anywhere in the file, only an opaque identifier it generates itself. The word "secret" in a constant name is what triggered njsscan's naive pattern match. The 3 test-file hits are the same kind of deliberate fake-secret test fixture as `node_api_key` above. |
| `node_insecure_random_generator` | WARNING | 33 hits, all in `__tests__/*.test.ts` files | **False positive**, all of them. Every hit is `Math.random()` used to generate test fixture data (random emails, random offsets) inside test files — never in production request-handling or token/credential-generation code. Confirmed by grep: no production (non-test) file uses `Math.random()` for anything security-sensitive; `randomUUID()` (a real CSPRNG) is what's actually used everywhere a real identifier or secret reference is minted. |
| `regex_dos` | WARNING | `apps/api/src/routes/automationOps.ts:214,254,282,316` (+1 test file) | **False positive.** All 4 non-test hits are `UUID_PATTERN.test(req.params.id)`, and `UUID_PATTERN` (`automationOps.ts` line 48) is `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` — a fixed-length, non-nested, non-ambiguous pattern with no catastrophic-backtracking shape. njsscan flags any regex applied to `req.*` generically, without analysing the pattern itself. |

**4 of 5 rule categories, and every single individual hit, were false
positives** once checked against the actual code and its intent — not
dismissed on the strength of the tool's own confidence label, but
individually read and reasoned about above.

### A real finding this pass found and fixed

Investigating the `express_xss` false positive above led to actually
reading `exportRejectedRecordsCsv` (`apps/api/src/lib/import/pipeline.ts`),
the function backing that route, end to end — and that surfaced a real,
different, previously-undocumented issue njsscan's rule set doesn't have a
check for at all: **CSV/formula injection**. That function re-exports an
uploaded import file's rejected rows, verbatim, as a downloadable CSV an
agent is expected to open in a spreadsheet application and fix. Both the
column headers (arbitrary user-supplied import-file column names) and
every cell value come from data an external, untrusted party (whoever
supplied the file being imported) controls. Before this pass, a cell or
header value starting with `=`, `+`, `-`, or `@` would round-trip into the
exported CSV completely unmodified — and Excel, Google Sheets, and
LibreOffice all interpret a leading one of those characters as the start
of a formula, not literal text, when a CSV is opened. This is the
well-known "CSV injection" / "formula injection" vulnerability class
(CWE-1236).

**Fixed**: `apps/api/src/lib/import/pipeline.ts`'s `csvEscape` now applies
the standard OWASP-recommended mitigation first — any value starting with
`=`, `+`, `-`, `@`, a tab, or a carriage return is prefixed with a
neutralising leading `'` before the pre-existing comma/quote/newline
quoting logic runs — applied uniformly to headers, cell values, and the
appended error-message column (all three draw from the same
user-controlled source).

**Verified**: a new test,
`apps/api/src/lib/import/__tests__/pipeline.test.ts`'s "neutralises
formula-injection-shaped values in the rejected-rows CSV export", drives a
real upload containing a `Property Address` of `=1+1` through the full
pipeline (real database, real rejection path, real CSV export) and asserts
the export contains `'=1+1`, never the raw `=1+1`. All 24 tests in that
file pass (23 pre-existing + this 1 new one), and the 8-test
`routes/__tests__/import.test.ts` HTTP-level suite (unaffected by this
change, included as a regression check on the same route file) also
passes unchanged.

## Bounded, non-destructive local dynamic checks

Rather than defer DAST to Step 4, this pass ran the API in
`NODE_ENV=production` against the local test database (no real data, no
network exposure beyond `localhost`) and drove real HTTP requests at it —
proving the perimeter controls this PR already claims are actually
enforced at runtime, not just present in source:

| Check | Method | Result |
|---|---|---|
| Fails closed without `CORS_ALLOWED_ORIGINS` | Start the server in production mode with the variable unset | **Refused to start**, with the exact documented error (`cors.ts`'s own fail-closed check) |
| Fails closed without `METRICS_TOKEN` | Start the server in production mode with the variable unset | **Refused to start**, with the exact documented error (`metricsAuth.ts`'s own fail-closed check) |
| Security headers (helmet) | `curl -D-` against `GET /api/health` | `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` all present |
| Auth required on a protected route | `GET /api/properties`, no session cookie | `401` |
| Metrics endpoint requires its bearer token | `GET /api/internal/metrics`, no `Authorization` header, then with the correct token | `401` then `200` |
| CORS allowlist is enforced, not reflected-any-origin | `Origin: https://evil.example.com` vs. the configured `https://app.example.com` | No `Access-Control-Allow-Origin` header for the disallowed origin; correct reflection for the allowed one |
| Request body size limit | A 2MB JSON body against `POST /api/auth/login` | `413` |
| Auth-endpoint rate limiting | 25 rapid `POST /api/auth/login` attempts | First 20 returned `401` (wrong credentials, as expected); requests 21–25 returned `429` |

All 8 checks behaved exactly as the rest of this PR already documents
they should. This is real evidence of enforced runtime behaviour, not a
restatement of what the source code says it does — obtained without
touching any real user data, real credentials, or any environment other
than this pass's own local ephemeral database, and the server process was
stopped immediately after.

## What this does not replace

This is a bounded static scan plus a handful of targeted perimeter checks
— it is not a substitute for an independent penetration test or a
full DAST crawl (e.g., an authenticated, exhaustive walk of every route
with a fuzzing tool). That remains explicitly out of scope for this
closure pass, consistent with the original Step 2 instruction's own
framing (this document does not claim otherwise anywhere, including in
the final PR decision).
