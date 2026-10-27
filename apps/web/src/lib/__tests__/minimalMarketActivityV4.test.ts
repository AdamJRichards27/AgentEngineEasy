// AE Minimal v1.0 V4 (Grow, Owner t457u): Market Activity area chips + event
// detail panel. Pure models and presentational views; synthetic fixtures only,
// no DOM, no network.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Link } from "wouter";
import { ApiError } from "../api";
import { buildMinimalSidebar, minimalSidebarLinks } from "../../minimal/minimalNav";
import {
  MARKET_AREA_NO_OWN_SUBURBS,
  MARKET_AREA_PROPERTIES_FAILED,
  MARKET_SUBURBS_PARAM_MAX,
  agentSuburbs,
  brisbaneToday,
  buildMarketEventDetail,
  buildMarketRows,
  capSuburbs,
  defaultFollowUpDescription,
  findMarketEvent,
  marketActivityHref,
  marketActivityQueryPath,
  marketAreaChips,
  marketCountLines,
  marketFollowUpBody,
  marketFollowUpPath,
  parseMarketFilters,
  resolveMarketArea,
  uniqueSuburbs,
  type MarketEventDto,
  type MarketFilters,
} from "../../minimal/market/minimalMarketActivityModel";
import {
  MARKET_EVENT_PANEL_ID,
  MARKET_EVENT_TITLE_ID,
  MarketEventDetailView,
  MarketFollowUpView,
  MinimalMarketActivityView,
} from "../../minimal/market/MinimalMarketActivityView";
import { followUpErrorText } from "../../minimal/market/MinimalMarketEventFollowUp";

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
const links = (t: unknown) => all(t, (e) => e.type === Link);
const hrefs = (t: unknown) => links(t).map((e) => String(e.props?.href));

const PROPERTY_EVENT: MarketEventDto = {
  key: "listed-4", type: "justListed", label: "Just listed", sourceLabel: "AE property record",
  address: "4 Synthetic Rd, Testville QLD 4000", suburb: "Testville",
  eventDate: "2026-10-21T15:30:00.000Z", recordDate: "2026-10-20T01:00:00.000Z", propertyId: 4, appraisalId: null,
};
const COMP_EVENT: MarketEventDto = {
  key: "comp-9", type: "agentEvidence", label: "Nearby sold (agent-entered)", sourceLabel: "Agent-entered comparable",
  address: "9 Example St", suburb: null, eventDate: "2026-10-19T00:00:00.000Z", recordDate: "2026-10-19T00:00:00.000Z",
  propertyId: null, appraisalId: 12,
};
const EVENTS = [PROPERTY_EVENT, COMP_EVENT];
const W: MarketFilters = { range: "week", type: null };
const marketDir = path.resolve(import.meta.dirname, "../../minimal/market");
const src = (f: string) => readFileSync(path.join(marketDir, f), "utf8");

function readyView(filters: MarketFilters, extra: Record<string, unknown> = {}) {
  const ev = findMarketEvent(EVENTS, filters.event);
  return expand(MinimalMarketActivityView({
    filters,
    area: { chips: marketAreaChips(filters, ["Testville"], ["Exampleton", "Testville"]), note: null },
    state: { kind: "ready", rows: buildMarketRows(EVENTS), counts: marketCountLines({ justListed: 1, agentEvidence: 1 }), truncated: false, detail: ev ? buildMarketEventDetail(ev, filters) : null, ...extra },
  }));
}

test("V4-1 flag off: nav item and page stay hidden; nothing renders before the flag-gated API answers", () => {
  const groups = buildMinimalSidebar({ role: "Agent", entitlements: ["grow.access"], marketActivityAvailable: false, momentumAvailable: false });
  assert.ok(!minimalSidebarLinks(groups).some((l) => l.path === "/grow/market-activity"), "no nav item while the API is hidden");
  const c = src("MinimalMarketActivity.tsx");
  assert.match(c, /isFeatureHiddenError\(q\.error\)\) return <Redirect to="\/grow" replace \/>/);
  // The loading state (shown until the API answers) has no area chips and no events.
  const loading = expand(MinimalMarketActivityView({ filters: W, state: { kind: "loading" } }));
  assert.equal(all(loading, (e) => e.props?.["aria-label"] === "Area").length, 0);
  assert.match(text(loading), /Loading market activity/);
  assert.ok(c.indexOf("isFeatureHiddenError(q.error)") < c.indexOf("const areaProps"), "redirect decided before any chips are built");
});

test("V4-2 area chips: suburbs= round-trips through the URL; default is the agent's own suburbs", () => {
  const props = [
    { agentId: 7, suburb: "Testville" }, { agentId: 7, suburb: " testville " }, { agentId: 7, suburb: "Bravo Park" },
    { agentId: 8, suburb: "Exampleton" }, { agentId: 7, suburb: null }, { agentId: 7, suburb: "Bad, Name" },
  ];
  assert.deepEqual(agentSuburbs(props, 7), ["Bravo Park", "Testville"]);
  assert.deepEqual(agentSuburbs(props, null), []);
  assert.deepEqual(uniqueSuburbs(props), ["Bravo Park", "Exampleton", "Testville"]);
  // Default (no area param) = mine.
  const mine = resolveMarketArea({ kind: "mine" }, agentSuburbs(props, 7));
  assert.deepEqual(mine, { suburbs: ["Bravo Park", "Testville"], note: null });
  assert.equal(marketActivityQueryPath(W, mine.suburbs), "/grow/market-activity?range=week&suburbs=Bravo+Park%2CTestville");
  assert.deepEqual(resolveMarketArea({ kind: "mine" }, []), { suburbs: null, note: MARKET_AREA_NO_OWN_SUBURBS });
  assert.deepEqual(resolveMarketArea({ kind: "mine" }, null), { suburbs: null, note: MARKET_AREA_PROPERTIES_FAILED });
  assert.deepEqual(resolveMarketArea({ kind: "all" }, ["Testville"]), { suburbs: null, note: null });
  assert.equal(marketActivityQueryPath(W, null), "/grow/market-activity?range=week");
  // A suburb chip round-trips: href -> parse -> query.
  const chips = marketAreaChips(W, ["Testville"], ["Exampleton", "Testville"]);
  assert.deepEqual(chips.map((c) => c.label), ["My suburbs", "All suburbs", "Testville", "Exampleton"]);
  assert.equal(chips[0].current, true);
  const ex = chips.find((c) => c.label === "Exampleton")!;
  assert.equal(ex.href, "/grow/market-activity?suburb=Exampleton");
  const parsed = parseMarketFilters(ex.href.split("?")[1]);
  assert.deepEqual(parsed.area, { kind: "suburb", suburb: "Exampleton" });
  assert.equal(marketActivityQueryPath(parsed, resolveMarketArea(parsed.area!, ["Testville"]).suburbs), "/grow/market-activity?range=week&suburbs=Exampleton");
  assert.equal(marketAreaChips(parsed, ["Testville"], ["Exampleton"]).find((c) => c.current)?.label, "Exampleton");
  const allF = parseMarketFilters("?area=all&range=30d&type=sold");
  assert.deepEqual(allF, { range: "30d", type: "sold", area: { kind: "all" } });
  assert.equal(marketActivityHref(allF), "/grow/market-activity?range=30d&type=sold&area=all");
  // Range/type chips keep the area; area chips keep range/type; both close the panel.
  const v = readyView({ range: "30d", type: null, area: { kind: "suburb", suburb: "Exampleton" }, event: "listed-4" });
  assert.ok(hrefs(v).includes("/grow/market-activity?range=30d&type=sold&suburb=Exampleton"));
  assert.ok(hrefs(v).includes("/grow/market-activity?range=30d&area=all"));
  // Commas and the 500-character API limit.
  assert.equal(parseMarketFilters("?suburb=A,B").area, undefined);
  const many = Array.from({ length: 60 }, (_, i) => `Synthetic Suburb ${String(i).padStart(2, "0")}`);
  const capped = capSuburbs(many);
  assert.ok(capped.join(",").length <= MARKET_SUBURBS_PARAM_MAX && capped.length < many.length);
  assert.match(resolveMarketArea({ kind: "mine" }, many).note ?? "", /first \d+ of 60 suburbs/);
});

test("V4-3 detail panel: keyboard reachable, labelled, closable; View Property only with a propertyId; comparables never link", () => {
  const v = readyView({ ...W, event: "listed-4" });
  const details = links(v).filter((l) => l.props?.["data-mm-event-details"]);
  assert.equal(details.length, 2, "every row has a Details link (focusable anchor)");
  assert.equal(details[0].props?.href, "/grow/market-activity?event=listed-4");
  assert.equal(details[0].props?.["aria-label"], "Details: Just listed at 4 Synthetic Rd, Testville QLD 4000");
  assert.equal(details[0].props?.["aria-controls"], MARKET_EVENT_PANEL_ID);
  const panel = all(v, (e) => e.props?.id === MARKET_EVENT_PANEL_ID)[0];
  assert.ok(panel, "panel open");
  assert.equal(panel.props?.role, "region");
  assert.equal(panel.props?.["aria-labelledby"], MARKET_EVENT_TITLE_ID);
  const heading = all(panel, (e) => e.props?.id === MARKET_EVENT_TITLE_ID)[0];
  assert.equal(heading.type, "h2");
  assert.equal(heading.props?.tabIndex, -1, "focus target");
  const close = links(panel).find((l) => l.props?.["data-mm-close-event"]);
  assert.equal(close?.props?.href, "/grow/market-activity");
  assert.deepEqual(links(panel).filter((l) => l.props?.["data-mm-view-property"]).map((l) => l.props?.href), ["/grow/properties/4"]);
  // Container moves focus to the heading and closes on Escape.
  const c = src("MinimalMarketActivity.tsx");
  assert.match(c, /getElementById\(MARKET_EVENT_TITLE_ID\)\?\.focus\(\)/);
  assert.match(c, /e\.key !== "Escape"/);
  // Agent-entered comparable: no View Property, no follow-up, no links but Close.
  const cv = readyView({ ...W, event: "comp-9" }, { followUp: "FOLLOW-UP-SLOT" });
  const cpanel = all(cv, (e) => e.props?.id === MARKET_EVENT_PANEL_ID)[0];
  assert.deepEqual(hrefs(cpanel), ["/grow/market-activity"]);
  assert.doesNotMatch(text(cpanel), /FOLLOW-UP-SLOT|View Property/);
  assert.match(text(cpanel), /not an AE property record/);
  const detail = buildMarketEventDetail(COMP_EVENT, W);
  assert.equal(detail.propertyHref, null);
  assert.equal(detail.propertyId, null);
  // Even a malformed comparable carrying a propertyId does not link.
  assert.equal(buildMarketEventDetail({ ...COMP_EVENT, propertyId: 5 }, W).propertyHref, null);
  assert.equal(buildMarketRows([{ ...COMP_EVENT, propertyId: 5 }])[0].href, null);
  // Property event: follow-up slot rendered.
  const pv = readyView({ ...W, event: "listed-4" }, { followUp: "FOLLOW-UP-SLOT" });
  assert.match(text(pv), /FOLLOW-UP-SLOT/);
  // Unknown or malformed event keys open nothing.
  assert.equal(parseMarketFilters("?event=<script>").event, undefined);
  assert.equal(findMarketEvent(EVENTS, "listed-999"), null);
  assert.equal(all(readyView({ ...W, event: "listed-999" }), (e) => e.props?.id === MARKET_EVENT_PANEL_ID).length, 0);
});

test("V4-4 labels and dates: agent-entered vs AE record; en-AU dates in Australia/Brisbane", () => {
  const p = buildMarketEventDetail(PROPERTY_EVENT, W);
  assert.equal(p.date, "22 Oct 2026", "15:30Z on 21 Oct is 22 Oct in Brisbane");
  assert.equal(p.recorded, "20 Oct 2026");
  assert.equal(p.source, "AE property record");
  assert.equal(p.agentEntered, false);
  const c = buildMarketEventDetail(COMP_EVENT, W);
  assert.equal(c.source, "Agent-entered comparable");
  assert.equal(c.suburb, "Suburb not recorded");
  const panel = expand(MarketEventDetailView({ detail: c }));
  assert.equal(all(panel, (e) => e.props?.["data-mm-event-source"] === "agent-entered").length, 1);
  assert.equal(all(expand(MarketEventDetailView({ detail: p })), (e) => e.props?.["data-mm-event-source"] === "ae-record").length, 1);
  assert.equal(brisbaneToday(new Date("2026-10-27T15:00:00.000Z")), "2026-10-28");
});

test("V4-5 Create Follow-Up (Add commitment, glossary G-6) uses the existing Grow commitment route only", () => {
  assert.equal(marketFollowUpPath(31), "/grow/contacts/31/commitments");
  const now = new Date("2026-10-27T01:00:00.000Z");
  assert.deepEqual(marketFollowUpBody({ description: "  Call about the listing ", dueDate: "2026-10-28", propertyId: 4 }, now), {
    ok: true, body: { description: "Call about the listing", dueAt: "2026-10-27T23:00:00.000Z", propertyId: 4 },
  });
  assert.equal(marketFollowUpBody({ description: " ", dueDate: "2026-10-28", propertyId: 4 }, now).ok, false);
  assert.equal(marketFollowUpBody({ description: "x", dueDate: "", propertyId: 4 }, now).ok, false);
  assert.equal(marketFollowUpBody({ description: "x", dueDate: "2026-10-26", propertyId: 4 }, now).ok, false);
  assert.equal(marketFollowUpBody({ description: "x".repeat(501), dueDate: "2026-10-28", propertyId: 4 }, now).ok, false);
  assert.equal(defaultFollowUpDescription(buildMarketEventDetail(PROPERTY_EVENT, W)), "Market Activity: Just listed at 4 Synthetic Rd, Testville QLD 4000");
  assert.equal(followUpErrorText(new ApiError(403, "Forbidden")), "You don't have permission to add commitments.");
  // The component only calls the two existing routes.
  const f = src("MinimalMarketEventFollowUp.tsx");
  const calls = [...f.matchAll(/apiFetch\((\w+\(\w+\))/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["linkedPartiesPath(propertyId)", "marketFollowUpPath(id)"]);
  assert.match(f, /method: "POST"/);
  assert.match(text(expand(MarketFollowUpView({ state: { kind: "closed", onOpen: () => {} } }))), /^Add commitment$/);
  // Views: closed -> button; no contacts -> explanation; form -> labelled fields, submit disabled without a contact.
  let opened = 0;
  const closed = expand(MarketFollowUpView({ state: { kind: "closed", onOpen: () => { opened++; } } }));
  const btn = all(closed, (e) => e.type === "button")[0];
  assert.equal(text(btn), "Add commitment", "v1.0 Create Follow-Up, named per glossary G-6");
  (btn.props!.onClick as () => void)();
  assert.equal(opened, 1);
  assert.match(text(expand(MarketFollowUpView({ state: { kind: "no-contacts", propertyHref: "/grow/properties/4" } }))), /No contact is linked/);
  const noop = () => {};
  const form = expand(MarketFollowUpView({ state: { kind: "form", contacts: [{ partyId: 31, name: "Syn Contact", roleLabel: "Seller / owner" }], partyId: null, description: "d", dueDate: "2026-10-28", minDate: "2026-10-27", submitting: false, error: null, onParty: noop, onDescription: noop, onDueDate: noop, onSubmit: noop, onCancel: noop } }));
  const ids = all(form, (e) => e.type === "select" || e.type === "textarea" || e.type === "input").map((e) => String(e.props?.id));
  const fors = all(form, (e) => e.type === "label").map((e) => String(e.props?.htmlFor));
  assert.deepEqual(fors, ids, "every field has a label");
  const submit = all(form, (e) => e.type === "button" && e.props?.type === "submit")[0];
  assert.equal(submit.props?.disabled, true);
});

test("V4-6 no outbound network calls: market sources use relative AE API paths only", () => {
  for (const f of readdirSync(marketDir)) {
    const s = src(f);
    assert.doesNotMatch(s, /https?:\/\//, `${f}: no absolute URLs`);
    assert.doesNotMatch(s, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|new Image\(|EventSource|leaflet|tile/i, `${f}: no raw network APIs or map tiles`);
  }
  for (const p of [marketActivityQueryPath(W, ["Testville"]), marketFollowUpPath(1), "/properties"]) assert.match(p, /^\/[a-z]/);
  assert.match(src("MinimalMarketActivity.tsx"), /apiFetch\("\/properties"\)/);
});

test("V4-8 accessibility structure: chip groups are labelled lists with aria-current; rows expose labelled actions", () => {
  const v = readyView({ ...W, area: { kind: "suburb", suburb: "Testville" } });
  const lists = all(v, (e) => e.type === "ul").map((e) => e.props?.["aria-label"]);
  assert.deepEqual(lists, ["Area", "Date range", "Type"]);
  const current = links(v).filter((l) => l.props?.className === "am-chip" && l.props?.["aria-current"] === "page").map((l) => text(l));
  assert.deepEqual(current, ["Testville", "Last 7 days", "All types"]);
  const view = links(v).filter((l) => String(l.props?.["aria-label"] ?? "").startsWith("View Property:"));
  assert.deepEqual(view.map((l) => l.props?.href), ["/grow/properties/4"]);
  assert.match(text(v), /Source: Agent-entered comparable/);
});
