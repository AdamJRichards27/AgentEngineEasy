// AE Minimal v1.0 V5: Market Activity map (Owner t525u items 4-6). No DOM and
// no network: views are expanded as plain function calls, Leaflet is never loaded.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Link } from "wouter";
import {
  buildMarketEventDetail,
  buildMarketRows,
  marketActivityHref,
  marketAreaChips,
  marketCountLines,
  parseMarketFilters,
  type MarketEventDto,
  type MarketFilters,
} from "../../minimal/market/minimalMarketActivityModel";
import {
  MAP_PRIVACY_NOTICE,
  OSM_ATTRIBUTION_HTML,
  OSM_ATTRIBUTION_TEXT,
  OSM_COPYRIGHT_URL,
  OSM_REPORT_ISSUE_URL,
  OSM_TILE_REFERRER_POLICY,
  OSM_TILE_URL,
  mapCoverageNote,
  marketMapPoints,
  marketViewTabs,
  osmTileLayerOptions,
} from "../../minimal/market/marketMap";
import { MarketMapSection, MinimalMarketActivityView } from "../../minimal/market/MinimalMarketActivityView";

interface El { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  const e = node as El;
  if (typeof e.type === "function" && e.type !== Link) return expand((e.type as (p: unknown) => unknown)(e.props ?? {}));
  if (e.props && "children" in e.props) return { ...e, props: { ...e.props, children: expand(e.props.children) } };
  return e;
}
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

const OWNER_NOTICE =
  "Map tiles are provided by a third-party mapping service. When you view a map, your IP address and limited technical information may be transmitted to the map provider, including servers located outside Australia.";

const base = { sourceLabel: "AE property record", suburb: "Testville", eventDate: "2026-10-21T00:00:00.000Z", recordDate: "2026-10-21T00:00:00.000Z", appraisalId: null } as const;
const MINE: MarketEventDto = { ...base, key: "listed-4", type: "justListed", label: "Just listed", address: "4 Synthetic Rd", propertyId: 4, access: "record", lat: -27.46, lng: 153.0 };
const NO_COORDS: MarketEventDto = { ...base, key: "withdrawn-5", type: "withdrawn", label: "Withdrawn", address: "5 Synthetic Rd", propertyId: 5, access: "record", lat: null, lng: null };
const PUBLIC: MarketEventDto = { ...base, key: "public-1", type: "sold", label: "Sold", address: "6 Their St", sourceLabel: "AE brokerage listing", propertyId: null, access: "public", lat: -27.44, lng: 152.98 };
const COMP: MarketEventDto = { ...base, key: "comp-9", type: "agentEvidence", label: "Nearby sold (agent-entered)", address: "9 Example St", propertyId: null, appraisalId: 12, access: "record", lat: -27.4, lng: 153.1 };
const BAD: MarketEventDto = { ...MINE, key: "listed-7", propertyId: 7, lat: 120, lng: 153 };
const EVENTS = [MINE, NO_COORDS, PUBLIC, COMP, BAD];
const W: MarketFilters = { range: "week", type: null };
const M: MarketFilters = { ...W, view: "map" };
const marketDir = path.resolve(import.meta.dirname, "../../minimal/market");
const src = (f: string) => readFileSync(path.join(marketDir, f), "utf8");

function view(filters: MarketFilters, map?: { points: ReturnType<typeof marketMapPoints>; total: number; canvas: unknown }) {
  return expand(MinimalMarketActivityView({
    filters,
    area: { chips: marketAreaChips(filters, ["Testville"], ["Testville"]), note: null },
    state: { kind: "ready", rows: buildMarketRows(EVENTS), counts: marketCountLines({ justListed: 1 }), truncated: false, detail: null, map },
  }));
}

test("V5-1 list stays the default; the map only exists on the flag-gated Market Activity page", () => {
  assert.equal(parseMarketFilters("").view, undefined);
  assert.equal(parseMarketFilters("?view=satellite").view, undefined);
  const v = view(W);
  assert.equal(all(v, (e) => e.props?.["data-mm-map"] !== undefined).length, 0, "no map section in the default list");
  assert.ok(all(v, (e) => e.props?.["aria-label"] === "Market events").length === 1, "list rendered");
  assert.deepEqual(marketViewTabs(W).map((t) => [t.label, t.current]), [["List", true], ["Map", false]]);
  const c = src("MinimalMarketActivity.tsx");
  assert.match(c, /isFeatureHiddenError\(q\.error\)\) return <Redirect to="\/grow" replace \/>/, "flag off: whole page (map included) redirects");
  assert.match(c, /map: filters\.view === "map" \? mapState\(data\.events\) : undefined/, "map built only on the Map tab");
});

test("V5-2 view=map round-trips and survives chip, tab and panel navigation", () => {
  assert.equal(parseMarketFilters("?view=map").view, "map");
  assert.equal(marketActivityHref(M), "/grow/market-activity?view=map");
  assert.equal(marketActivityHref({ ...M, range: "30d", event: "listed-4" }), "/grow/market-activity?range=30d&event=listed-4&view=map");
  for (const c of marketAreaChips(M, ["Testville"], ["Testville"])) assert.match(c.href, /view=map/);
  const v = view(M, { points: [], total: 0, canvas: null });
  const chipHrefs = all(v, (e) => e.type === Link && e.props?.className === "am-chip").map((e) => String(e.props?.href));
  for (const h of chipHrefs.filter((h) => !h.endsWith("market-activity") && !h.includes("view=map"))) assert.fail(`chip drops the map view: ${h}`);
  assert.equal(marketViewTabs({ ...M, range: "30d" })[0].href, "/grow/market-activity?range=30d");
  assert.match(buildMarketEventDetail(MINE, M).closeHref, /view=map/);
});

test("V5-3 privacy notice is exactly the Owner text; attribution and Report a map issue are shown", () => {
  assert.equal(MAP_PRIVACY_NOTICE, OWNER_NOTICE);
  const s = expand(MarketMapSection({ map: { points: marketMapPoints(EVENTS, M), total: EVENTS.length, canvas: "CANVAS" } }));
  const notice = all(s, (e) => e.props?.["data-mm-map-privacy"] !== undefined);
  assert.equal(notice.length, 1);
  assert.equal(text(notice[0]), OWNER_NOTICE);
  const report = all(s, (e) => e.props?.["data-mm-map-report"] !== undefined)[0];
  assert.equal(report.props?.href, "https://www.openstreetmap.org/fixthemap");
  assert.equal(text(report), "Report a map issue");
  assert.equal(OSM_ATTRIBUTION_TEXT, "© OpenStreetMap contributors");
  assert.equal(OSM_COPYRIGHT_URL, "https://www.openstreetmap.org/copyright");
  assert.equal(osmTileLayerOptions().attribution, OSM_ATTRIBUTION_HTML);
  assert.equal(OSM_ATTRIBUTION_HTML.replace(/<[^>]+>/g, "").replace("&copy;", "©"), OSM_ATTRIBUTION_TEXT);
  assert.match(OSM_ATTRIBUTION_HTML, /href="https:\/\/www\.openstreetmap\.org\/copyright"/);
  // The notice also shows when nothing is mapped.
  const empty = expand(MarketMapSection({ map: { points: [], total: 3, canvas: "CANVAS" } }));
  assert.equal(text(all(empty, (e) => e.props?.["data-mm-map-privacy"] !== undefined)[0]), OWNER_NOTICE);
  assert.doesNotMatch(text(empty), /CANVAS/, "no tiles requested when there is nothing to map");
});

test("V5-4 network: OSM tiles only, Referer scoped to tile images, Leaflet lazily loaded, no geocoding", () => {
  assert.equal(OSM_TILE_URL, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  const o = osmTileLayerOptions();
  assert.equal(o.referrerPolicy, "strict-origin-when-cross-origin");
  assert.equal(OSM_TILE_REFERRER_POLICY, "strict-origin-when-cross-origin");
  assert.equal(o.maxZoom, 19);
  assert.equal(o.keepBuffer, 0, "no prefetch ring");
  const allowed = new Set([OSM_TILE_URL, OSM_COPYRIGHT_URL, OSM_REPORT_ISSUE_URL]);
  for (const f of readdirSync(marketDir)) {
    const s = src(f);
    for (const u of s.match(/https?:\/\/[^\s"'`)<]+/g) ?? []) assert.ok(allowed.has(u), `${f}: unexpected absolute URL ${u}`);
    assert.doesNotMatch(s, /nominatim|geocod(e|ing)\(|\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/i, `${f}: no geocoding or raw network calls`);
    if (f !== "MinimalMarketMapCanvas.tsx") assert.doesNotMatch(s, /from "leaflet"|import\("leaflet"\)/, `${f}: Leaflet only in the lazily loaded canvas`);
  }
  assert.match(src("MinimalMarketActivity.tsx"), /lazy\(\(\) => import\("\.\/MinimalMarketMapCanvas"\)\)/);
  const canvas = src("MinimalMarketMapCanvas.tsx");
  assert.match(canvas, /L\.tileLayer\(OSM_TILE_URL, osmTileLayerOptions\(\)\)/);
  assert.doesNotMatch(canvas, /L\.marker\(|L\.icon\(/, "SVG circle markers only, no icon image requests");
  const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../package.json"), "utf8"));
  assert.equal(pkg.dependencies.leaflet, "1.9.4", "pinned");
  assert.equal(pkg.devDependencies["@types/leaflet"], "1.9.22", "pinned");
});

test("V5-5 points: only AE property records the viewer may open with valid coordinates", () => {
  const pts = marketMapPoints(EVENTS, M);
  assert.deepEqual(pts.map((p) => p.key), ["listed-4"]);
  assert.deepEqual([pts[0].lat, pts[0].lng], [-27.46, 153]);
  assert.equal(pts[0].detailHref, "/grow/market-activity?event=listed-4&view=map");
  // Defence in depth: even if a public or comparable event carried coordinates, it is not mapped.
  assert.equal(marketMapPoints([PUBLIC, COMP], M).length, 0);
  assert.equal(marketMapPoints([{ ...MINE, lat: undefined, lng: undefined }], M).length, 0, "older responses without coordinates");
  assert.equal(mapCoverageNote(0, 0), "No activity in your AE records for this range.");
  assert.match(mapCoverageNote(5, 0), /nothing is mapped/);
  assert.equal(mapCoverageNote(2, 2), "Showing all 2 events on the map.");
  assert.match(mapCoverageNote(5, 1), /^Showing 1 of 5 events on the map\./);
});

test("V5-6 map tab: keyboard-reachable mapped-event links open the same detail panel; tab group labelled", () => {
  const pts = marketMapPoints(EVENTS, M);
  const v = view(M, { points: pts, total: EVENTS.length, canvas: "CANVAS" });
  assert.match(text(v), /CANVAS/);
  assert.equal(all(v, (e) => e.props?.["aria-label"] === "Market events").length, 0, "map replaces the list on the Map tab");
  const links = all(v, (e) => e.props?.["data-mm-map-point"] !== undefined);
  assert.deepEqual(links.map((l) => l.props?.href), ["/grow/market-activity?event=listed-4&view=map"]);
  assert.equal(links[0].props?.["aria-label"], "Details: Just listed at 4 Synthetic Rd");
  const tabs = all(v, (e) => e.type === "ul" && e.props?.["aria-label"] === "View");
  assert.equal(tabs.length, 1);
  const current = all(tabs[0], (e) => e.type === Link && e.props?.["aria-current"] === "page").map(text);
  assert.deepEqual(current, ["Map"]);
});
