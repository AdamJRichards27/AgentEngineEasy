import assert from "node:assert/strict";
import test from "node:test";
import {
  contactsEmptyMessage,
  growDataRegionError,
  growDataRegionState,
  growTabClickState,
  growTabLabel,
  GROW_TABS,
  type GrowWorkspaceNavState,
} from "../growWorkspace";

// AE GROW Pilot Readiness WP6b — D6 (a failed Grow data region must never look
// empty) and P3-e (the Contacts tab returns to the contact list).

const loading = { isLoading: true, isError: false };
const loaded = { isLoading: false, isError: false };
const failed = { isLoading: false, isError: true, error: new Error("boom") };

test("a data region's state is total: loading, error, empty, or ready", () => {
  assert.equal(growDataRegionState(loading, undefined), "loading");
  assert.equal(growDataRegionState(loading, 0), "loading");
  // The defect: not loading, no data (because the request failed) — this must
  // be "error", never a silent nothing and never "empty".
  assert.equal(growDataRegionState(failed, undefined), "error");
  assert.equal(growDataRegionState(failed, 0), "error");
  assert.equal(growDataRegionState({ isLoading: true, isError: true }, undefined), "error", "a failure outranks a refetch");
  assert.equal(growDataRegionState(loaded, 0), "empty");
  assert.equal(growDataRegionState(loaded, 3), "ready");
  // Settled but nothing arrived at all (e.g. a disabled query): still not a
  // claim that there is no data.
  assert.equal(growDataRegionState(loaded, undefined), "loading");
  assert.equal(growDataRegionState(loaded, null), "loading");
});

test("a region failure shows the humanised message, and a support reference only when one exists", () => {
  assert.deepEqual(growDataRegionError(new Error("TypeError: x is undefined"), "Couldn't load contacts."), {
    message: "Couldn't load contacts.",
  });
  assert.deepEqual(growDataRegionError(null, "Couldn't load contacts."), { message: "Couldn't load contacts." });
  assert.deepEqual(growDataRegionError({ status: 401, friendly: "Your session has ended — please sign in again." }, "fallback"), {
    message: "Your session has ended — please sign in again.",
  });
  assert.deepEqual(
    growDataRegionError({ status: 500, friendly: "Something went wrong on our end.", correlationId: "3f9c2a1b-7d4e-4c2a" }, "fallback"),
    { message: "Something went wrong on our end.", reference: "Reference: 3f9c2a1b" },
  );
  // humanizeApiError already appends the reference for 5xx — never twice.
  assert.deepEqual(
    growDataRegionError({ status: 500, friendly: "Something went wrong on our end. Reference: 3f9c2a1b", correlationId: "3f9c2a1b-7d4e" }, "fallback"),
    { message: "Something went wrong on our end. Reference: 3f9c2a1b" },
  );
  assert.deepEqual(growDataRegionError({ status: 0, friendly: "We couldn't reach Agent Engine." }, "fallback"), {
    message: "We couldn't reach Agent Engine.",
  }, "a network failure has no server id");
  assert.deepEqual(growDataRegionError({ friendly: "   " }, "fallback"), { message: "fallback" });
});

test("empty contacts distinguishes 'nothing matched that search' from 'no contacts at all'", () => {
  assert.match(contactsEmptyMessage(""), /No contacts yet/);
  assert.match(contactsEmptyMessage("   "), /No contacts yet/);
  assert.match(contactsEmptyMessage("Smith"), /No contacts match “Smith”/);
  assert.doesNotMatch(contactsEmptyMessage("Smith"), /No contacts yet/);
});

test("clicking the Contacts tab returns to the contact list; other tabs only switch tab", () => {
  const openContact: GrowWorkspaceNavState = { tab: "contacts", contactPartyId: 289, pendingComposeChannel: "EMAIL" };
  assert.deepEqual(growTabClickState("contacts", openContact), {
    tab: "contacts",
    contactPartyId: null,
    pendingComposeChannel: null,
  });
  // Arriving from another tab also lands on the list, never on whichever
  // contact happened to be open last.
  assert.deepEqual(growTabClickState("contacts", { tab: "today", contactPartyId: 289, pendingComposeChannel: null }), {
    tab: "contacts",
    contactPartyId: null,
    pendingComposeChannel: null,
  });
  // Leaving Contacts keeps the open contact so coming back via a Grow Today
  // card is unaffected.
  assert.deepEqual(growTabClickState("today", openContact), { tab: "today", contactPartyId: 289, pendingComposeChannel: "EMAIL" });
});

test("tab labels", () => {
  assert.equal(growTabLabel("performance"), "Performance");
  assert.equal(growTabLabel("askAE"), "Ask AE");
  assert.equal(GROW_TABS.length, 6);
});
