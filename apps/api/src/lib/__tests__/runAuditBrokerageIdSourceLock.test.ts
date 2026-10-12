// R-F39 source lock. Every Run audit write in the files listed below must
// pass brokerageId. The check is textual and deliberately small: it finds
// each logAudit( or insert(auditLogs) call, takes the object literal that
// follows, and requires a brokerageId property (brokerageId: ... or the
// shorthand property). Strings and comments are ignored so a mention inside
// updatedValue or a note cannot satisfy the check.
//
// Intentional exceptions: none. Every site in these files has a tenant
// already in scope (the caller's brokerageId, the loaded property or plan,
// or the document-version brokerage already passed into storage). A site
// that genuinely has no tenant would be listed in INTENTIONAL_OMISSIONS
// with a reason and left NULL. Do not add an omission to make a new write
// pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const LOCKED_FILES = [
  "lib/transactions.ts",
  "lib/transactionConditions.ts",
  "lib/offers.ts",
  "lib/goLive.ts",
  "lib/launch/model.ts",
  "routes/aml.ts",
  "routes/documents.ts",
  "lib/documents.ts",
  "lib/documentStorage.ts",
  "routes/properties.ts",
  "lib/pitCrew/assignment.ts",
  "lib/automation/tasks.ts",
  "lib/automation/attentionItems.ts",
];

const INTENTIONAL_OMISSIONS: Array<{ file: string; line: number; reason: string }> = [];

function objectLiteralAfter(source: string, start: number): string {
  let depth = 0;
  let inString: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced object literal");
}

function stripStringsAndComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/`(?:\\.|[^`])*`/g, "\"\"")
    .replace(/'(?:\\.|[^'])*'/g, "\"\"")
    .replace(/"(?:\\.|[^"])*"/g, "\"\"");
}

function hasBrokerageIdProperty(objectLiteral: string): boolean {
  const stripped = stripStringsAndComments(objectLiteral);
  return /(?:^|[{,]\s*)brokerageId\s*(?::|,|\})/.test(stripped);
}

test("every locked Run audit write passes brokerageId", () => {
  const omissions = new Set(INTENTIONAL_OMISSIONS.map((item) => `${item.file}:${item.line}`));
  const missing: string[] = [];
  let calls = 0;

  for (const file of LOCKED_FILES) {
    const source = readFileSync(path.join(API_SRC, file), "utf8");
    for (const token of ["logAudit(", "insert(auditLogs)"]) {
      let from = 0;
      while (true) {
        const idx = source.indexOf(token, from);
        if (idx < 0) break;
        from = idx + token.length;
        const line = source.slice(0, idx).split("\n").length;
        // A comment that merely names logAudit() is not a write. A real
        // logAudit write opens an object literal. insert(auditLogs) writes
        // through .values({ ... }).
        const brace =
          token === "logAudit("
            ? source.slice(idx + token.length).search(/\S/) === 0 && source[idx + token.length] === "{"
              ? idx + token.length
              : -1
            : source.indexOf(".values(", idx);
        if (brace < 0) continue;
        const objectStart = token === "logAudit(" ? brace : source.indexOf("{", brace);
        if (objectStart < 0 || (token === "logAudit(" && source[objectStart] !== "{")) continue;
        const body = objectLiteralAfter(source, objectStart);
        calls += 1;
        const key = `${file}:${line}`;
        if (!omissions.has(key) && !hasBrokerageIdProperty(body)) {
          missing.push(`${key} ${token}`);
        }
      }
    }
  }

  assert.ok(calls >= 70, `expected the locked files to contain the known Run audit writes, found ${calls}`);
  assert.deepEqual(missing, []);
  assert.deepEqual(INTENTIONAL_OMISSIONS, []);
});
