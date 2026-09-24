// I-15 code-path — property timeline labels resolve related rows by id.
//
// domainEventLabel and auditLabel used to call Array.find on eventPartyRows,
// auditParties, amlRows, and offerRows once per timeline row. riskExceptions
// was already a Map. This lock fails if those hot lookups go back to a
// linear scan. Indexes on domain_events and audit_logs are not this slice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `timeline.ts must keep ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `timeline.ts must keep ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

const LINEAR_SCAN = /\.(?:find|filter|includes|some|indexOf)\s*\(/;

const timelineSource = stripComments(readFileSync(new URL("../timeline.ts", import.meta.url), "utf8"));
const domainEventLabel = sliceBetween(timelineSource, "function domainEventLabel(", "function auditLabel(");
const auditLabel = sliceBetween(timelineSource, "function auditLabel(", "const eventItems");

test("I-15 — timeline label helpers look up related rows by id, not Array.find", () => {
  assert.doesNotMatch(
    domainEventLabel,
    LINEAR_SCAN,
    "domainEventLabel must resolve the event party with eventPartiesById.get",
  );
  assert.doesNotMatch(
    auditLabel,
    LINEAR_SCAN,
    "auditLabel must resolve parties, AML rows, and offers with Map.get",
  );
  assert.equal(domainEventLabel.split("eventPartiesById.get(").length - 1, 2);
  assert.equal(auditLabel.split("auditPartiesById.get(").length - 1, 3);
  assert.equal(auditLabel.split("amlById.get(").length - 1, 1);
  assert.equal(auditLabel.split("offersById.get(").length - 1, 1);
  assert.equal(auditLabel.split("exceptionsById.get(").length - 1, 1);
  assert.doesNotMatch(timelineSource, /\.find\s*\(/, "timeline.ts must not scan related rows with Array.find");
});

test("I-15 — related rows are indexed once before the label pass", () => {
  assert.match(timelineSource, /const eventPartiesById = indexById\(eventPartyRows\)/);
  assert.match(timelineSource, /const auditPartiesById = indexById\(auditParties\)/);
  assert.match(timelineSource, /const amlById = indexById\(amlRows\)/);
  assert.match(timelineSource, /const offersById = indexById\(offerRows\)/);
  assert.match(timelineSource, /if \(!byId\.has\(row\.id\)\) byId\.set\(row\.id, row\)/);
  assert.doesNotMatch(timelineSource, /auditPartyAddedIds\.includes\s*\(/);
  assert.match(timelineSource, /loadedAuditPartyIds\.has\(/);
});

test("I-15 — indexById keeps the first row for an id and resolves the last row in one lookup", async () => {
  // timeline.ts pulls in @aee/db, which refuses to load without DATABASE_URL.
  // This lookup does not query. Set a placeholder only when the runner has not.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgresql://127.0.0.1:5432/i15_timeline_lookup_unused";
  }
  const { indexById } = await import("../timeline.js");
  const rows = [
    { id: 1, name: "first" },
    ...Array.from({ length: 40 }, (_, index) => ({ id: index + 2, name: `row-${index + 2}` })),
    { id: 1, name: "duplicate-later" },
  ];
  const byId = indexById(rows);
  assert.equal(byId.get(1)?.name, "first");
  assert.equal(byId.get(41)?.name, "row-41");
  assert.equal(byId.get(999), undefined);
  assert.equal(byId.size, 41);
});
