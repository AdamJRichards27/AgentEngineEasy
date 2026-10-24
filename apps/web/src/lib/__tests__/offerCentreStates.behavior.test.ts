// R-05 (#34) — Offer Centre empty, error and loading states for both the
// Offers list and the Buyers tab. Locks: the region state precedence, the
// empty copy (no data at all vs nothing matching the filters), the
// accessible markup (role=status for loading/empty, role=alert + a Try again
// button for errors, aria-busy on the results region), that an error never
// shows a raw technical message or a share token, and that the page wires
// both tabs through the shared region with refetch as the retry.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { Router } from "wouter";

function inRouter(child: ReturnType<typeof createElement>) {
  return createElement(Router, { ssrPath: "/offers" }, child);
}
async function lib() {
  return (await import("../offerCentre")) as typeof import("../offerCentre");
}
async function page() {
  return (await import("../../pages/OfferCentre")) as typeof import("../../pages/OfferCentre");
}
async function api() {
  return (await import("../api")) as typeof import("../api");
}

const TOKEN = "deadbeefdeadbeefdeadbeefdeadbeef";

test("offerCentreRegionState: loading, error, empty, ready precedence", async () => {
  const { offerCentreRegionState } = await lib();
  assert.equal(offerCentreRegionState({ isLoading: true, isError: false }, undefined), "loading");
  assert.equal(offerCentreRegionState({ isLoading: false, isError: false }, undefined), "loading");
  assert.equal(offerCentreRegionState({ isLoading: false, isError: true }, undefined), "error");
  // A failed refetch over cached rows still surfaces the error.
  assert.equal(offerCentreRegionState({ isLoading: false, isError: true }, 3), "error");
  assert.equal(offerCentreRegionState({ isLoading: false, isError: false }, 0), "empty");
  assert.equal(offerCentreRegionState({ isLoading: false, isError: false }, 2), "ready");
});

test("offerCentreEmptyMessage distinguishes no data from no matches", async () => {
  const { offerCentreEmptyMessage } = await lib();
  assert.equal(offerCentreEmptyMessage("offers", true), "No offers match these filters.");
  assert.equal(offerCentreEmptyMessage("buyers", true), "No buyers match these filters.");
  assert.match(offerCentreEmptyMessage("offers", false), /^No offers yet\./);
  assert.match(offerCentreEmptyMessage("buyers", false), /^No buyers yet\./);
});

test("offerCentreErrorText: friendly ApiError text plus support reference; never the raw technical message", async () => {
  const { offerCentreErrorText } = await lib();
  const { ApiError } = await api();
  const apiErr = new ApiError(500, "Something went wrong on our side.", `boom ${TOKEN}`, undefined, { correlationId: "abcd-1234-efgh-5678" });
  const a = offerCentreErrorText(apiErr, "offers");
  assert.equal(a.message, "Something went wrong on our side.");
  assert.match(a.reference ?? "", /^Reference: abcd1234/);
  const b = offerCentreErrorText(new Error(`shareToken=${TOKEN}`), "buyers");
  assert.equal(b.message, "Couldn't load buyers. Try again.");
  assert.equal(b.reference, undefined);
  assert.equal(offerCentreErrorText("x", "offers").message, "Couldn't load offers. Try again.");
});

test("OfferCentreRegion loading: role=status, aria-busy=true, no rows", async () => {
  const { OfferCentreRegion } = await page();
  const html = renderToStaticMarkup(
    createElement(OfferCentreRegion, { kind: "offers", state: "loading", busy: true, onRetry: () => {} }, createElement("table", null)),
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /<p[^>]*role="status"[^>]*>Loading offers…<\/p>/);
  assert.equal(/<table/.test(html), false);
  const buyers = renderToStaticMarkup(createElement(OfferCentreRegion, { kind: "buyers", state: "loading", busy: true, onRetry: () => {} }));
  assert.match(buyers, /Loading buyers…/);
});

test("OfferCentreRegion error: role=alert, message, reference and a Try again button", async () => {
  const { OfferCentreRegion } = await page();
  const { ApiError } = await api();
  const error = new ApiError(503, "The service is busy. Try again shortly.", TOKEN, undefined, { correlationId: "zz99yy88xx77" });
  const html = renderToStaticMarkup(
    createElement(OfferCentreRegion, { kind: "buyers", state: "error", busy: false, error, onRetry: () => {} }, createElement("table", null)),
  );
  assert.match(html, /aria-busy="false"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /The service is busy\. Try again shortly\./);
  assert.match(html, /Reference: zz99yy88/);
  assert.match(html, /<button type="button"[^>]*>Try again<\/button>/);
  assert.equal(/<table/.test(html), false);
  assert.equal(new RegExp(TOKEN).test(html), false, "never render the technical message or a token");
});

test("OfferCentreRegion ready: renders children; aria-busy tracks a background refetch", async () => {
  const { OfferCentreRegion } = await page();
  const idle = renderToStaticMarkup(createElement(OfferCentreRegion, { kind: "offers", state: "ready", busy: false, onRetry: () => {} }, createElement("table", null)));
  assert.match(idle, /aria-busy="false"[^>]*><table/);
  const refetching = renderToStaticMarkup(createElement(OfferCentreRegion, { kind: "offers", state: "ready", busy: true, onRetry: () => {} }, createElement("table", null)));
  assert.match(refetching, /aria-busy="true"/);
  assert.equal(/role="alert"|Loading/.test(refetching), false);
});

test("OfferCentreList and BuyerList empty states are role=status and filter-aware", async () => {
  const { OfferCentreList, BuyerList } = await page();
  const none = { rows: [], total: 0, limit: 25, offset: 0 };
  const offersAll = renderToStaticMarkup(inRouter(createElement(OfferCentreList, { ...none, filtered: false })));
  assert.match(offersAll, /<p[^>]*role="status"[^>]*>No offers yet\./);
  assert.equal(/<table/.test(offersAll), false);
  const offersFiltered = renderToStaticMarkup(inRouter(createElement(OfferCentreList, { ...none, filtered: true })));
  assert.match(offersFiltered, /role="status"[^>]*>No offers match these filters\./);
  const buyersAll = renderToStaticMarkup(inRouter(createElement(BuyerList, { ...none, filtered: false })));
  assert.match(buyersAll, /role="status"[^>]*>No buyers yet\./);
  const buyersFiltered = renderToStaticMarkup(inRouter(createElement(BuyerList, { ...none, filtered: true })));
  assert.match(buyersFiltered, /role="status"[^>]*>No buyers match these filters\./);
});

test("OfferCentre page wires both tabs through OfferCentreRegion with refetch retry", () => {
  const src = readFileSync(new URL("../../pages/OfferCentre.tsx", import.meta.url), "utf8");
  assert.equal((src.match(/<OfferCentreRegion\b/g) ?? []).length, 2, "one region per tab");
  assert.match(src, /kind="offers"/);
  assert.match(src, /kind="buyers"/);
  assert.ok(/onRetry=\{\(\) => (void )?offers\.refetch\(\)\}/.test(src), "offers retry refetches its own query");
  assert.ok(/onRetry=\{\(\) => (void )?buyers\.refetch\(\)\}/.test(src), "buyers retry refetches its own query");
  assert.ok(src.includes("offerCentreRegionState("), "state comes from the tested helper");
  assert.ok(src.includes("keepPreviousData"), "paging keeps rows visible while the next page loads");
  assert.equal(/shareToken|share_token/i.test(src), false);
});
