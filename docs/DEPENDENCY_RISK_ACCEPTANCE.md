# Dependency risk acceptance — Agent Engine 2.0, Step 2 closure

## Status: `xlsx` risk remediated; transitive `esbuild` acceptance remains active

The `xlsx` risk acceptance recorded on 2026-09-05 is closed by the verified
SheetJS CE 0.20.3 update described below. The separate transitive `esbuild`
acceptance remains active under its original conditions. These are recorded
business risk decisions by the AE Project Owner; none is represented as an
approval by an independent security professional.

## Current re-audit results

| Severity | Package | Advisory | Vulnerable | Patched | Where it comes from |
|---|---|---|---|---|---|
| moderate | esbuild | Dev-server allows any site to read/send requests ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) | ≤0.24.2 | ≥0.25.0 | Transitive, entirely inside `packages/db > drizzle-kit@0.30.6`'s own dependency tree |

`pnpm audit` reports `2 moderate | 0 high | 0 critical`. The moderate
`esbuild` advisory matches two different transitive versions, 0.18.20 and
0.19.12, both pulled in by `drizzle-kit`; it is one distinct advisory and
one decision, counted once below.

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

## A. SheetJS CE — risk acceptance closed (REMEDIATED 2026-09-07)

- **Remediation:** the direct `apps/api` dependency now uses SheetJS CE
  0.20.3, which is outside both vulnerable ranges:
  GHSA-4r6h-8v6p-xvw6 (`<0.19.3`) and GHSA-5pgg-2g8v-p4x9 (`<0.20.2`).
- **Authoritative source:** the immutable official SheetJS CDN release
  `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.
- **Retained artifact:** `vendor/xlsx-0.20.3.tgz`, 2,409,319 bytes, package
  identity `xlsx@0.20.3`, Apache-2.0 license, no runtime dependencies, and
  no install lifecycle scripts.
- **SHA-512:** `a0b0eade3c3b01c2ea2961f60210a9553665f267fa5f661178ff8d7a1d12254cd5fc1759623b61f78b46e6da22301d4f3eb62dc4e09f6a850292fb6e1fedc024`.
  The adjacent checksum record is verified automatically before frozen
  installation in CI.
- **Reproducibility:** the manifest and lockfile reference only the
  repository-local archive. A clean `pnpm install --frozen-lockfile
  --offline` completed with zero downloads.
- **Compatibility:** existing upload-size, row-count, format, validation,
  parsing, rollback, and tenant-isolation behavior is unchanged and covered
  by the import regression suite.
- **Audit result:** `pnpm audit` reports no `xlsx` advisory, no high
  finding, and no critical finding. The former temporary acceptance is
  therefore closed rather than renewed.

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

- [x] Adopt the supported official SheetJS CE distribution channel using a
      pinned, checksummed, repository-local archive.
- [x] Validate the chosen approach against the existing import test
      fixtures (`apps/api/src/lib/import/__tests__/`) with no regression.
- [x] Confirm the 25MB upload limit and 50,000-row limit remain enforced
      (or are re-justified) under the new implementation.
- [x] Re-run `pnpm audit` and confirm neither GHSA-4r6h-8v6p-xvw6 nor
      GHSA-5pgg-2g8v-p4x9 applies to `apps/api`'s resulting dependency
      tree.
- [x] Update this document (`docs/DEPENDENCY_RISK_ACCEPTANCE.md`) to record
      the remediation and close out risk-acceptance record A.
- [x] Complete, or formally renew with a new AE Project Owner decision,
      before the current expiry of **2026-12-04**.

The engineering acceptance criteria are complete. Issue closure remains an
administrative repository action.

## Summary for the PR decision

- The low-severity `esbuild` finding (`apps/api`'s own direct dependency)
  is fixed, verified, and now merged onto this branch (commit `e640f3d`) —
  fully resolved, not a risk-acceptance item.
- The 2 high-severity `xlsx` findings are remediated and its temporary risk
  acceptance is closed.
- The 2 moderate vulnerable `esbuild` instances (one distinct transitive
  advisory) remain under the authorized, temporary, conditional acceptance
  above. It is not represented as permanent or as an independent security
  professional's approval.
