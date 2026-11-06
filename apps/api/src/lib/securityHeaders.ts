import type { RequestHandler } from "express";
import helmet from "helmet";
import { MARKET_ACTIVITY_FLAG_ENV } from "../routes/growMarketActivity.js";

// Owner t525u item 4 (V5 Market Activity map, supervised preview only).
// helmet's defaults stay in force for every header. The one exception is a
// narrow CSP img-src addition for the public OpenStreetMap tile host, and it
// only applies while the (default-off) Market Activity flag is on. No other
// directive is relaxed. Referrer-Policy stays helmet's global "no-referrer";
// the OSM tile policy's Referer requirement is met per tile image instead
// (Leaflet tileLayer referrerPolicy "strict-origin-when-cross-origin", see
// apps/web/src/minimal/market/marketMap.ts), so no other request leaks a
// referrer.
export const OSM_TILE_ORIGIN = "https://tile.openstreetmap.org";

const defaultHeaders = helmet();
const mapPreviewHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { "img-src": ["'self'", "data:", OSM_TILE_ORIGIN] },
  },
});

export function mapPreviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MARKET_ACTIVITY_FLAG_ENV] === "true";
}

export function securityHeaders(): RequestHandler {
  return (req, res, next) => (mapPreviewEnabled() ? mapPreviewHeaders : defaultHeaders)(req, res, next);
}
