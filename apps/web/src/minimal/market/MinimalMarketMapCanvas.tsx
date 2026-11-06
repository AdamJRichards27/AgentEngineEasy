import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM, OSM_TILE_URL, osmTileLayerOptions, type MarketAreaPinPoint, type MarketMapPoint } from "./marketMap";

// V5 map canvas. Loaded lazily (React.lazy) only when the Map tab is open, so
// the List view (the default) never loads Leaflet or requests a tile.
// Markers are SVG circle markers (no marker icon images). Selecting a marker
// opens the same keyboard-accessible detail panel as the list.
// Popups and tooltips get a text node, never an HTML string built from data.
function textEl(text: string): HTMLElement {
  const el = document.createElement("span");
  el.textContent = text;
  return el;
}

// Area pins (other agents' public Just listed / Sold): dashed, hollow, popup
// shows only "<type> · <area>", and they never open a record panel.
export default function MinimalMarketMapCanvas({ points, areaPins = [], selectedKey }: { points: MarketMapPoint[]; areaPins?: MarketAreaPinPoint[]; selectedKey: string | null }) {
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
      marker.bindTooltip(textEl(`${p.label} · ${p.address}`));
      marker.on("click", () => navigate(p.detailHref));
      marker.addTo(g);
    }
    for (const a of areaPins) {
      const pin = L.circleMarker([a.lat, a.lng], { radius: 12, weight: 2, dashArray: "4 3", color: "#6b6b6b", fillOpacity: 0.15 });
      pin.bindPopup(textEl(a.popupText));
      pin.bindTooltip(textEl(a.popupText));
      pin.addTo(g);
    }
    const all = [...points, ...areaPins].map((p) => [p.lat, p.lng] as [number, number]);
    if (all.length === 1) m.setView(all[0], 14);
    else if (all.length > 1) m.fitBounds(L.latLngBounds(all), { padding: [24, 24], maxZoom: 15 });
  }, [points, areaPins, selectedKey]);

  return <div ref={el} className="mm-market-map-canvas" data-mm-map-canvas={points.length + areaPins.length} role="presentation" />;
}
