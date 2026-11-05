// t273u (X12): Run's property workspace shows a read-only Primary marker on
// every party row (sellers and other parties), from the isPrimary flag the
// workspace API already returns; same word as Grow desktop and the phone.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PRIMARY_MARKER_LABEL, runPartyPrimaryMarker } from "../runPartyPrimary";

const workspace = readFileSync(new URL("../../pages/PropertyWorkspace.tsx", import.meta.url), "utf8");

test("marker text follows isPrimary only", () => {
  assert.equal(PRIMARY_MARKER_LABEL, "Primary");
  assert.equal(runPartyPrimaryMarker({ isPrimary: true }), "Primary");
  assert.equal(runPartyPrimaryMarker({ isPrimary: false }), null);
  assert.equal(runPartyPrimaryMarker({ isPrimary: null }), null);
  assert.equal(runPartyPrimaryMarker({}), null);
});

test("both Run party lists render the marker (Sellers and Other parties)", () => {
  const sellers = workspace.slice(workspace.indexOf('id="workspace-sellers"'), workspace.indexOf('id="workspace-parties"'));
  const others = workspace.slice(workspace.indexOf("<h3>Other parties</h3>"), workspace.indexOf("<h3>Other parties</h3>") + 800);
  assert.match(sellers, /<RunPrimaryMarker isPrimary=\{p\.isPrimary\} \/>/);
  assert.match(others, /<RunPrimaryMarker isPrimary=\{p\.isPrimary\} \/>/);
  assert.doesNotMatch(sellers, /" \(primary\)"/, "the old seller-only text is gone");
});

test("the marker is display only: a span, no control, no request, no permission check", () => {
  const start = workspace.indexOf("export function RunPrimaryMarker");
  const body = workspace.slice(start, workspace.indexOf("\n}\n", start));
  assert.ok(start > 0);
  assert.match(body, /<span /);
  assert.doesNotMatch(body, /<button|onClick|apiFetch|useMutation|hasEntitlement|canManage/);
});
