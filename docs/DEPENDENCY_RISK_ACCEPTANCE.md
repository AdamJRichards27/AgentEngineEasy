# Dependency risk acceptance — Agent Engine 2.0, Step 2 closure

## Status: AE Project Owner risk decisions recorded (2026-09-05)

The two dependency-risk records below (A: `xlsx`, B: transitive `esbuild`)
were previously presented as Claude's own **recommended** interim decisions,
explicitly pending a named human call — no risk was self-accepted by Claude
on the repository's behalf. The **AE Project Owner** has since reviewed and
authorized both, in each case as a temporary, conditional acceptance with a
fixed review point, not a permanent exception. Both records below are
rewritten to state that authorization directly, using the AE Project
Owner's own conditions verbatim rather than Claude's earlier recommendation
language. **These are recorded business risk-acceptance decisions by the AE
Project Owner. Neither is, and neither should be represented as, an
approval by an independent security professional.**

## Re-audit results (carried forward, unchanged this pass)

| Severity | Package | Advisory | Vulnerable | Patched | Where it comes from |
|---|---|---|---|---|---|
| high | xlsx | Prototype Pollution in SheetJS ([GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)) | <0.19.3 | **none published** | `apps/api` direct dependency, `xlsx@0.18.5` |
| high | xlsx | SheetJS ReDoS ([GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)) | <0.20.2 | **none published** | `apps/api` direct dependency, `xlsx@0.18.5` |
| moderate | esbuild | Dev-server allows any site to read/send requests ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) | ≤0.24.2 | ≥0.25.0 | Transitive, entirely inside `packages/db > drizzle-kit@0.30.6`'s own dependency tree |

(`pnpm audit`'s summary line reports "2 moderate | 2 high" — that counts
*vulnerable version instances* found in the tree, not distinct advisories:
the moderate esbuild advisory matches two different transitive `esbuild`
versions, 0.18.20 and 0.19.12, both pulled in by `drizzle-kit`. It is one
advisory, one decision, counted once below.)

## The `apps/api` direct esbuild finding — fixed and now merged

**Update: this is no longer a pending patch.** The low-severity finding
(GHSA-g7r4-m6w7-qqqr, `apps/api`'s own direct `esbuild` devDependency,
dev-server path traversal / arbitrary file read on Windows, vulnerable
range `>=0.27.3 <0.28.1`) was verified in the CI Unblocking pass and
delivered as a ready-to-apply patch; it has since been applied to this
branch (commit `e640f3d`, `fix(api): bump esbuild to ^0.28.1
(GHSA-g7r4-m6w7-qqqr)`), matching the delivered patch bundle exactly.
`apps/api/package.json` now pins `"esbuild": "^0.28.1"`. This finding
requires no further decision — it is fixed, not accepted as a risk.

## A. `xlsx@0.18.5` — AE Project Owner risk acceptance (AUTHORIZED)

- **Dependency / advisories:** `xlsx@0.18.5` (direct `apps/api` dependency)
  — GHSA-4r6h-8v6p-xvw6 (prototype pollution) and GHSA-5pgg-2g8v-p4x9
  (ReDoS). Both report `"patched_versions": "<0.0.0"` — the `xlsx` npm
  package has never published a version that resolves either advisory.
- **Severity:** High (both advisories).
- **Exposure:** Untrusted, user-uploaded `.xlsx` files reach this code.
  `apps/api/src/lib/import/parsers/excelParser.ts` is the only non-test
  call site; the import route (`apps/api/src/routes/import.ts`) accepts a
  user-uploaded file via `multer` and hands the raw buffer to this parser.
  Any brokerage user with import access can trigger it with an arbitrary
  `.xlsx` file.
- **Existing controls:**
  - Upload size capped at 25MB (`MAX_FILE_SIZE_BYTES`,
    `apps/api/src/lib/import/fileValidation.ts`).
  - Parsed row count capped at 50,000 rows (`DEFAULT_MAX_ROWS`,
    `excelParser.ts`).
  - No formula recalculation is requested and SheetJS's community build
    (used here) does not execute VBA macro bytecode — a data reader, not a
    code-execution surface for macros. This bounds worst-case impact but
    does not neutralise either advisory.
  - CSV is, and remains, the preferred/recommended import format.
- **Temporary decision — AUTHORIZED:** Accept the two high-severity
  advisories for a **maximum of 90 days**, subject to the following
  conditions, recorded exactly as authorized:
  1. The 25MB upload limit is maintained.
  2. The 50,000-row limit is maintained.
  3. No expansion of spreadsheet-import exposure.
  4. CSV is retained as the preferred import format.
  5. A maintained replacement or a safer parsing method is evaluated.
  6. This decision is reviewed immediately if exploitation evidence
     appears, a patch is published, or a suitable replacement appears.
  7. Remediation, replacement, isolation, or renewed approval occurs
     before the 90-day expiry.

  **This acceptance does not authorise permanent use of the vulnerable
  dependency.**
- **Approval date:** 2026-09-05
- **Approving authority:** AE Project Owner.
- **Review / expiry date:** 2026-12-04 (90 calendar days from the approval
  date above), or immediately upon any of the earlier-reassessment
  conditions below, whichever comes first.
- **Conditions triggering earlier reassessment:** exploitation evidence
  against either advisory; a patched `xlsx` release becoming available; a
  suitable maintained replacement being identified and validated; any
  request to expand spreadsheet-import functionality or exposure beyond
  its current scope; any new advisory published against `xlsx`.
- **Remediation owner:** AE Backend Engineering — the accountable owner is
  the maintainer(s) of `apps/api/src/lib/import/` (the import pipeline).
  This role is explicitly assigned; it is not left ownerless. (A specific
  named individual should be recorded here by the AE Backend Engineering
  lead once assigned.)
- **Intended remediation milestone:** tracked in issue "Replace or isolate
  vulnerable xlsx parser" (linked below) — evaluate and select one of: (a)
  migrate `excelParser.ts` to a maintained parser (e.g. `exceljs`, or a
  WASM-based reader); (b) isolate parsing in a sandboxed
  process/worker with a strict resource/time limit; (c) adopt SheetJS's own
  patched distribution channel outside the npm registry. Target: a
  remediation decision made, and if replacement/isolation is chosen, a
  validated implementation in place, before 2026-12-04.

## B. Transitive `esbuild` via `drizzle-kit` — AE Project Owner risk acceptance (AUTHORIZED)

- **Dependency / advisory:** `packages/db > drizzle-kit@0.30.6 >
  @esbuild-kit/esm-loader@2.6.5 > @esbuild-kit/core-utils@3.3.2 >
  esbuild@0.18.20`, and `packages/db > drizzle-kit@0.30.6 >
  esbuild@0.19.12` (also via `esbuild-register@3.6.0`) —
  GHSA-67mh-4wv8-2f99 (moderate).
- **Severity:** Moderate.
- **Exposure:** Dev tooling only. `drizzle-kit` is a devDependency of
  `packages/db`, invoked only via `drizzle-kit generate`/`push` during
  local development and CI's schema-drift check — never imported by
  `apps/api`'s runtime code and never shipped in either production build.
  The vulnerability itself is in esbuild's own *development server*
  (`esbuild serve`) accepting cross-origin requests; nothing in this
  repository's scripts invokes `esbuild serve` for any of drizzle-kit's
  bundled copies.
- **Existing controls:** the vulnerable code path (the dev server) is
  never invoked by any script in this repository; no dev service exposing
  it is run against an untrusted network.
- **Temporary decision — AUTHORIZED:** Accept the moderate advisory,
  subject to the following conditions, recorded exactly as authorized:
  1. Remains confined to dev/migration tooling.
  2. Confirmed absent from production builds (re-verified this pass — see
     above: neither `apps/api`'s nor `apps/web`'s production build output
     includes `drizzle-kit` or its dependency tree).
  3. No exposure of the affected dev service to untrusted networks.
  4. Review and attempted remediation occurs at the next `drizzle-kit`
     upgrade.
  5. Immediate reassessment if runtime exposure changes.
- **Approval date:** 2026-09-05
- **Approving authority:** AE Project Owner.
- **Review / expiry date:** primarily event-triggered, per condition 4
  above — at the next `drizzle-kit` minor/major version bump. As a
  calendar backstop, this record is also reassessed no later than
  **2026-12-04** (90 days from the approval date) if no `drizzle-kit`
  upgrade has occurred by then, so the record cannot go stale indefinitely
  between upgrades.
- **Conditions triggering earlier reassessment:** any change that exposes
  drizzle-kit's bundled esbuild dev server to a network reachable by
  untrusted clients; `drizzle-kit` or its dependency tree appearing in a
  production build or runtime path; a new or escalated advisory against
  this esbuild range.
- **Remediation owner:** AE Backend Engineering — the accountable owner is
  the maintainer(s) of `packages/db` and its `drizzle-kit` upgrade cadence.
- **Intended remediation milestone:** re-run `pnpm audit` at each
  `drizzle-kit` upgrade; adopt the upgrade once it resolves this advisory,
  or, failing that, a tested `pnpm.overrides` entry forcing `esbuild
  >=0.25.0` within drizzle-kit's own dependency tree, validated against
  `drizzle-kit generate`/`push` before adoption.

## Tracked issue: "Replace or isolate vulnerable xlsx parser"

Filed as [issue #26](https://github.com/AdamJRichards27/AgentEngineEasy/issues/26)
with acceptance criteria:

- [ ] Evaluate at least one maintained alternative parser (e.g. `exceljs`)
      or a safe isolation strategy (sandboxed worker/process) for `.xlsx`
      import parsing.
- [ ] Validate the chosen approach against the existing import test
      fixtures (`apps/api/src/lib/import/__tests__/`) with no regression.
- [ ] Confirm the 25MB upload limit and 50,000-row limit remain enforced
      (or are re-justified) under the new implementation.
- [ ] Re-run `pnpm audit` and confirm neither GHSA-4r6h-8v6p-xvw6 nor
      GHSA-5pgg-2g8v-p4x9 applies to `apps/api`'s resulting dependency
      tree.
- [ ] Update this document (`docs/DEPENDENCY_RISK_ACCEPTANCE.md`) to record
      the remediation and close out risk-acceptance record A.
- [ ] Complete, or formally renew with a new AE Project Owner decision,
      before the current expiry of **2026-12-04**.

This issue tracks the follow-up only; this pass does not implement the
replacement itself, per its own governing instruction not to expand into
that work.

## Summary for the PR decision

- The low-severity `esbuild` finding (`apps/api`'s own direct dependency)
  is fixed, verified, and now merged onto this branch (commit `e640f3d`) —
  fully resolved, not a risk-acceptance item.
- The 2 high-severity `xlsx` findings and the 1 moderate transitive
  `esbuild` finding are each now recorded above as an **authorized,
  temporary, conditional risk acceptance by the AE Project Owner**, with a
  fixed review/expiry date, an assigned accountable remediation owner, and
  named conditions that trigger earlier reassessment. Neither acceptance is
  represented as permanent, and neither is represented as an independent
  security professional's approval.
