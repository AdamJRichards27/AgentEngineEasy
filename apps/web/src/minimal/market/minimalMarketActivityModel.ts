// AE Minimal A — Market Activity (CC #26). Client-side mirror of the response
// of GET /grow/market-activity from draft PR #248
// (apps/api/src/routes/growMarketActivity.ts @4ff8dabb). Mirrored, not
// imported, so this branch does not stack on #248. Internal AE records only
// (own brokerage): never presented as market-wide or provider data. The API
// answers 404 while GROW_MARKET_ACTIVITY_ENABLED is not "true"; the UI then
// shows nothing at all.

export type MarketEventType = "justListed" | "sold" | "withdrawn" | "agentEvidence";
export type MarketRange = "week" | "lastweek" | "30d";

export const MARKET_EVENT_TYPES: readonly MarketEventType[] = ["justListed", "sold", "withdrawn", "agentEvidence"];
export const MARKET_RANGES: readonly { key: MarketRange; label: string }[] = [
  { key: "week", label: "Last 7 days" },
  { key: "lastweek", label: "The week before" },
  { key: "30d", label: "Last 30 days" },
];
export const MARKET_TYPE_LABELS: Record<MarketEventType, string> = {
  justListed: "Just listed",
  sold: "Sold",
  withdrawn: "Withdrawn",
  agentEvidence: "Agent-entered sales",
};

export interface MarketEventDto {
  key: string;
  type: MarketEventType;
  label: string;
  sourceLabel: string;
  address: string;
  suburb: string | null;
  eventDate: string;
  recordDate: string;
  propertyId: number | null;
  appraisalId: number | null;
}

export interface MarketActivityResponse {
  asOf: string;
  range: MarketRange;
  start: string;
  end: string;
  counts: Record<MarketEventType, number>;
  events: MarketEventDto[];
  truncated: boolean;
  providers: "none";
}

export const MINIMAL_MARKET_ACTIVITY_HREF = "/grow/market-activity";
export const MARKET_SCOPE_NOTE = "From your brokerage's own AE records only. Not market-wide data.";

export interface MarketFilters {
  range: MarketRange;
  type: MarketEventType | null;
}

export function parseMarketFilters(search: string): MarketFilters {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const r = p.get("range");
  const t = p.get("type");
  return {
    range: r === "lastweek" || r === "30d" ? r : "week",
    type: (MARKET_EVENT_TYPES as readonly string[]).includes(t ?? "") ? (t as MarketEventType) : null,
  };
}

export function marketActivityQueryPath(f: MarketFilters): string {
  const q = new URLSearchParams({ range: f.range });
  if (f.type) q.set("types", f.type);
  return `/grow/market-activity?${q.toString()}`;
}

export function marketActivityHref(f: MarketFilters): string {
  const q = new URLSearchParams();
  if (f.range !== "week") q.set("range", f.range);
  if (f.type) q.set("type", f.type);
  const s = q.toString();
  return s ? `${MINIMAL_MARKET_ACTIVITY_HREF}?${s}` : MINIMAL_MARKET_ACTIVITY_HREF;
}

export function isMarketActivityResponse(x: unknown): x is MarketActivityResponse {
  const r = x as Partial<MarketActivityResponse> | null;
  return !!r && typeof r === "object" && Array.isArray(r.events) && !!r.counts && typeof r.counts === "object";
}

export interface MarketEventRow {
  key: string;
  label: string;
  address: string;
  suburb: string;
  date: string;
  source: string;
  href: string | null;
}

export function formatMarketDate(iso: string, timeZone = "Australia/Brisbane"): string {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(iso));
}

export function buildMarketRows(events: MarketEventDto[]): MarketEventRow[] {
  return events.map((e) => ({
    key: e.key,
    label: e.label,
    address: e.address,
    suburb: e.suburb?.trim() || "Suburb not recorded",
    date: formatMarketDate(e.eventDate),
    source: e.sourceLabel,
    // Only AE property records link anywhere; agent-entered comparables are not property records.
    href: e.propertyId != null ? `/grow/properties/${e.propertyId}` : null,
  }));
}

export function marketCountLines(counts: Partial<Record<MarketEventType, number>>): { type: MarketEventType; label: string; value: number }[] {
  return MARKET_EVENT_TYPES.map((t) => ({ type: t, label: MARKET_TYPE_LABELS[t], value: counts[t] ?? 0 }));
}

export function selectMarketActivityView(minimalShell: boolean): "minimal" | "classic" {
  return minimalShell ? "minimal" : "classic";
}
