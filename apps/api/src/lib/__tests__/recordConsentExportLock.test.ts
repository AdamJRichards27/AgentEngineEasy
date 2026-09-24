import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A-11 — one bare name, one writer.
//
// lib/communications/consent.ts exports recordConsent for legacy Comms Hub
// destination consent (communication_consent). Grow channel-consent capture
// is captureConsentState in lib/consentControlsPersistence.ts
// (grow_contact_channel_consents). A short alias
// `export const recordConsent = captureConsentState` made the two writers
// share a name. This lock fails if that collision comes back, including via
// `export { captureConsentState as recordConsent }`.
//
// Comments are stripped the same way as the F-7 cold-threshold lock, so a
// comment that names the collision does not count as an export.

function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function exportedNames(source: string): string[] {
  const code = stripComments(source);
  const names: string[] = [];

  for (const match of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) {
    names.push(match[1]);
  }
  for (const match of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)/g)) {
    names.push(match[1]);
  }
  for (const match of code.matchAll(/export\s+default\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) {
    names.push(match[1]);
  }
  for (const block of code.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const spec of block[1].split(",")) {
      const trimmed = spec.trim().replace(/^type\s+/, "");
      if (!trimmed) continue;
      const alias = trimmed.match(/^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$/);
      if (alias) {
        names.push(alias[2]);
        continue;
      }
      const id = trimmed.match(/^([A-Za-z0-9_]+)$/);
      if (id) names.push(id[1]);
    }
  }
  return names;
}

function readApiSource(relativeFromLib: string): string {
  return readFileSync(new URL(relativeFromLib, import.meta.url), "utf8");
}

const COMMS_CONSENT = "../communications/consent.ts";
const GROW_PERSISTENCE = "../consentControlsPersistence.ts";

test("A-11 — only the Comms Hub module exports a bare recordConsent", () => {
  const comms = exportedNames(readApiSource(COMMS_CONSENT));
  const grow = exportedNames(readApiSource(GROW_PERSISTENCE));

  assert.ok(
    comms.includes("recordConsent"),
    "lib/communications/consent.ts keeps recordConsent as the legacy Comms Hub writer",
  );
  assert.equal(
    grow.includes("recordConsent"),
    false,
    "consentControlsPersistence.ts must not export recordConsent; Grow capture is captureConsentState",
  );
  assert.ok(grow.includes("captureConsentState"), "Grow channel-consent capture stays captureConsentState");
  assert.ok(
    !(comms.includes("recordConsent") && grow.includes("recordConsent")),
    "both modules exporting recordConsent is the A-11 name collision",
  );
});

// The audit anchor (growToday.ts, pre-fix lines 173–176) said DNCR and
// suppression rows were written only on the telephony path. A-1's Grow
// consent routes already call the persistence writers. These files must not
// put that claim back. Whitespace is collapsed so a line break does not hide it.
const STALE_WRITER_CLAIM = /only writers are on the telephony path|only reachable from telephony/;

function collapsed(source: string): string {
  // Keep comment text. Drop only the markers, so a claim wrapped across
  // comment lines still matches as one sentence.
  return source
    .replace(/\/\*|\*\//g, " ")
    .replace(/\/\//g, " ")
    .replace(/^\s*\*\s?/gm, " ")
    .replace(/\s+/g, " ");
}

test("A-11 — the contactability comments no longer say telephony is the only writer", () => {
  const files = [
    "../growToday.ts",
    "../propertyIntelligence/contactability.ts",
    "../../routes/growConsent.ts",
    "../propertyIntelligence/__tests__/contactabilityOutreachPathway.test.ts",
  ];
  for (const file of files) {
    const source = collapsed(readApiSource(file));
    assert.equal(
      STALE_WRITER_CLAIM.test(source),
      false,
      `${file} still claims the consent tables' only writers are on the telephony path`,
    );
  }
});
