import { marketActivityHref, marketEventDetailHref, type MarketEventDto, type MarketFilters } from "./minimalMarketActivityModel";

// AE Minimal v1.0 V5: Market Activity map (Owner t525u items 4-6).
// Draft and supervised preview only: the page exists only while the
// server-side Market Activity flag is on (404 otherwise), and the List stays
// the default view. Leaflet + public OpenStreetMap tiles, per the OSM tile
// usage policy: visible attribution, a valid Referer on tile requests (set per
// tile image, so the app's global no-referrer policy stays), no bulk
// prefetching and no geocoding. Points come only from coordinates already on
// AE property records the viewer may open (the API never sends coordinates for
// another agent's listing, comparables or another brokerage).

export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";
export const OSM_REPORT_ISSUE_URL = "https://www.openstreetmap.org/fixthemap";
export const OSM_ATTRIBUTION_TEXT = "© OpenStreetMap contributors";
export const OSM_ATTRIBUTION_HTML = `&copy; <a href="${OSM_COPYRIGHT_URL}" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors`;
/** Owner t525u item 5: shown exactly as approved. */
export const MAP_PRIVACY_NOTICE =
  "Map tiles are provided by a third-party mapping service. When you view a map, your IP address and limited technical information may be transmitted to the map provider, including servers located outside Australia.";
/** The OSM tile policy requires a valid Referer; scoped to tile images only. */
export const OSM_TILE_REFERRER_POLICY = "strict-origin-when-cross-origin" as const;
export const OSM_MAX_ZOOM = 19;
export const MAP_DEFAULT_CENTER: [number, number] = [-27.4698, 153.0251]; // Brisbane CBD
export const MAP_DEFAULT_ZOOM = 11;

export function osmTileLayerOptions() {
  return {
    attribution: OSM_ATTRIBUTION_HTML,
    maxZoom: OSM_MAX_ZOOM,
    referrerPolicy: OSM_TILE_REFERRER_POLICY,
    // Keep the tile footprint to what is on screen (no prefetching ring).
    keepBuffer: 0,
  };
}

export interface MarketMapPoint {
  key: string;
  label: string;
  address: string;
  lat: number;
  lng: number;
  detailHref: string;
}

const finite = (n: unknown, max: number): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= max;

/** Map points: AE property events the viewer may open that carry valid coordinates. */
export function marketMapPoints(events: readonly MarketEventDto[], f: MarketFilters): MarketMapPoint[] {
  const out: MarketMapPoint[] = [];
  for (const e of events) {
    if (e.type === "agentEvidence" || e.access === "public" || e.propertyId == null) continue;
    if (!finite(e.lat, 90) || !finite(e.lng, 180)) continue;
    out.push({ key: e.key, label: e.label, address: e.address, lat: e.lat, lng: e.lng, detailHref: marketEventDetailHref(f, e.key) });
  }
  return out;
}

export interface MarketViewTab {
  key: "list" | "map";
  label: string;
  href: string;
  current: boolean;
}

/** List (default) and Map tabs; switching keeps the filters and any open panel. */
export function marketViewTabs(f: MarketFilters): MarketViewTab[] {
  const { view: _v, ...rest } = f;
  return [
    { key: "list", label: "List", href: marketActivityHref(rest), current: f.view !== "map" },
    { key: "map", label: "Map", href: marketActivityHref({ ...rest, view: "map" }), current: f.view === "map" },
  ];
}

export function mapCoverageNote(total: number, mapped: number): string {
  if (total === 0) return "No activity in your AE records for this range.";
  if (mapped === 0) return "None of these events has a location on its AE property record, so nothing is mapped. The list shows them all.";
  if (mapped === total) return `Showing all ${total} events on the map.`;
  return `Showing ${mapped} of ${total} events on the map. The rest have no location you can see (another agent's listing, an agent-entered comparable, or no coordinates on the record). The list shows them all.`;
}
