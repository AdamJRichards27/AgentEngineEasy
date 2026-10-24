// #34 slice 2 — read-only web Offer Centre over GET /api/offers/centre.
// Locks: the request path (filters + paging), the view model whitelist (no
// share token, no buyer contact details), the paging maths, and the rendered
// list (status pill, price, property link, no action buttons, no PII).
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { Router } from "wouter";

// wouter's Link reads location; render under a fixed SSR path.
function inRouter(child: ReturnType<typeof createElement>) {
  return createElement(Router, { ssrPath: "/offers" }, child);
}

async function lib() {
  return (await import("../offerCentre")) as typeof import("../offerCentre");
}
async function page() {
  return (await import("../../pages/OfferCentre")) as typeof import("../../pages/OfferCentre");
}

const RAW_ROW = {
  id: 11,
  propertyId: 42,
  propertyAddress: "1 Centre St, Testville",
  buyerPartyId: 7,
  buyerName: "Ned Buyer",
  offerPriceCents: 90_000_000,
  status: "Received",
  conditions: { conditions: "Subject to finance" },
  createdAt: "2026-10-19T00:00:00.000Z",
  // Fields a future API change might leak; the view must drop them.
  shareToken: "deadbeefdeadbeefdeadbeefdeadbeef",
  email: "ned@example.com",
  mobile: "0400000000",
};

test("buildOfferCentrePath: no filters is limit+offset only", async () => {
  const { buildOfferCentrePath, OFFER_CENTRE_PAGE_SIZE } = await lib();
  assert.equal(buildOfferCentrePath({ status: "", propertyId: "", page: 0 }), `/offers/centre?limit=${OFFER_CENTRE_PAGE_SIZE}&offset=0`);
});

test("buildOfferCentrePath: status, propertyId, and page map to the API query", async () => {
  const { buildOfferCentrePath, OFFER_CENTRE_PAGE_SIZE } = await lib();
  const path = buildOfferCentrePath({ status: "Received", propertyId: "42", page: 2 });
  const qs = new URLSearchParams(path.split("?")[1]);
  assert.equal(path.split("?")[0], "/offers/centre");
  assert.equal(qs.get("status"), "Received");
  assert.equal(qs.get("propertyId"), "42");
  assert.equal(qs.get("limit"), String(OFFER_CENTRE_PAGE_SIZE));
  assert.equal(qs.get("offset"), String(2 * OFFER_CENTRE_PAGE_SIZE));
});

test("OFFER_CENTRE_STATUSES matches the API enum", async () => {
  const { OFFER_CENTRE_STATUSES } = await lib();
  assert.deepEqual([...OFFER_CENTRE_STATUSES], ["Received", "Accepted", "Declined", "Withdrawn"]);
});

test("toOfferCentreView keeps only whitelisted fields", async () => {
  const { toOfferCentreView } = await lib();
  const view = toOfferCentreView(RAW_ROW as never);
  assert.deepEqual(Object.keys(view).sort(), ["buyerName", "createdAt", "id", "offerPriceCents", "propertyAddress", "propertyId", "status"].sort());
});

test("offerCentrePaging: range text and prev/next", async () => {
  const { offerCentrePaging } = await lib();
  assert.deepEqual(offerCentrePaging({ total: 0, limit: 25, offset: 0 }), { from: 0, to: 0, hasPrev: false, hasNext: false });
  assert.deepEqual(offerCentrePaging({ total: 60, limit: 25, offset: 0 }), { from: 1, to: 25, hasPrev: false, hasNext: true });
  assert.deepEqual(offerCentrePaging({ total: 60, limit: 25, offset: 50 }), { from: 51, to: 60, hasPrev: true, hasNext: false });
});

test("offerStatusPillClass uses the four existing pill tones", async () => {
  const { offerStatusPillClass } = await lib();
  assert.equal(offerStatusPillClass("Received"), "pill pill-warning");
  assert.equal(offerStatusPillClass("Accepted"), "pill pill-success");
  assert.equal(offerStatusPillClass("Declined"), "pill");
  assert.equal(offerStatusPillClass("Withdrawn"), "pill");
});

test("OfferCentreList renders rows read-only, with no share token or contact details", async () => {
  const { OfferCentreList } = await page();
  const { toOfferCentreView } = await lib();
  const html = renderToStaticMarkup(
    inRouter(createElement(OfferCentreList, { rows: [toOfferCentreView(RAW_ROW as never)], total: 1, limit: 25, offset: 0 })),
  );
  assert.match(html, /1 Centre St, Testville/);
  assert.match(html, /href="\/properties\/42"/);
  assert.match(html, /Ned Buyer/);
  assert.match(html, /\$900,000\.00/);
  assert.match(html, /class="pill pill-warning"[^>]*>Received/);
  assert.equal(/deadbeef|ned@example\.com|0400000000|shareToken/i.test(html), false);
  assert.equal(/<button[^>]*>(Accept|Decline|Withdraw)/.test(html), false, "no write actions");
  assert.match(html, /Showing 1–1 of 1/);
});

test("OfferCentreList empty state", async () => {
  const { OfferCentreList } = await page();
  const html = renderToStaticMarkup(inRouter(createElement(OfferCentreList, { rows: [], total: 0, limit: 25, offset: 0 })));
  assert.match(html, /No offers match these filters\./);
});
