import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Security & Observability Hardening (Agent Engine 2.0 — Step 2, Part A;
// extended for the Operational Readiness & Controlled Pilot Gate, Phase 9).
//
// Repo-check preventing console.* from being silently reintroduced into a
// production request/processing path. AgentEngineEasy's production code
// (routes, middlewares, domain services, background processors, and — as of
// the Pilot Gate pass — the packages/integrations/* provider adapters that
// apps/api depends on) must use the structured logger (`import { logger }
// from "@aee/events"`), which auto-attaches correlationId and applies
// redaction — a bare console.* call bypasses both. This test fails the
// build the moment a new console.log/error/warn/info/debug call appears
// anywhere under apps/api/src, or under any packages/integrations/*/src
// directory, that isn't explicitly allowlisted below as known,
// deliberately-retained developer/operator tooling.
//
// Why packages/integrations/* is included here, in apps/api's own test
// file, rather than getting a copy of this test in each of those packages:
// those packages are small, dependency-free-by-design leaf packages (no
// test runner of their own configured), apps/api is their only real
// consumer, and @aee/events itself has zero runtime dependencies — so
// depending on it from a provider-adapter package introduces no cycle and
// no meaningful new coupling. Duplicating this scanner into five near-empty
// packages would be more moving parts for the same guarantee. If a future
// package boundary makes that duplication worthwhile, this scanner's
// `SCAN_ROOTS` list is the only thing that needs to change.
//
// To add a legitimate new console.* site (a CLI script, a one-off
// migration/backfill tool never invoked from a request path), add its
// exact repo-relative path to ALLOWLISTED_FILES with a one-line reason —
// silently expanding this list is itself a reviewable diff, which is the
// point.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_SRC_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(API_SRC_ROOT, "..", "..", "..");
const INTEGRATIONS_ROOT = path.join(REPO_ROOT, "packages", "integrations");

function discoverIntegrationSrcRoots(): string[] {
  // Every packages/integrations/<name>/src directory, discovered rather
  // than hardcoded, so a newly-added integration package is covered by
  // this guard automatically rather than by remembering to update a list.
  if (!statSync(INTEGRATIONS_ROOT, { throwIfNoEntry: false })?.isDirectory()) return [];
  const roots: string[] = [];
  for (const entry of readdirSync(INTEGRATIONS_ROOT)) {
    const srcDir = path.join(INTEGRATIONS_ROOT, entry, "src");
    if (statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) roots.push(srcDir);
  }
  return roots;
}

// Every directory this test scans. Paths reported in failures/allowlist
// entries are relative to REPO_ROOT so both roots share one unambiguous
// naming scheme.
const SCAN_ROOTS = [API_SRC_ROOT, ...discoverIntegrationSrcRoots()];

// Repo-root-relative paths.
const ALLOWLISTED_FILES = new Set<string>([
  // Manual, developer-invoked performance-check script (see its own header
  // comment) — never imported by the running API, not part of any request
  // or background-processing path.
  "apps/api/src/lib/import/__tests__/perf-check.ts",
  // One-off legacy-data backfill CLI (`pnpm --filter @aee/api exec tsx
  // src/scripts/reconcileLegacyCommissions.ts`) — an operator-run script,
  // not part of the running server.
  "apps/api/src/scripts/reconcileLegacyCommissions.ts",
]);

// Directories anywhere under a scan root that are allowed to use console.*
// freely (test files assert against real behaviour, not against log
// output, and are never part of a running production process).
const ALLOWLISTED_DIR_SEGMENTS = new Set<string>(["__tests__"]);

const CONSOLE_CALL_PATTERN = /console\s*\.\s*(log|error|warn|info|debug|trace)\s*\(/;

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (ALLOWLISTED_DIR_SEGMENTS.has(entry)) continue;
      collectSourceFiles(full, out);
    } else if (stat.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
      out.push(full);
    }
  }
}

test("no bare console.* calls in apps/api or packages/integrations/* production source (outside the explicit allowlist)", () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) collectSourceFiles(root, files);

  const violations: string[] = [];
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    if (ALLOWLISTED_FILES.has(relative)) continue;

    const contents = readFileSync(file, "utf8");
    const lines = contents.split("\n");
    lines.forEach((line, idx) => {
      if (CONSOLE_CALL_PATTERN.test(line)) {
        violations.push(`${relative}:${idx + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Found console.* call(s) in production source outside the allowlist. Use the structured ` +
      `logger from "@aee/events" instead (it auto-attaches correlationId and applies redaction), ` +
      `or add the file to ALLOWLISTED_FILES in this test with a one-line justification if it is ` +
      `genuinely developer/operator tooling never invoked from a request path:\n` +
      violations.join("\n"),
  );
});

test("every allowlisted file still exists (allowlist doesn't silently drift from reality)", () => {
  for (const relative of ALLOWLISTED_FILES) {
    const full = path.join(REPO_ROOT, relative);
    assert.doesNotThrow(() => statSync(full), `Allowlisted file no longer exists: ${relative}`);
  }
});

test("packages/integrations/* provider-fallback logging is actually reachable by this guard (sanity check)", () => {
  // Guards against this test's own scan roots silently regressing to
  // covering zero integration packages (e.g. a refactor that moves
  // packages/integrations elsewhere) by asserting we found at least the
  // five provider packages known to exist as of the Pilot Gate pass.
  const discovered = discoverIntegrationSrcRoots();
  assert.ok(
    discovered.length >= 5,
    `Expected to discover at least 5 packages/integrations/*/src directories, found ${discovered.length}. ` +
      `If packages/integrations was intentionally restructured, update this test's expectation.`,
  );
});
