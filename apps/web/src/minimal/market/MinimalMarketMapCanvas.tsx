import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM, OSM_TILE_URL, osmTileLayerOptions, type MarketMapPoint } from "./marketMap";

// V5 map canvas. Loaded lazily (React.lazy) only when the Map tab is open, so
// the List view (the default) never loads Leaflet or requests a tile.
// Markers are SVG circle markers (no marker icon images). Selecting a marker
// opens the same keyboard-accessible detail panel as the list.
export default function MinimalMarketMapCanvas({ points, selectedKey }: { points: MarketMapPoint[]; selectedKey: string | null }) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { center: MAP_DEFAULT_CENTER, zoom: MAP_DEFAULT_ZOOM, scrollWheelZoom: false });
    L.tileLayer(OSM_TILE_URL, osmTileLayerOptions()).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    for (const p of points) {
      const selected = p.key === selectedKey;
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: selected ? 10 : 7,
        weight: 2,
        color: selected ? "#0b3d2e" : "#1f6f50",
        fillOpacity: selected ? 0.9 : 0.6,
      });
      marker.bindTooltip(`${p.label} · ${p.address}`);
      marker.on("click", () => navigate(p.detailHref));
      marker.addTo(g);
    }
    if (points.length === 1) m.setView([points[0].lat, points[0].lng], 15);
    else if (points.length > 1) m.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), { padding: [24, 24], maxZoom: 15 });
  }, [points, selectedKey]);

  return <div ref={el} className="mm-market-map-canvas" data-mm-map-canvas={points.length} role="presentation" />;
}
