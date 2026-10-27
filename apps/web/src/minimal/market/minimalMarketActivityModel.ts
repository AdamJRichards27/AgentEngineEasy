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

/**
 * V4 area filter. Absent = "mine": the suburbs of the signed-in agent's own AE
 * property records (properties.agent_id). "all" = no suburb filter (still own
 * brokerage only, server-side). "suburb" = one suburb chip.
 */
export type MarketArea = { kind: "mine" } | { kind: "all" } | { kind: "suburb"; suburb: string };

export interface MarketFilters {
  range: MarketRange;
  type: MarketEventType | null;
  /** Omitted means { kind: "mine" } (the default). */
  area?: MarketArea;
  /** Key of the event whose detail panel is open. */
  event?: string;
}

/** The API rejects `suburbs` longer than 500 characters and splits on commas. */
export const MARKET_SUBURBS_PARAM_MAX = 500;
/** Suburb chips shown besides "My suburbs" and "All suburbs". */
export const MARKET_SUBURB_CHIP_MAX = 12;
export const MARKET_EVENT_KEY_MAX = 64;

function cleanSuburb(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  // A comma would split one suburb into two on the server; such names are not offered.
  if (!s || s.includes(",") || s.length > 80) return null;
  return s;
}

export function parseMarketFilters(search: string): MarketFilters {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const r = p.get("range");
  const t = p.get("type");
  const f: MarketFilters = {
    range: r === "lastweek" || r === "30d" ? r : "week",
    type: (MARKET_EVENT_TYPES as readonly string[]).includes(t ?? "") ? (t as MarketEventType) : null,
  };
  const suburb = cleanSuburb(p.get("suburb"));
  if (suburb) f.area = { kind: "suburb", suburb };
  else if (p.get("area") === "all") f.area = { kind: "all" };
  const ev = p.get("event");
  if (ev && ev.length <= MARKET_EVENT_KEY_MAX && /^[a-z]+-\d+$/.test(ev)) f.event = ev;
  return f;
}

export function marketAreaOf(f: MarketFilters): MarketArea {
  return f.area ?? { kind: "mine" };
}

export interface MarketPropertyLite {
  agentId?: number | null;
  suburb?: string | null;
}

/** Unique suburbs (case-insensitive), en-AU sorted, from the given property records. */
export function uniqueSuburbs(rows: readonly MarketPropertyLite[]): string[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    const s = cleanSuburb(r.suburb);
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "en-AU"));
}

/** The agent's suburbs: suburbs of AE property records whose agent is the signed-in user. */
export function agentSuburbs(rows: readonly MarketPropertyLite[], userId: number | null | undefined): string[] {
  if (userId == null) return [];
  return uniqueSuburbs(rows.filter((r) => r.agentId === userId));
}

/** Keep whole suburb names while the comma-joined value fits the API limit. */
export function capSuburbs(suburbs: readonly string[]): string[] {
  const out: string[] = [];
  let len = 0;
  for (const s of suburbs) {
    const add = (out.length ? 1 : 0) + s.length;
    if (len + add > MARKET_SUBURBS_PARAM_MAX) break;
    out.push(s);
    len += add;
  }
  return out;
}

export interface ResolvedArea {
  /** Suburbs sent as `suburbs=`; null = no suburb filter. */
  suburbs: string[] | null;
  /** Shown under the chips when the default could not use the agent's suburbs. */
  note: string | null;
}

export const MARKET_AREA_NO_OWN_SUBURBS = "None of your own AE property records has a suburb yet, so all suburbs are shown.";
export const MARKET_AREA_PROPERTIES_FAILED = "Couldn't load your suburbs, so all suburbs are shown.";

export function resolveMarketArea(area: MarketArea, mine: readonly string[] | null): ResolvedArea {
  if (area.kind === "all") return { suburbs: null, note: null };
  if (area.kind === "suburb") return { suburbs: [area.suburb], note: null };
  if (mine === null) return { suburbs: null, note: MARKET_AREA_PROPERTIES_FAILED };
  if (mine.length === 0) return { suburbs: null, note: MARKET_AREA_NO_OWN_SUBURBS };
  const capped = capSuburbs(mine);
  return {
    suburbs: capped,
    note: capped.length < mine.length ? `Showing your first ${capped.length} of ${mine.length} suburbs.` : null,
  };
}

export function marketActivityQueryPath(f: MarketFilters, suburbs?: readonly string[] | null): string {
  const q = new URLSearchParams({ range: f.range });
  if (f.type) q.set("types", f.type);
  if (suburbs && suburbs.length) q.set("suburbs", capSuburbs(suburbs).join(","));
  return `/grow/market-activity?${q.toString()}`;
}

export function marketActivityHref(f: MarketFilters): string {
  const q = new URLSearchParams();
  if (f.range !== "week") q.set("range", f.range);
  if (f.type) q.set("type", f.type);
  const area = marketAreaOf(f);
  if (area.kind === "all") q.set("area", "all");
  if (area.kind === "suburb") q.set("suburb", area.suburb);
  if (f.event) q.set("event", f.event);
  const s = q.toString();
  return s ? `${MINIMAL_MARKET_ACTIVITY_HREF}?${s}` : MINIMAL_MARKET_ACTIVITY_HREF;
}

export interface MarketAreaChip {
  key: string;
  label: string;
  href: string;
  current: boolean;
}

/** "My suburbs", "All suburbs", then up to MARKET_SUBURB_CHIP_MAX suburbs (agent's first). Opening a chip closes any panel. */
export function marketAreaChips(f: MarketFilters, mine: readonly string[], visible: readonly string[]): MarketAreaChip[] {
  const area = marketAreaOf(f);
  const base = { range: f.range, type: f.type };
  const chips: MarketAreaChip[] = [
    { key: "mine", label: "My suburbs", href: marketActivityHref({ ...base }), current: area.kind === "mine" },
    { key: "all", label: "All suburbs", href: marketActivityHref({ ...base, area: { kind: "all" } }), current: area.kind === "all" },
  ];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const s of [...mine, ...visible]) {
    if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); names.push(s); }
  }
  const shown = names.slice(0, MARKET_SUBURB_CHIP_MAX);
  if (area.kind === "suburb" && !shown.some((s) => s.toLowerCase() === area.suburb.toLowerCase())) shown.push(area.suburb);
  for (const s of shown) {
    chips.push({
      key: `suburb-${s.toLowerCase()}`,
      label: s,
      href: marketActivityHref({ ...base, area: { kind: "suburb", suburb: s } }),
      current: area.kind === "suburb" && area.suburb.toLowerCase() === s.toLowerCase(),
    });
  }
  return chips;
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

/** True for agent-entered comparables: not AE property records, so nothing links. */
export function isAgentEnteredEvent(e: Pick<MarketEventDto, "type" | "propertyId">): boolean {
  return e.type === "agentEvidence" || e.propertyId == null;
}

export function marketPropertyHref(e: Pick<MarketEventDto, "type" | "propertyId">): string | null {
  return !isAgentEnteredEvent(e) && e.propertyId != null ? `/grow/properties/${e.propertyId}` : null;
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
    href: marketPropertyHref(e),
  }));
}

export interface MarketEventDetail {
  key: string;
  title: string;
  label: string;
  address: string;
  suburb: string;
  date: string;
  recorded: string;
  source: string;
  agentEntered: boolean;
  /** View Property: only for AE property records (propertyId present). */
  propertyHref: string | null;
  /** Create Follow-Up: only on an AE property record (a commitment on a linked contact). */
  propertyId: number | null;
  closeHref: string;
}

export function findMarketEvent(events: readonly MarketEventDto[], key: string | undefined): MarketEventDto | null {
  if (!key) return null;
  return events.find((e) => e.key === key) ?? null;
}

export function buildMarketEventDetail(e: MarketEventDto, f: MarketFilters): MarketEventDetail {
  const agentEntered = isAgentEnteredEvent(e);
  const propertyHref = marketPropertyHref(e);
  return {
    key: e.key,
    title: `${e.label} · ${e.address}`,
    label: e.label,
    address: e.address,
    suburb: e.suburb?.trim() || "Suburb not recorded",
    date: formatMarketDate(e.eventDate),
    recorded: formatMarketDate(e.recordDate),
    source: agentEntered ? "Agent-entered comparable" : e.sourceLabel,
    agentEntered,
    propertyHref,
    propertyId: propertyHref ? e.propertyId : null,
    closeHref: marketActivityHref({ ...f, event: undefined }),
  };
}

export function marketEventDetailHref(f: MarketFilters, key: string): string {
  return marketActivityHref({ ...f, event: key });
}

// AE Minimal v1.0 "Create Follow-Up" maps to an open commitment on a linked
// contact (glossary G-6: a commitment is never called a follow-up; a due
// follow-up belongs to an opportunity or appraisal). Existing Grow route only:
//   GET  /parties/by-property/:id                linked contacts (existing)
//   POST /grow/contacts/:partyId/commitments     { description, dueAt, propertyId } (grow.activities.manage)
export function marketFollowUpPath(partyId: number): string {
  return `/grow/contacts/${partyId}/commitments`;
}

export const MARKET_FOLLOW_UP_DESCRIPTION_MAX = 500;
export const COMMITMENT_ADD_LABEL = "Add commitment";
export const MARKET_COMMITMENT_HINT = "Saved as an open commitment on the contact you choose, linked to this property. It does not set a due follow-up.";

export function defaultFollowUpDescription(d: Pick<MarketEventDetail, "label" | "address">): string {
  return `Market Activity: ${d.label} at ${d.address}`.slice(0, MARKET_FOLLOW_UP_DESCRIPTION_MAX);
}

/** Today's date (YYYY-MM-DD) in Australia/Brisbane. */
export function brisbaneToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type FollowUpBodyResult =
  | { ok: true; body: { description: string; dueAt: string; propertyId: number } }
  | { ok: false; error: string };

/** Due 9:00 am Brisbane time (UTC+10, no daylight saving) on the chosen date. */
export function marketFollowUpBody(input: { description: string; dueDate: string; propertyId: number }, now: Date = new Date()): FollowUpBodyResult {
  const description = input.description.trim();
  if (!description) return { ok: false, error: "Add what the commitment is." };
  if (description.length > MARKET_FOLLOW_UP_DESCRIPTION_MAX) return { ok: false, error: `Keep it to ${MARKET_FOLLOW_UP_DESCRIPTION_MAX} characters.` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) || Number.isNaN(new Date(`${input.dueDate}T09:00:00+10:00`).getTime())) {
    return { ok: false, error: "Choose a due date." };
  }
  if (input.dueDate < brisbaneToday(now)) return { ok: false, error: "Choose today or a later date." };
  return { ok: true, body: { description, dueAt: new Date(`${input.dueDate}T09:00:00+10:00`).toISOString(), propertyId: input.propertyId } };
}

export function marketCountLines(counts: Partial<Record<MarketEventType, number>>): { type: MarketEventType; label: string; value: number }[] {
  return MARKET_EVENT_TYPES.map((t) => ({ type: t, label: MARKET_TYPE_LABELS[t], value: counts[t] ?? 0 }));
}

export function selectMarketActivityView(minimalShell: boolean): "minimal" | "classic" {
  return minimalShell ? "minimal" : "classic";
}
