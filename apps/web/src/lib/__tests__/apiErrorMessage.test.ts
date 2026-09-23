import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ApiError, apiErrorMessage } from "../api";

// G-5 — `as ApiError` reads `.friendly` as undefined when the failure is not
// an ApiError, and React renders that as the word "undefined". apiErrorMessage
// is the one narrowing those screens share with Grow.tsx.

const FALLBACK = "Something went wrong. Try again.";

test("apiErrorMessage keeps an ApiError's friendly sentence", () => {
  const error = new ApiError(409, "Already actioned.");
  assert.equal(apiErrorMessage(error, FALLBACK), "Already actioned.");
  assert.notEqual(apiErrorMessage(error, FALLBACK), FALLBACK);
});

test("apiErrorMessage uses a defined fallback for a plain Error", () => {
  const message = apiErrorMessage(new Error("socket hang up"), FALLBACK);
  assert.equal(message, FALLBACK);
  assert.notEqual(message, "undefined");
  assert.ok(message.length > 0);
});

test("apiErrorMessage uses a defined fallback for a thrown string", () => {
  const message = apiErrorMessage("network down", FALLBACK);
  assert.equal(message, FALLBACK);
  assert.notEqual(message, "undefined");
  assert.ok(message.length > 0);
});

test("apiErrorMessage uses the fallback for a blank friendly string and for non-errors", () => {
  assert.equal(apiErrorMessage(new ApiError(500, "   "), FALLBACK), FALLBACK);
  assert.equal(apiErrorMessage(null, FALLBACK), FALLBACK);
  assert.equal(apiErrorMessage(undefined, FALLBACK), FALLBACK);
  assert.notEqual(apiErrorMessage(undefined, FALLBACK), "undefined");
});

const WEB_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function productionSources(dir: string, files: string[]) {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) productionSources(full, files);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) files.push(full);
  }
}

// Block comments (including JSX comments) keep their newlines so a hit can
// name a line. Line comments are cut, but `https://` is not a comment.
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("production web sources do not cast a failure as ApiError", () => {
  const files: string[] = [];
  productionSources(WEB_SRC, files);
  const hits: string[] = [];
  for (const file of files) {
    const stripped = stripComments(readFileSync(file, "utf8"));
    stripped.split("\n").forEach((line, index) => {
      if (/\bas\s+ApiError\b/.test(line)) {
        hits.push(`${path.relative(WEB_SRC, file)}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(hits, []);
});
