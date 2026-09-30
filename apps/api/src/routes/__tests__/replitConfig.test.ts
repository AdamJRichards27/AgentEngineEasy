// G1 — .replit must activate Corepack pnpm 8.15.5 and must not carry a
// FixConfig workflow or a self-overwrite. String checks only; no TOML parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const replit = readFileSync(new URL("../../../../../.replit", import.meta.url), "utf8");

function lineStarting(prefix: string): string {
  const line = replit.split("\n").find((entry) => entry.startsWith(prefix));
  assert.ok(line, `missing .replit line starting with ${prefix}`);
  return line;
}

test(".replit pins pnpm 8.15.5, keeps Node 24, and has no FixConfig", () => {
  assert.equal(replit.includes("FixConfig"), false);
  assert.equal(replit.includes("> .replit"), false);
  assert.equal(replit.includes("base64"), false);
  assert.match(replit, /modules = \["nodejs-24"\]/);
  assert.match(replit, /packages = \["nodejs_24"\]/);
  assert.match(replit, /runButton = "Project"/);
  assert.match(lineStarting('run = "'), /pnpm@8\.15\.5/);
  assert.match(lineStarting("build = "), /pnpm@8\.15\.5/);
});
