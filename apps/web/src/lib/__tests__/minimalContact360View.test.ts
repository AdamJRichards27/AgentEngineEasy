import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Link } from "wouter";
import type { GrowContactability } from "../contactability";
import {
  buildMinimalContactModel,
  formatContactDate,
  selectContact360View,
  type Contact360Input,
} from "../../minimal/minimalContactModel";
import { MinimalContact360View, MinimalContactMessage } from "../../minimal/MinimalContact360";

// Component tests render the presentational components as plain function calls
// and walk the returned element tree (no DOM, no network), the same approach
// as the other behaviour tests in this folder.

interface El { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!node || typeof node !== "object") return "";
  return text((node as El).props?.children);
}
function all(node: unknown, pred: (e: El) => boolean): El[] {
  if (Array.isArray(node)) return node.flatMap((c) => all(c, pred));
  if (!node || typeof node !== "object") return [];
  const e = node as El;
  return (pred(e) ? [e] : []).concat(all(e.props?.children, pred));
}
const links = (tree: unknown) => all(tree, (e) => e.type === Link).map((e) => String(e.props?.href));

const contactability = {
  evaluatedAt: "2026-10-19T00:00:00Z",
  status: "REVIEW_REQUIRED",
  statusReasonCode: "NO_CONSENT",
  hasConsentRecords: false,
  awaitingPolicyApproval: true,
  policies: [],
  channels: [],
  activeSuppressions: [],
  history: [],
  historyTruncated: false,
} as unknown as GrowContactability;

const full: Contact360Input = {
  contact: { id: 9, displayName: "Ada Allow", email: "ada@example.com", mobile: "0400 000 001" },
  roles: ["Buyer", "PastClient"],
  properties: [
    { relationshipId: 1, propertyId: 3, propertyAddress: "18 Campbell St", relationshipType: "Owner", status: "Active", isPrimary: true },
    { relationshipId: 3, propertyId: null, propertyAddress: null, relationshipType: "Prospect", status: "Active", isPrimary: false },
  ],
  opportunities: [{ id: 1, status: "Open", stage: "New", opportunityType: "Listing" }],
  activities: [{ id: 3, activityType: "note", occurredAt: "2026-10-03T00:00:00Z", summary: "Prefers morning calls" }],
  intelligence: { nextFollowUpAt: "2026-10-25T00:00:00Z", nextFollowUpDescription: "Send appraisal", daysSinceLastInteraction: 0 },
  contactability,
};
const empty: Contact360Input = {
  contact: { id: 10, displayName: "  ", email: null, mobile: null },
  roles: [],
  properties: [],
  opportunities: [],
  activities: [],
  intelligence: { nextFollowUpAt: null, nextFollowUpDescription: null, daysSinceLastInteraction: null },
};

test("renders header, details, properties, notes and consent headline from the payload", () => {
  const tree = MinimalContact360View({ model: buildMinimalContactModel(full) });
  const t = text(tree);
  for (const s of ["Ada Allow", "AA", "Buyer", "PastClient", "ada@example.com", "0400 000 001", "Today", "Send appraisal", "18 Campbell St", "Prefers morning calls", "Contactability", "Not linked to a property"]) {
    assert.ok(t.includes(s), s);
  }
  assert.ok(all(tree, (e) => e.props?.["data-ae-contact"] === "minimal").length === 1);
});

test("missing data renders explicit empty states, never invented values", () => {
  const t = text(MinimalContact360View({ model: buildMinimalContactModel(empty) }));
  for (const s of ["Unnamed contact", "Not recorded", "No interaction recorded", "None scheduled", "No active property links.", "No notes recorded."]) {
    assert.ok(t.includes(s), s);
  }
  assert.equal(t.includes("Contactability"), false);
  assert.equal(t.includes("Roles"), false);
});

test("notes and communication preferences are display only: no inputs, buttons, forms or preference field", () => {
  const tree = MinimalContact360View({ model: buildMinimalContactModel(full) });
  assert.equal(all(tree, (e) => ["input", "textarea", "select", "form", "button"].includes(String(e.type))).length, 0);
  assert.ok(text(tree).includes("Notes are read-only here."));
  assert.equal(/communication preference/i.test(text(tree)), false);
});

test("navigation: back to Today, property links, and the full record escape hatch", () => {
  const l = links(MinimalContact360View({ model: buildMinimalContactModel(full) }));
  assert.deepEqual(l, ["/grow", "/properties/3", "/grow/contacts/9?view=full"]);
});

test("error and not-found states render a message with a way back", () => {
  const tree = MinimalContactMessage({ text: "That couldn't be found — it may have been removed." });
  assert.ok(text(tree).includes("couldn't be found"));
  assert.deepEqual(links(tree), ["/grow"]);
  assert.equal(all(MinimalContactMessage({ text: "x", onRetry: () => {} }), (e) => e.type === "button").length, 1);
});

test("flag-off behaviour: classic Grow is selected unless the Minimal shell is on and not asking for the full view", () => {
  assert.equal(selectContact360View(false, ""), "classic");
  assert.equal(selectContact360View(false, "view=full"), "classic");
  assert.equal(selectContact360View(true, ""), "minimal");
  assert.equal(selectContact360View(true, "?compose=email"), "minimal");
  assert.equal(selectContact360View(true, "view=full"), "classic");
  assert.equal(selectContact360View(true, "?view=full"), "classic");
});

test("route wiring: lazy, gated by the same shell flag as Today, classic kept; view makes one GET and no storage", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  const view = readFileSync(new URL("../../minimal/MinimalContact360.tsx", import.meta.url), "utf8");
  assert.match(app, /lazy\(\(\) => import\("\.\/minimal\/MinimalContact360"\)\)/);
  assert.match(app, /selectContact360View\(minimalShell, search\) === "minimal" \? <MinimalContact360 \/> : <Grow \/>/);
  assert.match(app, /const minimalShell = shouldRenderMinimalShell\(useMinimalUx\(\)\)/);
  assert.deepEqual(view.match(/apiFetch\(/g), ["apiFetch("]);
  assert.match(view, /apiFetch\(`\/grow\/contacts\/\$\{partyId\}`\)/);
  for (const banned of ["localStorage", "sessionStorage", "method:", "useMutation"]) assert.equal(view.includes(banned), false, banned);
});

test("Grow.tsx imports the extracted types and no longer declares them", () => {
  const grow = readFileSync(new URL("../../pages/Grow.tsx", import.meta.url), "utf8");
  assert.match(grow, /from "\.\.\/lib\/growContact360"/);
  assert.equal(/^interface GrowContact360/m.test(grow), false);
});

test("dates use fixed en-AU wording, never the browser locale, and bad dates do not throw", () => {
  assert.equal(formatContactDate("2026-10-25T12:00:00Z"), "25 Oct 2026");
  assert.equal(formatContactDate("not-a-date"), "Unknown date");
  const t = text(MinimalContact360View({ model: buildMinimalContactModel(full) }));
  assert.ok(t.includes("25 Oct 2026"));
});
