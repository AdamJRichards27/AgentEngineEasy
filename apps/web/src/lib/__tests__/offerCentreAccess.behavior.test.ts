// Owner t165u — browser-side /offers access check. The API gates stay
// authoritative; these tests lock the client rule and that a denied or
// loading viewer never mounts the Offer Centre content (so never fetches).
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { canAccessOfferCentre, offerCentreGateState } from "../offerCentreAccess";
import { buildProductNavLinks } from "../productNav";

const RUN = ["grow.access", "run.access"];
const GROW_ONLY = ["grow.access"];

async function page() {
  return (await import("../../pages/OfferCentre")) as typeof import("../../pages/OfferCentre");
}

test("canAccessOfferCentre: run.access plus Agent or Brokerage Administrator only", () => {
  assert.equal(canAccessOfferCentre("Agent", RUN), true);
  assert.equal(canAccessOfferCentre("Brokerage Administrator", RUN), true);
  assert.equal(canAccessOfferCentre("Pit Crew", RUN), false);
  assert.equal(canAccessOfferCentre(undefined, RUN), false);
  assert.equal(canAccessOfferCentre("Unknown", RUN), false);
  assert.equal(canAccessOfferCentre("Agent", GROW_ONLY), false);
  assert.equal(canAccessOfferCentre("Brokerage Administrator", []), false);
});

test("offerCentreGateState fails closed while loading and for a missing user", () => {
  assert.equal(offerCentreGateState({ loading: true, role: "Agent", entitlements: RUN }), "loading");
  assert.equal(offerCentreGateState({ loading: false, role: undefined, entitlements: [] }), "denied");
  assert.equal(offerCentreGateState({ loading: false, role: "Pit Crew", entitlements: RUN }), "denied");
  assert.equal(offerCentreGateState({ loading: false, role: "Agent", entitlements: RUN }), "allowed");
});

test("the page guard and the nav entry use the same rule", () => {
  for (const role of ["Agent", "Brokerage Administrator", "Pit Crew", "Unknown", undefined]) {
    for (const entitlements of [RUN, GROW_ONLY]) {
      const inNav = buildProductNavLinks({ role, entitlements }).some((l) => l.path === "/offers");
      assert.equal(inNav, canAccessOfferCentre(role, entitlements), `${role} ${entitlements.join(",")}`);
    }
  }
});

test("OfferCentreGate: denied shows Not available and never mounts the content", async () => {
  const { OfferCentreGate } = await page();
  const Content = () => {
    throw new Error("Offer Centre content must not mount for a denied viewer");
  };
  const html = renderToStaticMarkup(createElement(OfferCentreGate, { state: "denied" }, createElement(Content)));
  assert.match(html, /Not available/);
  assert.match(html, /only available to Agents and Brokerage Administrators/);
  assert.doesNotMatch(html, /<table/);
});

test("OfferCentreGate: loading renders a placeholder and never mounts the content", async () => {
  const { OfferCentreGate } = await page();
  const Content = () => {
    throw new Error("Offer Centre content must not mount while loading");
  };
  const html = renderToStaticMarkup(createElement(OfferCentreGate, { state: "loading" }, createElement(Content)));
  assert.match(html, /Loading/);
});

test("OfferCentreGate: allowed renders the content", async () => {
  const { OfferCentreGate } = await page();
  const html = renderToStaticMarkup(createElement(OfferCentreGate, { state: "allowed" }, createElement("p", null, "offer-centre-body")));
  assert.match(html, /offer-centre-body/);
});
