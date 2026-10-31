// Minimal A Properties/Opportunities detail + opportunity search (CC #25/#26).
// Pure models and presentational views only; synthetic data, no DOM, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { Link } from "wouter";
import type { AppraisalListRow } from "../appraisalUi";
import {
  buildMinimalPropertyDetail,
  classifyPropertyOpportunityPage,
  minimalPropertyDetailPath,
  minimalPropertyOpportunitiesPath,
  parseDetailId,
  selectPropertyDetailView,
  type MinimalPropertyDetailRow,
} from "../../minimal/properties/minimalPropertyDetailModel";
import { MinimalPropertyDetailView } from "../../minimal/properties/MinimalPropertyDetailView";
import {
  buildOpportunityDetail,
  buildOpportunitySearchResults,
  minimalOpportunityDetailPath,
  opportunityDetailQueryPath,
  opportunitySearchQueryPath,
  parseTypeFilter,
  pickOpportunity,
  selectOpportunityDetailView,
  type MinimalOpportunityDetailRow,
} from "../../minimal/opportunities/minimalOpportunityDetailModel";
import { MinimalOpportunityDetailView, type MinimalOpportunityDetailViewProps } from "../../minimal/opportunities/MinimalOpportunityDetailView";
import { MinimalOpportunitySearchView, type MinimalOpportunitySearchViewProps } from "../../minimal/opportunities/MinimalOpportunitySearchView";

interface El { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
// Expand function components (not hooks-based) so nested Frame/BackLink render.
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  const e = node as El;
  if (typeof e.type === "function" && e.type !== Link) {
    return expand((e.type as (p: unknown) => unknown)(e.props ?? {}));
  }
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
const links = (t: unknown) => all(t, (e) => e.type === Link).map((e) => ({ href: String(e.props?.href), text: text(e) }));
const buttons = (t: unknown) => all(t, (e) => e.type === "button");
const button = (t: unknown, label: string) => buttons(t).find((b) => text(b).trim() === label);

const PROPERTY: MinimalPropertyDetailRow = {
  id: 7, formattedAddress: "7 Example St, Testville QLD 4000", suburb: "Testville", state: "QLD", postcode: "4000",
  workflowStage: "Appraisal", listingStatus: "Not Listed", salesMethod: null, priceDisplay: "Offers over $1",
};
function appraisal(over: Partial<AppraisalListRow>): AppraisalListRow {
  return { id: 1, status: "DRAFT", outcome: null, propertyId: 7, propertyAddress: PROPERTY.formattedAddress, partyId: 3, partyDisplayName: "Sam Synthetic", ownerUserId: 1, ownerName: "Agent", ...over };
}
function opp(over: Partial<MinimalOpportunityDetailRow> = {}): MinimalOpportunityDetailRow {
  return { id: 11, partyId: 3, propertyId: 7, opportunityType: "Listing", status: "Open", stage: "Contacted", reason: "Synthetic reason", nextActionDueAt: null, recommendedNextAction: null, convertedAppraisalId: null, contactName: "Sam Synthetic", ...over };
}

test("parseDetailId accepts positive integers only", () => {
  assert.equal(parseDetailId("12"), 12);
  for (const bad of [undefined, null, "", "0", "-1", "1.5", "abc", "12abc", "99999999999999999999"]) assert.equal(parseDetailId(bad as string), null, String(bad));
});

test("detail route selectors: classic outside Minimal, ?view=full escape", () => {
  for (const sel of [selectPropertyDetailView, selectOpportunityDetailView]) {
    assert.equal(sel(false), "classic");
    assert.equal(sel(true), "minimal");
    assert.equal(sel(true, "?view=full"), "classic");
    assert.equal(sel(true, "?x=1"), "minimal");
  }
  assert.equal(minimalPropertyDetailPath(7), "/grow/properties/7");
  assert.equal(minimalOpportunityDetailPath(11), "/grow/opportunities/11");
});

test("property detail keeps only this property's appraisals and opportunities, open first", () => {
  const m = buildMinimalPropertyDetail(
    PROPERTY,
    [appraisal({ id: 1, status: "DRAFT" }), appraisal({ id: 2, propertyId: 8 })],
    [opp({ id: 11 }), opp({ id: 12, status: "Lost", stage: "Lost" }), opp({ id: 13, propertyId: 9 }), opp({ id: 14, propertyId: null })],
    { runAccess: false },
  );
  assert.deepEqual(m.appraisals.map((a) => a.id), [1]);
  assert.deepEqual(m.opportunities.map((o) => [o.id, o.open]), [[11, true], [12, false]]);
  assert.equal(m.opportunities[0].href, "/grow/opportunities/11");
  assert.equal(m.location, "Testville QLD 4000");
  assert.equal(m.salesMethod, "Not recorded");
  assert.equal(m.priceDisplay, "Offers over $1");
  assert.equal(m.runHref, null, "no Run link without run.access (D5)");
  assert.equal(buildMinimalPropertyDetail(PROPERTY, [], [], { runAccess: true }).runHref, "/properties/7");
});

test("property detail view: loading, error+retry, ready with back link and empty states", () => {
  const loading = expand(MinimalPropertyDetailView({ state: { kind: "loading" } }));
  assert.match(text(loading), /Loading property/);
  assert.ok(links(loading).some((l) => l.href === "/properties" && /Back to Properties/.test(l.text)));

  let retried = 0;
  const err = expand(MinimalPropertyDetailView({ state: { kind: "error", text: "Not found", onRetry: () => retried++ } }));
  assert.match(text(err), /Not found/);
  (button(err, "Try again")!.props!.onClick as () => void)();
  assert.equal(retried, 1);

  const empty = expand(MinimalPropertyDetailView({ state: { kind: "ready", model: buildMinimalPropertyDetail(PROPERTY, [], [], { runAccess: false }) } }));
  assert.match(text(empty), /No appraisal yet/);
  assert.match(text(empty), /No opportunity linked/);
  assert.ok(!links(empty).some((l) => l.text === "Open in Run"));

  const full = expand(MinimalPropertyDetailView({
    state: { kind: "ready", model: buildMinimalPropertyDetail(PROPERTY, [appraisal({})], [opp()], { runAccess: true, opportunityPageFull: true }), relatedError: "boom" },
  }));
  const hrefs = links(full).map((l) => l.href);
  assert.ok(hrefs.includes("/grow/appraisals/1"));
  assert.ok(hrefs.includes("/grow/opportunities/11"));
  assert.ok(hrefs.includes("/grow/contacts/3"));
  assert.ok(hrefs.includes("/properties/7"));
  assert.match(text(full), /latest 100/);
  assert.match(text(full), /boom/);
});

test("property detail asks the server for ?propertyId= and falls back when the API ignores it", () => {
  assert.equal(minimalPropertyOpportunitiesPath(7), "/grow/opportunities?propertyId=7&limit=100");
  // Filtered API: only this property's rows (or none).
  assert.equal(classifyPropertyOpportunityPage([], 7), "property");
  assert.equal(classifyPropertyOpportunityPage([{ propertyId: 7 }, { propertyId: 7 }], 7), "property");
  // Older API ignored the param: rows for other properties or unlinked rows.
  assert.equal(classifyPropertyOpportunityPage([{ propertyId: 7 }, { propertyId: 8 }], 7), "all-properties");
  assert.equal(classifyPropertyOpportunityPage([{ propertyId: null }], 7), "all-properties");

  const other = { ...opp(), id: 99, propertyId: 8 };
  // Fallback still filters in the browser and keeps the "latest 100" note on a full page.
  const fallback = buildMinimalPropertyDetail(PROPERTY, [], [opp(), other], {
    runAccess: false,
    opportunityPageFull: true,
    opportunityScope: classifyPropertyOpportunityPage([opp(), other], PROPERTY.id),
  });
  assert.deepEqual(fallback.opportunities.map((o) => o.id), [11]);
  assert.match(text(expand(MinimalPropertyDetailView({ state: { kind: "ready", model: fallback } }))), /from your latest 100/);

  // Server-filtered, not full: no note at all.
  const filtered = buildMinimalPropertyDetail(PROPERTY, [], [opp()], {
    runAccess: false,
    opportunityPageFull: false,
    opportunityScope: classifyPropertyOpportunityPage([opp()], PROPERTY.id),
  });
  assert.ok(!/latest 100/.test(text(expand(MinimalPropertyDetailView({ state: { kind: "ready", model: filtered } })))));

  // Server-filtered but this property alone has more than 100: honest per-property note, not the cross-property one.
  const filteredFull = buildMinimalPropertyDetail(PROPERTY, [], [opp()], { runAccess: false, opportunityPageFull: true, opportunityScope: "property" });
  const t = text(expand(MinimalPropertyDetailView({ state: { kind: "ready", model: filteredFull } })));
  assert.match(t, /this property's latest 100/);
  assert.ok(!/from your latest 100/.test(t));
});

test("opportunity query paths use existing list params only", () => {
  assert.equal(opportunityDetailQueryPath(11), "/grow/opportunities?id=11&limit=1");
  assert.equal(opportunitySearchQueryPath("  Sam  ", "all"), "/grow/opportunities?limit=50&search=Sam");
  assert.equal(opportunitySearchQueryPath("", "seller_side"), "/grow/opportunities?limit=50&type=seller_side");
  assert.equal(opportunitySearchQueryPath("a&b", "other"), "/grow/opportunities?limit=50&search=a%26b&type=other");
  assert.equal(parseTypeFilter("property_management"), "property_management");
  assert.equal(parseTypeFilter("nonsense"), "all");
});

test("pickOpportunity treats an empty or mismatched page as not found", () => {
  assert.equal(pickOpportunity(undefined, 11), null);
  assert.equal(pickOpportunity([], 11), null);
  assert.equal(pickOpportunity([opp({ id: 12 })], 11), null);
  assert.equal(pickOpportunity([opp()], 11)?.id, 11);
});

test("opportunity detail model: links, stage label, locked actions", () => {
  const m = buildOpportunityDetail(opp({ convertedAppraisalId: 5, lostReason: "  " }));
  assert.equal(m.propertyHref, "/grow/properties/7");
  assert.equal(m.appraisalHref, "/grow/appraisals/5");
  assert.equal(m.contactHref, "/grow/contacts/3");
  assert.equal(m.stageLabel, "Contacted");
  assert.equal(m.lostReason, null);
  assert.ok(m.actions.canMarkLost && !m.actions.stages.includes("Contacted" as never));
  const lost = buildOpportunityDetail(opp({ status: "Lost", stage: "Lost", propertyId: null }));
  assert.equal(lost.closed, true);
  assert.equal(lost.propertyHref, null);
  assert.ok(lost.actions.lockedReason);
});

function detailProps(over: Partial<MinimalOpportunityDetailViewProps> = {}): MinimalOpportunityDetailViewProps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    state: { kind: "ready", model: buildOpportunityDetail(opp()) },
    canManage: true, pending: false, actionError: null, announcement: null, lostReason: null,
    onStage: (s) => calls.push(`stage:${s}`), onStartLost: () => calls.push("startLost"), onLostReason: (t) => calls.push(`reason:${t}`),
    onConfirmLost: () => calls.push("confirmLost"), onCancelLost: () => calls.push("cancelLost"), onClose: () => calls.push("close"),
    ...over,
  };
}

test("opportunity detail view: back link, sections nav, actions wired, read-only without manage", () => {
  const p = detailProps();
  const tree = expand(MinimalOpportunityDetailView(p));
  const hrefs = links(tree).map((l) => l.href);
  assert.ok(hrefs.includes("/grow/opportunities"));
  assert.ok(hrefs.includes("/grow/properties/7"));
  (button(tree, "Qualified")!.props!.onClick as () => void)();
  (button(tree, "Mark lost…")!.props!.onClick as () => void)();
  (button(tree, "Close")!.props!.onClick as () => void)();
  assert.deepEqual(p.calls, ["stage:Qualified", "startLost", "close"]);

  const lostDraft = detailProps({ lostReason: "Synthetic", actionError: "Say why" });
  const lt = expand(MinimalOpportunityDetailView(lostDraft));
  (button(lt, "Mark lost")!.props!.onClick as () => void)();
  assert.deepEqual(lostDraft.calls, ["confirmLost"]);
  assert.match(text(lt), /Say why/);

  const ro = expand(MinimalOpportunityDetailView(detailProps({ canManage: false })));
  assert.equal(buttons(ro).length, 0);

  const pend = expand(MinimalOpportunityDetailView(detailProps({ pending: true })));
  assert.ok(buttons(pend).filter((b) => text(b) !== "Cancel").every((b) => b.props!.disabled === true));
});

test("opportunity detail view: loading and not-found states", () => {
  assert.match(text(expand(MinimalOpportunityDetailView(detailProps({ state: { kind: "loading" } })))), /Loading opportunity/);
  const nf = expand(MinimalOpportunityDetailView(detailProps({ state: { kind: "error", text: "That opportunity couldn't be found." } })));
  assert.match(text(nf), /couldn't be found/);
  assert.equal(button(nf, "Try again"), undefined);
});

function searchProps(over: Partial<MinimalOpportunitySearchViewProps> = {}): MinimalOpportunitySearchViewProps {
  return { search: "", type: "all", active: false, loading: false, error: null, results: [], total: 0, onSearch: () => {}, onType: () => {}, onRetry: () => {}, ...over };
}

test("opportunity search view: idle, loading, empty, error, results link to detail", () => {
  assert.doesNotMatch(text(MinimalOpportunitySearchView(searchProps())), /No opportunities match/);
  assert.match(text(MinimalOpportunitySearchView(searchProps({ active: true, loading: true }))), /Searching/);
  assert.match(text(MinimalOpportunitySearchView(searchProps({ active: true }))), /No opportunities match/);
  let retry = 0;
  const err = MinimalOpportunitySearchView(searchProps({ active: true, error: "nope", onRetry: () => retry++ }));
  (button(err, "Try again")!.props!.onClick as () => void)();
  assert.equal(retry, 1);
  const results = buildOpportunitySearchResults([opp(), opp({ id: 12, contactName: null, opportunityType: "PropertyManagement" })]);
  const tree = MinimalOpportunitySearchView(searchProps({ active: true, results, total: 2 }));
  assert.deepEqual(links(tree).map((l) => l.href), ["/grow/opportunities/11", "/grow/opportunities/12"]);
  assert.match(text(tree), /2 matches/);
  assert.match(text(tree), /Unnamed contact/);
  assert.match(text(tree), /Property management/);
  let typed: string | null = null;
  const sel = all(MinimalOpportunitySearchView(searchProps({ onType: (t) => (typed = t) })), (e) => e.type === "select")[0];
  (sel.props!.onChange as (e: unknown) => void)({ target: { value: "seller_side" } });
  assert.equal(typed, "seller_side");
});

test("pipeline view mounts the opportunity search above the board and a Details link per card", async () => {
  const { MinimalOpportunitiesView } = await import("../../minimal/opportunities/MinimalOpportunitiesView");
  const { buildPipelineBoard } = await import("../../minimal/opportunities/minimalOpportunitiesModel");
  const { default: MinimalOpportunitySearch } = await import("../../minimal/opportunities/MinimalOpportunitySearch");
  const rows = [opp()];
  const noop = () => {};
  const tree = MinimalOpportunitiesView({
    board: buildPipelineBoard(rows), rowsById: new Map(rows.map((r) => [r.id, r])), total: 1, loading: false, error: null, actionError: null,
    canManage: false, showClosed: false, lostDraft: null, pendingId: null, announcement: null,
    onToggleClosed: noop, onStage: noop, onStartLost: noop, onLostReason: noop, onConfirmLost: noop, onCancelLost: noop, onClose: noop, onRetry: noop,
  } as never);
  const kids = ((tree as El).props!.children as unknown[]).flat();
  const searchAt = kids.findIndex((k) => (k as El)?.type === MinimalOpportunitySearch);
  const boardAt = kids.findIndex((k) => (k as El)?.props?.className === "am-ws2-board");
  assert.ok(searchAt > 0 && searchAt < boardAt, "search sits above the board");
  assert.ok(links(tree).some((l) => l.href === "/grow/opportunities/11" && l.text === "Details"));
});
