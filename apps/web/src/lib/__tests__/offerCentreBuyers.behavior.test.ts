// #34 slice 4 — read-only Buyers tab in the Offer Centre over
// GET /api/offers/buyers. Locks the request path, the names-only view
// whitelist, the rendered list (property links, paging, no PII, no actions),
// and that the page offers an Offers/Buyers tab switch.
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

const RAW = {
  linkId: 5,
  partyId: 9,
  buyerName: "Amy Buyer",
  propertyId: 42,
  propertyAddress: "1 Buyer St, Testville",
  linkedAt: "2026-10-19T00:00:00.000Z",
  offerCount: 3,
  email: "amy@example.com",
  mobile: "0411111111",
  residentialAddress: "9 Home Rd",
};

test("buildBuyerListPath: property filter and paging", async () => {
  const { buildBuyerListPath, OFFER_CENTRE_PAGE_SIZE } = await lib();
  assert.equal(buildBuyerListPath({ propertyId: "", page: 0 }), `/offers/buyers?limit=${OFFER_CENTRE_PAGE_SIZE}&offset=0`);
  const qs = new URLSearchParams(buildBuyerListPath({ propertyId: "42", page: 1 }).split("?")[1]);
  assert.equal(qs.get("propertyId"), "42");
  assert.equal(qs.get("offset"), String(OFFER_CENTRE_PAGE_SIZE));
});

test("toBuyerView keeps names-only whitelist", async () => {
  const { toBuyerView } = await lib();
  assert.deepEqual(Object.keys(toBuyerView(RAW as never)).sort(), ["buyerName", "linkId", "linkedAt", "offerCount", "propertyAddress", "propertyId"]);
});

test("BuyerList renders names and property links, no PII, no actions", async () => {
  const { BuyerList } = await page();
  const { toBuyerView } = await lib();
  const html = renderToStaticMarkup(inRouter(createElement(BuyerList, { rows: [toBuyerView(RAW as never)], total: 1, limit: 25, offset: 0 })));
  assert.match(html, /Amy Buyer/);
  assert.match(html, /href="\/properties\/42"/);
  assert.match(html, /1 Buyer St, Testville/);
  assert.match(html, /<th>Offers<\/th>/);
  assert.match(html, /<td>3<\/td>/);
  assert.match(html, /Showing 1–1 of 1/);
  assert.equal(/amy@example\.com|0411111111|9 Home Rd/.test(html), false);
  assert.equal(/<button[^>]*>(Accept|Decline|Withdraw|Delete|Edit)/.test(html), false);
});

test("BuyerList empty state", async () => {
  const { BuyerList } = await page();
  const html = renderToStaticMarkup(inRouter(createElement(BuyerList, { rows: [], total: 0, limit: 25, offset: 0 })));
  assert.match(html, /No buyers match these filters\./);
});

test("OfferCentre page has Offers and Buyers tabs and reads /offers/buyers via the lib", () => {
  const src = readFileSync(new URL("../../pages/OfferCentre.tsx", import.meta.url), "utf8");
  assert.match(src, />\s*Offers\s*</);
  assert.match(src, />\s*Buyers\s*</);
  assert.ok(src.includes("fetchBuyerList("), "Buyers tab must use fetchBuyerList");
});
