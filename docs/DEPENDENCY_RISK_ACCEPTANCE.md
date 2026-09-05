# Dependency risk acceptance — Agent Engine 2.0, Step 2 closure (Part F)

## Scope and instruction

This closure pass was directed to re-audit the two dependency families
already named as open findings elsewhere in this PR (`xlsx`, `esbuild`),
fix only what is genuinely safe to fix, and for anything that cannot be
safely fixed, produce a formal risk-acceptance record rather than
self-accepting the risk. Claude is not authorized to accept a dependency
risk on the repository's behalf — the items below marked **PENDING HUMAN
RISK ACCEPTANCE** require a named human owner's sign-off before this PR
(or a future one) can treat them as closed.

## Re-audit results

`pnpm audit` was re-run against the current lockfile. It reports 5
findings, resolving to 4 distinct advisories across 2 packages:

| Severity | Package | Advisory | Vulnerable | Patched | Where it comes from |
|---|---|---|---|---|---|
| high | xlsx | Prototype Pollution in SheetJS ([GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)) | <0.19.3 | **none published** | `apps/api` direct dependency, `xlsx@0.18.5` |
| high | xlsx | SheetJS ReDoS ([GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)) | <0.20.2 | **none published** | `apps/api` direct dependency, `xlsx@0.18.5` |
| moderate | esbuild | Dev-server allows any site to read/send requests ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) | ≤0.24.2 | ≥0.25.0 | Transitive, entirely inside `packages/db > drizzle-kit@0.30.6`'s own dependency tree (two separate paths through it) |
| low | esbuild | Dev-server path traversal / arbitrary file read on Windows ([GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr)) | ≥0.27.3 <0.28.1 | ≥0.28.1 | `apps/api`'s own direct devDependency (`esbuild@0.27.7`), and transitively via `apps/web`'s `vite`/`@vitejs/plugin-react` |

## What was fixed (verified locally; see "Why this isn't pushed" below)

The **low**-severity esbuild finding has a real, safe fix: `apps/api`'s
`package.json` pins `"esbuild": "^0.27.0"`, and the vulnerable range is
`>=0.27.3 <0.28.1`. Bumping the declared range to `^0.28.1` and running
`pnpm install` resolves both `apps/api`'s own devDependency and (via
normal pnpm hoisting/deduplication) `apps/web`'s transitive copy pulled in
through `vite`.

This was verified, not just attempted:
- `pnpm install` after the bump completed cleanly (no dependency
  resolution conflicts).
- `pnpm --filter @aee/api run build` — succeeds, same output shape
  (`dist/index.mjs`, 1.0mb).
- `pnpm --filter @aee/api run typecheck` — clean.
- `pnpm --filter @aee/web run build` — succeeds (Vite production build,
  111 modules, same output shape).
- `pnpm audit` after the bump: **the low-severity finding is gone** —
  audit output drops from 5 findings (1 low, 2 moderate, 2 high) to 4 (2
  moderate, 2 high).

This is a devDependency-only, build-tool-only change. `esbuild` is never
part of the runtime bundle it produces (`--packages=external` in
`apps/api`'s own build script), and the specific vulnerability (path
traversal via esbuild's *development* server, Windows-only) does not
apply to how this repository actually invokes esbuild (`esbuild ...
--outfile=...`, a one-shot build command — not `esbuild serve`) — so this
fix is genuinely low-risk on top of being narrow in scope.

## What was not fixed, and why (PENDING HUMAN RISK ACCEPTANCE)

**xlsx — both high-severity findings.** No fix exists to accept or
reject: both advisories report `"patched_versions": "<0.0.0"`, meaning the
xlsx registry package has never published a version that resolves either
CVE. The only paths off this advisory are (a) migrating off `xlsx` to a
different spreadsheet-parsing library, or (b) pulling from SheetJS's own
non-npm CDN distribution channel (outside this repository's normal
dependency-management flow, and outside what this bounded closure pass
should decide unilaterally). `xlsx` is a direct `apps/api` dependency,
almost certainly backing a real product feature (spreadsheet import,
given `apps/api/src/lib/import/`'s existence) — removing or replacing it
is a functional change with real product impact, not a narrow security
patch, and is explicitly out of scope for this closure pass to decide.

**Requires a named human owner to choose one of:**
1. Accept the risk as-is (both are parsing-time vulnerabilities —
   prototype pollution and ReDoS — triggered by processing an
   attacker-supplied spreadsheet file; if this repository's import
   pathway already validates/limits uploaded file size and processes
   files in a way that bounds worst-case impact, that materially changes
   the real-world risk and should be part of this decision, not assumed
   here).
2. Scope and schedule a migration off `xlsx` to an actively-maintained
   alternative, as its own tracked piece of work — not a security patch.
3. Adopt SheetJS's own patched distribution channel outside npm, if that
   is an acceptable supply-chain trade-off for this organisation.

**esbuild — the remaining moderate finding.** This one is transitive,
entirely inside `packages/db > drizzle-kit@0.30.6`'s own dependency tree
(via `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils`, and via
`esbuild-register`) — this repository does not depend on `esbuild`
directly for this path at all, and cannot pin around it without
overriding a version deep inside a third-party tool's own dependency
graph (drizzle-kit is a dev-only CLI, never shipped or run in
production). A `pnpm.overrides` entry forcing a newer `esbuild` into
drizzle-kit's tree is technically possible but was not attempted here:
drizzle-kit is actively maintained and has fixed similar transitive
advisories in past releases, so the lower-risk path is almost certainly
waiting for (or explicitly requesting) a drizzle-kit upgrade that carries
a newer `esbuild`, not force-overriding a version drizzle-kit itself
never tested against. This is a dev-tool-only exposure (the vulnerable
behavior is esbuild's *own development server*, which nothing in this
repository's scripts invokes for drizzle-kit's bundled copies) — real-world
risk is low, but this pass is not self-accepting it.

**Requires a named human owner to choose one of:**
1. Accept the risk as low-real-world-impact (dev-tool-only, dev-server-only
   vulnerability, never reachable in this repository's actual usage) and
   revisit at the next scheduled `drizzle-kit` upgrade.
2. Add a `pnpm.overrides` entry forcing `esbuild` to `>=0.25.0` inside
   drizzle-kit's tree now, accepting the (small, but non-zero, since it's
   untested by drizzle-kit's own maintainers) risk of an override
   mismatch, in exchange for closing the advisory immediately.

## Why the fixed (low-severity) change isn't pushed to this branch yet

The verified fix above (`apps/api/package.json`'s `esbuild` range bump)
requires `pnpm-lock.yaml` to be regenerated and committed alongside it —
otherwise `pnpm install --frozen-lockfile` (used by CI) would fail on a
lockfile/manifest mismatch, trading one CI problem for another. The
regenerated `pnpm-lock.yaml` is ~92KB. This closure pass independently
confirmed (documented in full in `docs/CI_SCHEMA_DRIFT_FIX.md`'s own "Why
this fix is not yet on the branch" section) that transmitting file content
substantially smaller than this — a 53KB/2,000-line test slice — through
this session's available push tools is unreliable: only 23% of that test
content was faithfully reproduced before truncating. Given that
demonstrated failure at a smaller size than this lockfile, pushing a
~92KB `pnpm-lock.yaml` was judged very likely to fail the same way, and
was not attempted, rather than risk landing a corrupted lockfile on the
branch (which would break `pnpm install --frozen-lockfile` for every
future contributor and CI run — a strictly worse outcome than leaving the
low-severity finding open one more pass).

**To actually apply this fix:** from a real local clone with normal git
push access, change `apps/api/package.json`'s `"esbuild": "^0.27.0"` to
`"esbuild": "^0.28.1"`, run `pnpm install` (regenerates the lockfile),
run `pnpm --filter @aee/api run build && pnpm --filter @aee/api run
typecheck && pnpm --filter @aee/web run build` to confirm (all three are
expected to succeed unchanged, per the verification already performed
above), and commit both files together.

## Summary for Section 15 / PR decision purposes

- 1 of 4 advisories (low, esbuild) has a fully verified, safe fix —
  prepared, verified, but not yet pushed (tooling limitation, not a risk
  decision).
- 2 of 4 advisories (both high, xlsx) have no available fix at all and
  require a named human owner's risk-acceptance decision among the three
  options above.
- 1 of 4 advisories (moderate, esbuild, dev-tool-only transitive) has a
  possible but non-trivial fix (an override into a third party's own
  dependency tree) and also requires a named human owner's decision
  between accepting the low real-world risk or forcing an unverified
  override.
- **Claude has not accepted any of these three remaining risks on the
  repository's behalf.** This section is the risk-acceptance record the
  governing instruction required; a human decision-maker still needs to
  act on it.
