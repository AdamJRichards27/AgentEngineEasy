import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Security & Observability Hardening (Agent Engine 2.0 — Step 2, Part A).
//
// Repo-check preventing console.* from being silently reintroduced into a
// production request/processing path. AgentEngineEasy's production code
// (routes, middlewares, domain services, background processors) must use
// the structured logger (`import { logger } from "@aee/events"`), which
// auto-attaches correlationId and applies redaction — a bare console.*
// call bypasses both. This test fails the build the moment a new
// console.log/error/warn/info/debug call appears anywhere under
// apps/api/src that isn't explicitly allowlisted below as known,
// deliberately-retained developer/operator tooling.
//
// To add a legitimate new console.* site (a CLI script, a one-off
// migration/backfill tool never invoked from a request path), add its
// exact relative path to ALLOWLISTED_FILES with a one-line reason —
// silently expanding this list is itself a reviewable diff, which is the
// point.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "..");

// Relative to apps/api/src.
const ALLOWLISTED_FILES = new Set<string>([
  // Manual, developer-invoked performance-check script (see its own header
  // comment) — never imported by the running API, not part of any request
  // or background-processing path.
  "lib/import/__tests__/perf-check.ts",
  // One-off legacy-data backfill CLI (`pnpm --filter @aee/api exec tsx
  // src/scripts/reconcileLegacyCommissions.ts`) — an operator-run script,
  // not part of the running server.
  "scripts/reconcileLegacyCommissions.ts",
]);

// Directories under apps/api/src that are allowed to use console.* freely
// (test files assert against real behaviour, not against log output, and
// are never part of a running production process).
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

test("no bare console.* calls in apps/api production source (outside the explicit allowlist)", () => {
  const files: string[] = [];
  collectSourceFiles(SRC_ROOT, files);

  const violations: string[] = [];
  for (const file of files) {
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
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
    const full = path.join(SRC_ROOT, relative);
    assert.doesNotThrow(() => statSync(full), `Allowlisted file no longer exists: ${relative}`);
  }
});
