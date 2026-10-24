// R-05 follow-up (#34) — Offer-Centre-only en-AU dates in Australia/Brisbane,
// and a "Back to first page" control when a later page comes back empty.
// lib/financial.ts formatDate is deliberately NOT used or changed here.
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

test("formatOfferCentreDate: en-AU day month year in Australia/Brisbane", async () => {
  const { formatOfferCentreDate } = await lib();
  assert.equal(formatOfferCentreDate("2026-10-19T00:00:00.000Z"), "19 Oct 2026");
  // 15:00 UTC on 18 Oct is 01:00 on 19 Oct in Brisbane (UTC+10, no DST),
  // whatever the process or browser time zone is.
  assert.equal(formatOfferCentreDate("2026-10-18T15:00:00.000Z"), "19 Oct 2026");
  assert.equal(formatOfferCentreDate("2026-10-18T13:59:59.000Z"), "18 Oct 2026");
  // Brisbane has no daylight saving: a January instant is still UTC+10.
  assert.equal(formatOfferCentreDate("2026-01-31T14:30:00.000Z"), "1 Feb 2026");
});

test("formatOfferCentreDate: missing or invalid input is null", async () => {
  const { formatOfferCentreDate } = await lib();
  assert.equal(formatOfferCentreDate(null), null);
  assert.equal(formatOfferCentreDate(undefined), null);
  assert.equal(formatOfferCentreDate(""), null);
  assert.equal(formatOfferCentreDate("not a date"), null);
});

test("Offers and Buyers rows render dates with the Brisbane formatter", async () => {
  const { OfferCentreList, BuyerList } = await page();
  const offers = renderToStaticMarkup(
    inRouter(
      createElement(OfferCentreList, {
        rows: [{ id: 1, propertyId: 2, propertyAddress: "1 A St", buyerName: "B", offerPriceCents: 100, status: "Received", createdAt: "2026-10-18T15:00:00.000Z" }],
        total: 1, limit: 25, offset: 0,
      }),
    ),
  );
  assert.match(offers, /<td>19 Oct 2026<\/td>/);
  const buyers = renderToStaticMarkup(
    inRouter(
      createElement(BuyerList, {
        rows: [{ linkId: 1, buyerName: "B", propertyId: 2, propertyAddress: "1 A St", linkedAt: "2026-10-18T15:00:00.000Z", offerCount: 0 }],
        total: 1, limit: 25, offset: 0,
      }),
    ),
  );
  assert.match(buyers, /<td>19 Oct 2026<\/td>/);
});

test("page uses the Offer Centre formatter, not lib/financial formatDate", () => {
  const src = readFileSync(new URL("../../pages/OfferCentre.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("formatOfferCentreDate("));
  assert.equal(/\bformatDate\b/.test(src), false);
});

test("empty later page: role=status message and a Back to first page button (both lists)", async () => {
  const { OfferCentreList, BuyerList } = await page();
  const later = { rows: [], total: 30, limit: 25, offset: 25, onFirst: () => {} };
  const offers = renderToStaticMarkup(inRouter(createElement(OfferCentreList, later)));
  assert.match(offers, /role="status"[^>]*>No offers on this page\./);
  assert.match(offers, /<button type="button"[^>]*>Back to first page<\/button>/);
  const buyers = renderToStaticMarkup(inRouter(createElement(BuyerList, later)));
  assert.match(buyers, /role="status"[^>]*>No buyers on this page\./);
  assert.match(buyers, /<button type="button"[^>]*>Back to first page<\/button>/);
});

test("empty first page has no Back to first page button", async () => {
  const { OfferCentreList, BuyerList } = await page();
  const first = { rows: [], total: 0, limit: 25, offset: 0, onFirst: () => {} };
  for (const C of [OfferCentreList, BuyerList]) {
    const html = renderToStaticMarkup(inRouter(createElement(C as never, first)));
    assert.equal(/Back to first page/.test(html), false);
  }
});

test("page wires Back to first page to reset each tab's own page", () => {
  const src = readFileSync(new URL("../../pages/OfferCentre.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("onFirst={() => setPage(0)}"));
  assert.ok(src.includes("onFirst={() => setBuyerPage(0)}"));
});
