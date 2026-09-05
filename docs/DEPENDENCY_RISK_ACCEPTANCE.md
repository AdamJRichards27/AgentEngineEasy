# Dependency risk acceptance — Agent Engine 2.0, Step 2 closure

## Update (CI Unblocking and Final Merge-Readiness pass)

This pass re-ran `pnpm audit` fresh against the current lockfile (unchanged:
4 findings, 3 distinct advisories, 2 packages) and re-verified the
previously-prepared low-severity `esbuild` fix end-to-end, including a
frozen-lockfile install, `apps/api` typecheck, `apps/api` and `apps/web`
production builds, the full 663-test regression suite, and the 88-test
tenant-isolation subset — all unchanged/passing. The fix is now packaged as
an exact, ready-to-apply file pair (`apps/api/package.json` +
`pnpm-lock.yaml`) delivered alongside the completion report, since this
session still has neither an authenticated `git push` credential nor a
reliable way to transmit a ~92KB lockfile through its GitHub API tooling
(both re-confirmed this pass — see
`docs/SECURITY_AND_OBSERVABILITY_COMPLETION_REPORT.md` §1/§11). The two
records below (A: `xlsx`, B: `esbuild` transitive) are restated in the
structured decision format this pass's governing instruction requires.
**Claude has not accepted either risk on the repository's behalf** — both
require a named human decision below.

## Re-audit results (unchanged this pass)

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

## Fixed and verified this pass — the esbuild low-severity finding

**Already resolved on this branch's current state is not accurate — restated
precisely:** the low-severity finding (GHSA-g7r4-m6w7-qqqr, `apps/api`'s own
direct `esbuild` devDependency, dev-server path traversal / arbitrary file
read on Windows, vulnerable range `>=0.27.3 <0.28.1`) is fixed and verified
in this session's working copy, packaged as a ready-to-apply patch, but is
**not yet on the branch itself** — the branch's committed
`apps/api/package.json` still pins `"esbuild": "^0.27.0"`. See the
maintainer patch bundle (`esbuild_fix/package.json` +
`esbuild_fix/pnpm-lock.yaml`) delivered with this pass.

Verified this pass, starting from a clean copy of the branch's own current
lockfile (not a drifted local copy) plus exactly one specifier edit, to
guarantee no unrelated dependency churn:
- The lockfile diff touches **only** `esbuild`'s own resolution
  (`0.27.7` → `0.28.2`) and its 26 per-platform optional binary packages
  (`@esbuild/*`, required collateral of bumping esbuild's own version) plus
  one shared `vite`-internal esbuild dedup entry. Nothing else changed —
  confirmed by a full line-for-line diff against the branch's current
  `pnpm-lock.yaml`.
- `pnpm install --frozen-lockfile` succeeds.
- `pnpm audit` after the fix: unchanged at 3 advisories (this finding was
  already the only one tied to `apps/api`'s own direct esbuild dependency,
  and is confirmed absent).
- `pnpm --filter @aee/api run typecheck` — clean.
- `pnpm --filter @aee/api run build` — succeeds, same output shape
  (`dist/index.mjs`, 1.0mb, esbuild 0.28.2).
- `pnpm --filter @aee/web run build` — succeeds unchanged (Vite production
  build, 113 modules).
- Full `apps/api` regression suite: 663 tests, 662 pass, 0 fail, 1 skip —
  identical to the pre-fix baseline.
- The 88-test tenant-isolation regression subset: 88/88 pass, unchanged.

This is a devDependency-only, build-tool-only change. `esbuild` is never
part of the runtime bundle it produces (`--packages=external`), and the
specific vulnerability (path traversal via esbuild's *development* server,
Windows-only) does not apply to how this repository invokes esbuild (a
one-shot `esbuild ... --outfile=...` build command, never `esbuild serve`).

## A. `xlsx` — both high-severity findings (human decision required)

- **Affected version:** `xlsx@0.18.5` (direct `apps/api` dependency).
- **Reported vulnerabilities:** GHSA-4r6h-8v6p-xvw6 (prototype pollution,
  high) and GHSA-5pgg-2g8v-p4x9 (ReDoS, high). Both report
  `"patched_versions": "<0.0.0"` — the `xlsx` npm package has never
  published a version that resolves either advisory.
- **Where and how AE uses it:** `apps/api/src/lib/import/parsers/excelParser.ts`
  is the only non-test call site. It parses uploaded `.xlsx` workbooks as
  part of the property/transaction data import pipeline
  (`apps/api/src/lib/import/`).
- **Do untrusted customer files reach this code:** **yes.** The import route
  (`apps/api/src/routes/import.ts`) accepts a user-uploaded file via
  `multer` and hands the raw buffer to this parser. Any brokerage user with
  import access can trigger it with an arbitrary `.xlsx` file.
- **Existing mitigations already in place:**
  - Upload size is capped at 25MB (`MAX_FILE_SIZE_BYTES`,
    `apps/api/src/lib/import/fileValidation.ts`) before the file ever
    reaches the parser.
  - Parsed row count is capped at 50,000 rows
    (`DEFAULT_MAX_ROWS`, `excelParser.ts`) — bounds worst-case parse work
    per request regardless of file contents.
  - The parser never requests formula recalculation and SheetJS's community
    build (which this is) does not execute VBA macro bytecode — it is a
    data reader, not a code-execution surface for macros. Prototype
    pollution and ReDoS are still real risks independent of macro
    execution, so this does not neutralise either advisory, only rules out
    a worse (code-execution) failure mode.
  - The parse result is used only to build in-memory import records;
    nothing from a parsed workbook is written back into `xlsx`'s own object
    prototype chain in application code (reduces, but does not eliminate,
    exploitability of the prototype-pollution advisory specifically, since
    the vulnerability is inside the library's own parsing code, not in how
    the result is consumed).
- **Viable replacement/isolation/removal options:**
  1. Migrate to an actively-maintained alternative parser (e.g.
     `exceljs`, or a WASM-based reader) — a real code change to
     `excelParser.ts`'s implementation, not a version bump.
  2. Isolate parsing in a separate, sandboxed process/worker with a strict
     resource/time limit, so a crafted file can only affect that
     sub-process — mitigates impact without removing the vulnerable code.
  3. Adopt SheetJS's own patched distribution channel outside npm (per
     SheetJS's own advisory guidance) — a supply-chain trade-off (a
     non-npm-registry dependency source) this pass is not positioned to
     decide unilaterally.
  4. Accept the risk given the existing size/row-count bounds, if judged
     sufficient.
- **Operational impact of replacing it:** real. `xlsx`'s API
  (`XLSX.read`, `XLSX.utils.sheet_to_json`) is used exactly once in
  `excelParser.ts`, so the blast radius of a swap is small and contained
  to that one file, but any replacement library needs the same behavior
  validated against this repository's actual import test fixtures
  (`apps/api/src/lib/import/__tests__/`) before it can be trusted with
  production import traffic — this is a scoped but real piece of follow-up
  work, not a one-line change.
- **Recommended decision:** given a crafted upload is required to trigger
  either advisory and both existing bounds (25MB, 50,000 rows) already limit
  worst-case impact, and no patched version exists to simply adopt,
  **accept temporarily** is the most defensible interim choice, paired with
  scoping option 1 (replacement) as tracked follow-up work — but this is
  the human decision-maker's call, not this pass's.
- **Proposed review/expiry date:** 90 days from this report's date, or
  immediately upon either (a) a patched `xlsx` release appearing, or (b) any
  new advisory against `xlsx` being published — whichever comes first.

## B. Remaining transitive `esbuild` finding (human decision required)

- **Dependency path:** `packages/db > drizzle-kit@0.30.6 >
  @esbuild-kit/esm-loader@2.6.5 > @esbuild-kit/core-utils@3.3.2 >
  esbuild@0.18.20`, and `packages/db > drizzle-kit@0.30.6 > esbuild@0.19.12`
  (also via `esbuild-register@3.6.0`) — GHSA-67mh-4wv8-2f99.
- **Production runtime or build/dev tooling only:** **dev tooling only.**
  `drizzle-kit` is a devDependency of `packages/db`, invoked only via
  `drizzle-kit generate`/`push` during local development and CI's schema
  drift check — it is never imported by `apps/api`'s runtime code and never
  ships in either production build (`apps/api`'s esbuild bundle or
  `apps/web`'s Vite build).
- **Exposure conditions:** the vulnerability is in esbuild's own
  *development server* (`esbuild serve`) accepting cross-origin requests.
  Nothing in this repository's scripts invokes `esbuild serve` for any of
  drizzle-kit's bundled copies — drizzle-kit uses esbuild internally only to
  transpile its own config/schema files on the fly, not to run a server.
- **Available remediation:** a `pnpm.overrides` entry forcing `esbuild` to
  `>=0.25.0` inside drizzle-kit's dependency tree specifically. Technically
  possible; not applied this pass (see below).
- **Existing mitigation:** none needed beyond the exposure conditions above
  — the vulnerable code path (the dev server) is never invoked.
- **Recommended decision:** **accept temporarily**, dev-tool-only and
  dev-server-only exposure, real-world risk assessed as low; revisit at the
  next scheduled `drizzle-kit` upgrade rather than forcing an override into
  a dependency tree drizzle-kit's own maintainers have not tested against
  (an untested override carries its own small risk of breaking
  `drizzle-kit generate`/`push`, which this PR's CI fix now depends on
  working correctly).
- **Proposed review/expiry date:** at the next `drizzle-kit` minor/major
  version bump, or 180 days from this report's date, whichever comes first.

## Summary for the PR decision

- The low-severity `esbuild` finding (`apps/api`'s own direct dependency) is
  fully fixed, fully verified, and packaged as a ready-to-apply patch —
  blocked from landing only by this session's lack of git push access, not
  by any open risk decision.
- The 2 high-severity `xlsx` findings and the 1 moderate transitive
  `esbuild` finding each have a structured decision record above, with a
  recommended interim decision (accept temporarily, with a named review
  date) and named alternatives. **Claude has not accepted either risk on
  the repository's behalf** — a human owner needs to record a decision
  against each before this PR can be treated as fully risk-closed, even
  once the CI and esbuild patches above are applied.
