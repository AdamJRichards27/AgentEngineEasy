// Minimal A My Momentum + Market Activity UI (CC #5/#26) over #248's APIs.
// Pure models and presentational views; synthetic data, no DOM, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Link } from "wouter";
import { ApiError } from "../api";
import { navLinkIsActive } from "../productNav";
import {
  buildMomentumModel,
  isFeatureHiddenError,
  isMomentumResponse,
  momentumQueryPath,
  NOT_YET_AVAILABLE,
  parseMomentumPeriod,
  selectMomentumView,
  type MomentumResponse,
} from "../../minimal/momentum/minimalMomentumModel";
import { MinimalMomentumView } from "../../minimal/momentum/MinimalMomentumView";
import {
  buildMarketRows,
  isMarketActivityResponse,
  marketActivityHref,
  marketActivityQueryPath,
  marketCountLines,
  parseMarketFilters,
  type MarketActivityResponse,
} from "../../minimal/market/minimalMarketActivityModel";
import { MinimalMarketActivityView } from "../../minimal/market/MinimalMarketActivityView";
import { TodayInsightCardsView } from "../../minimal/momentum/MinimalTodayInsightCardsView";
import { marketCardData, momentumCardData } from "../../minimal/momentum/minimalTodayInsightsModel";

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
const links = (t: unknown) => all(t, (e) => e.type === Link).map((e) => String(e.props?.href));

const MOMENTUM: MomentumResponse = {
  rulesVersion: "momentum-v1", private: true, period: "week", timeZone: "Australia/Brisbane",
  start: "2026-10-18T14:00:00.000Z", end: "2026-10-25T14:00:00.000Z",
  score: 87, previousScore: 60, change: 27, nextMilestone: 100,
  categories: [
    { key: "connectedConversation", label: "Conversations", count: 7, points: 42, sourced: true },
    { key: "twoWayExchange", label: "Replies received", count: 0, points: 0, sourced: false },
    { key: "personalisedOutreach", label: "Personal outreach", count: 5, points: 5, sourced: true },
    { key: "opportunityIdentified", label: "Opportunities identified", count: 1, points: 10, sourced: true },
    { key: "appraisalBooked", label: "Appraisals booked", count: 2, points: 30, sourced: true },
    { key: "appraisalCompleted", label: "Appraisals completed", count: 0, points: 0, sourced: true },
    { key: "listingLinked", label: "Listings", count: 0, points: 0, sourced: false },
    { key: "saleLinked", label: "Sales", count: 0, points: 0, sourced: false },
  ],
  funnel: { contacts: 9, conversations: 7, opportunities: 1, appraisals: 2, listings: null, sales: null },
  trend: [
    { start: "2026-09-27T14:00:00.000Z", score: 20 }, { start: "2026-10-04T14:00:00.000Z", score: 41 },
    { start: "2026-10-11T14:00:00.000Z", score: 60 }, { start: "2026-10-18T14:00:00.000Z", score: 87 },
  ],
  streakDays: 3, nextBestActions: [], truncated: false,
};

const MARKET: MarketActivityResponse = {
  asOf: "2026-10-22T10:00:00.000Z", range: "week", start: "2026-10-15T10:00:00.000Z", end: "2026-10-22T10:00:00.000Z",
  counts: { justListed: 1, sold: 1, withdrawn: 0, agentEvidence: 1 },
  events: [
    { key: "listed-4", type: "justListed", label: "Just listed", sourceLabel: "AE property record", address: "4 Synthetic Rd", suburb: "Testville", eventDate: "2026-10-21T00:00:00.000Z", recordDate: "2026-10-21T00:00:00.000Z", propertyId: 4, appraisalId: null },
    { key: "comp-9", type: "agentEvidence", label: "Nearby sold (agent-entered)", sourceLabel: "Agent-entered comparable", address: "9 Sample Ave", suburb: null, eventDate: "2026-10-20T00:00:00.000Z", recordDate: "2026-10-20T00:00:00.000Z", propertyId: null, appraisalId: 3 },
  ],
  truncated: false, providers: "none",
};

test("momentum: sourced:false categories and null funnel steps read 'Not yet available', never a number", () => {
  const m = buildMomentumModel(MOMENTUM);
  const byKey = Object.fromEntries(m.categories.map((c) => [c.key, c]));
  for (const k of ["twoWayExchange", "listingLinked", "saleLinked"]) {
    assert.equal(byKey[k].value, NOT_YET_AVAILABLE, k);
    assert.equal(byKey[k].available, false);
  }
  assert.equal(byKey.connectedConversation.value, "7 · 42 pts");
  assert.equal(byKey.appraisalCompleted.value, "0 · 0 pts", "a sourced zero is a real zero");
  const f = Object.fromEntries(m.funnel.map((r) => [r.label, r.value]));
  assert.equal(f.Listings, NOT_YET_AVAILABLE);
  assert.equal(f.Sales, NOT_YET_AVAILABLE);
  assert.equal(f.Conversations, "7");
});

test("momentum: change, milestone, streak, trend and range in Brisbane time", () => {
  const m = buildMomentumModel(MOMENTUM);
  assert.equal(m.changeLabel, "+27 on last week");
  assert.equal(m.changeTone, "up");
  assert.equal(m.milestoneLabel, "13 pts to 100");
  assert.equal(m.streakLabel, "3 days");
  assert.equal(m.rangeLabel, "19 Oct – 25 Oct");
  assert.deepEqual(m.trend.map((t) => t.current), [false, false, false, true]);
  assert.equal(m.trend[3].label, "Week of 19 Oct");
  assert.equal(buildMomentumModel({ ...MOMENTUM, change: -5 }).changeLabel, "-5 on last week");
  assert.equal(buildMomentumModel({ ...MOMENTUM, period: "month", change: 0 }).changeLabel, "Same as last month");
  assert.equal(buildMomentumModel({ ...MOMENTUM, nextMilestone: null }).milestoneLabel, "Every milestone reached");
  assert.match(String(buildMomentumModel({ ...MOMENTUM, truncated: true }).truncatedNote), /2,000/);
});

test("momentum: empty state when every sourced category is zero", () => {
  const zero = { ...MOMENTUM, score: 0, categories: MOMENTUM.categories.map((c) => ({ ...c, count: 0, points: 0 })) };
  assert.equal(buildMomentumModel(zero).empty, true);
  assert.equal(buildMomentumModel(MOMENTUM).empty, false);
  const tree = expand(MinimalMomentumView({ period: "week", state: { kind: "ready", period: "week", model: buildMomentumModel(zero) } }));
  assert.match(text(tree), /Nothing counted yet/);
});

test("momentum page is private: no leaderboard, rank or comparison wording; no links to other people", () => {
  const tree = expand(MinimalMomentumView({ period: "week", state: { kind: "ready", period: "week", model: buildMomentumModel(MOMENTUM) } }));
  const t = text(tree);
  assert.match(t, /Only you can see this/);
  assert.doesNotMatch(t, /leaderboard|rank|team average|top agent|percentile|vs\.? (team|others)/i);
  assert.match(t, new RegExp(NOT_YET_AVAILABLE));
  for (const h of links(tree)) assert.match(h, /^\/grow(\/momentum(\?period=month)?|\?tab=\w+)?$/, h);
});

test("momentum view: loading and error states", () => {
  assert.match(text(expand(MinimalMomentumView({ period: "week", state: { kind: "loading" } }))), /Loading your momentum/);
  let retried = 0;
  const err = expand(MinimalMomentumView({ period: "week", state: { kind: "error", text: "Boom", onRetry: () => { retried++; } } }));
  assert.match(text(err), /Boom/);
  const btn = all(err, (e) => e.type === "button")[0];
  (btn.props!.onClick as () => void)();
  assert.equal(retried, 1);
});

test("feature gate: 404 (flag off) and 403 (no grow.access) hide; other errors do not", () => {
  assert.equal(isFeatureHiddenError(new ApiError(404, "Not found")), true);
  assert.equal(isFeatureHiddenError(new ApiError(403, "Forbidden")), true);
  assert.equal(isFeatureHiddenError(new ApiError(500, "Server")), false);
  assert.equal(isFeatureHiddenError(new Error("x")), false);
  assert.equal(isMomentumResponse({ error: "Not found" }), false);
  assert.equal(isMomentumResponse({ ...MOMENTUM, private: false }), false, "must be the private payload");
  assert.equal(isMomentumResponse(MOMENTUM), true);
  assert.equal(isMarketActivityResponse({ disabled: true }), false);
  assert.equal(isMarketActivityResponse(MARKET), true);
  assert.equal(momentumCardData({ error: "x" }), null);
  assert.equal(marketCardData(null), null);
});

test("paths and query parsing", () => {
  assert.equal(momentumQueryPath("week"), "/grow/momentum?period=week");
  assert.equal(parseMomentumPeriod("?period=month"), "month");
  assert.equal(parseMomentumPeriod("period=bogus"), "week");
  assert.deepEqual(parseMarketFilters("?range=30d&type=sold"), { range: "30d", type: "sold" });
  assert.deepEqual(parseMarketFilters("?range=x&type=evil"), { range: "week", type: null });
  assert.equal(marketActivityQueryPath({ range: "lastweek", type: "withdrawn" }), "/grow/market-activity?range=lastweek&types=withdrawn");
  assert.equal(marketActivityQueryPath({ range: "week", type: null }), "/grow/market-activity?range=week");
  assert.equal(marketActivityHref({ range: "week", type: null }), "/grow/market-activity");
  assert.equal(marketActivityHref({ range: "30d", type: "sold" }), "/grow/market-activity?range=30d&type=sold");
});

test("market rows: AE property records link to Minimal property detail; agent-entered comparables are labelled and unlinked", () => {
  const [a, b] = buildMarketRows(MARKET.events);
  assert.equal(a.href, "/grow/properties/4");
  assert.equal(a.source, "AE property record");
  assert.equal(b.href, null);
  assert.equal(b.source, "Agent-entered comparable");
  assert.equal(b.suburb, "Suburb not recorded");
  assert.equal(a.date, "21 Oct 2026");
  assert.deepEqual(marketCountLines(MARKET.counts).map((c) => c.value), [1, 1, 0, 1]);
});

test("market view: scope note, list, empty, loading, error, truncated", () => {
  const filters = { range: "week" as const, type: null };
  const ready = expand(MinimalMarketActivityView({ filters, state: { kind: "ready", rows: buildMarketRows(MARKET.events), counts: marketCountLines(MARKET.counts), truncated: true } }));
  const t = text(ready);
  assert.match(t, /own AE records only\. Not market-wide data/);
  assert.match(t, /4 Synthetic Rd/);
  assert.match(t, /Source: Agent-entered comparable/);
  assert.match(t, /latest 100 events/);
  assert.ok(links(ready).includes("/grow/properties/4"));
  assert.ok(links(ready).includes("/grow/market-activity?type=sold"));
  const empty = expand(MinimalMarketActivityView({ filters, state: { kind: "ready", rows: [], counts: marketCountLines({}), truncated: false } }));
  assert.match(text(empty), /No activity in your AE records/);
  assert.match(text(expand(MinimalMarketActivityView({ filters, state: { kind: "loading" } }))), /Loading market activity/);
  assert.match(text(expand(MinimalMarketActivityView({ filters, state: { kind: "error", text: "Nope" } }))), /Nope/);
});

test("Today cards: hidden renders nothing; each card hides independently; ready shows data and links", () => {
  assert.equal(TodayInsightCardsView({ momentum: { kind: "hidden" }, market: { kind: "hidden" } }), null);
  const onlyMarket = expand(TodayInsightCardsView({ momentum: { kind: "hidden" }, market: { kind: "ready", data: marketCardData(MARKET)! } }));
  assert.doesNotMatch(text(onlyMarket), /My Momentum/);
  assert.match(text(onlyMarket), /Market Activity/);
  assert.deepEqual(links(onlyMarket), ["/grow/market-activity"]);
  const both = expand(TodayInsightCardsView({ momentum: { kind: "ready", data: momentumCardData(MOMENTUM)! }, market: { kind: "loading" } }));
  const t = text(both);
  assert.match(t, /87pts this week/);
  assert.match(t, /3 measures not yet available/);
  assert.match(t, /Private to you/);
  assert.match(t, /Loading market activity/);
  assert.ok(links(both).includes("/grow/momentum"));
  const err = expand(TodayInsightCardsView({ momentum: { kind: "error", text: "Momentum down" }, market: { kind: "hidden" } }));
  assert.match(text(err), /Momentum down/);
});

// Routing and nav highlight.
const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const routesSrc = app.slice(app.indexOf("function AuthenticatedRoutes"));
const ROUTE_PATHS = [...routesSrc.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
function toRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]+/g, "[^/]+")}/?$`, "i");
}
const firstMatch = (p: string) => ROUTE_PATHS.find((r) => toRegex(r).test(p));

test("routes /grow/momentum and /grow/market-activity are declared before /grow and match first", () => {
  const i = (p: string) => ROUTE_PATHS.indexOf(p);
  assert.ok(i("/grow/momentum") >= 0 && i("/grow/market-activity") >= 0);
  assert.ok(i("/grow/momentum") < i("/grow"));
  assert.ok(i("/grow/market-activity") < i("/grow"));
  assert.equal(firstMatch("/grow/momentum"), "/grow/momentum");
  assert.equal(firstMatch("/grow/market-activity"), "/grow/market-activity");
  assert.equal(firstMatch("/grow/properties/4"), "/grow/properties/:id");
  assert.equal(firstMatch("/grow"), "/grow");
  assert.match(app, /const MinimalMomentum = lazy\(\(\) => import\("\.\/minimal\/momentum\/MinimalMomentum"\)\)/);
  assert.match(app, /const MinimalMarketActivity = lazy\(\(\) => import\("\.\/minimal\/market\/MinimalMarketActivity"\)\)/);
  assert.match(app, /selectMomentumView\(minimalShell\) === "minimal" \? <MinimalMomentum \/> : <Redirect to="\/grow" replace \/>/);
  assert.match(app, /selectMarketActivityView\(minimalShell\) === "minimal" \? <MinimalMarketActivity \/> : <Redirect to="\/grow" replace \/>/);
  assert.equal(selectMomentumView(false), "classic");
  assert.equal(selectMomentumView(true), "minimal");
});

test("Grow stays highlighted on My Momentum and Market Activity", () => {
  for (const p of ["/grow/momentum", "/grow/momentum/", "/grow/momentum?period=month", "/grow/market-activity", "/grow/market-activity?range=30d#x"]) {
    assert.equal(navLinkIsActive(p, "/grow"), true, p);
  }
  for (const p of ["/grow/momentum/1", "/grow/market-activity/x", "/grow/momentumx"]) assert.equal(navLinkIsActive(p, "/grow"), false, p);
});
