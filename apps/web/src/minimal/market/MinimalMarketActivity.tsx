import { Suspense, lazy, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Redirect, useLocation, useSearch } from "wouter";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import { useSession } from "../../lib/session";
import { isFeatureHiddenError } from "../momentum/minimalMomentumModel";
import {
  agentSuburbs,
  buildMarketEventDetail,
  buildMarketRows,
  findMarketEvent,
  isMarketActivityResponse,
  marketActivityQueryPath,
  marketAreaChips,
  marketAreaOf,
  marketCountLines,
  parseMarketFilters,
  resolveMarketArea,
  uniqueSuburbs,
  type MarketPropertyLite,
} from "./minimalMarketActivityModel";
import { MARKET_EVENT_PANEL_ID, MARKET_EVENT_TITLE_ID, MinimalMarketActivityView } from "./MinimalMarketActivityView";
import { MinimalMarketEventFollowUp } from "./MinimalMarketEventFollowUp";
import { marketAreaPinPoints, marketMapPoints } from "./marketMap";
import "../momentum/momentum.css";
import "./market.css";

// AE Minimal A Market Activity list (CC #26; AE Minimal v1.0 V4).
// Existing endpoints only:
//   GET /grow/market-activity?range=&types=&suburbs=   (#248; 404 unless GROW_MARKET_ACTIVITY_ENABLED=true)
//   GET /properties                                    (own-brokerage, visibility-scoped; for the agent's suburbs)
//   GET /parties/by-property/:id, POST /grow/contacts/:partyId/commitments  (Create Follow-Up)
// Flag off (404) or no grow.access (403): the page does not exist → back to /grow.
// The market query waits for the area to resolve, so flag-off shows nothing at all.

// V5: the map library and its CSS load only when the Map tab is opened.
const MinimalMarketMapCanvas = lazy(() => import("./MinimalMarketMapCanvas"));

export default function MinimalMarketActivity() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const filters = parseMarketFilters(search);
  const area = marketAreaOf(filters);
  const session = useSession();
  const userId = session.user?.id ?? null;

  const props = useQuery<{ properties?: MarketPropertyLite[] }>({
    queryKey: ["properties", ""],
    queryFn: () => apiFetch("/properties"),
    retry: false,
  });
  const rows = props.data?.properties ?? [];
  const mine = props.isError ? null : agentSuburbs(rows, userId);
  const visible = props.isError ? [] : uniqueSuburbs(rows);
  const areaReady = area.kind !== "mine" || ((!props.isLoading || props.isError) && !session.isLoading);
  const resolved = resolveMarketArea(area, mine);
  const suburbsKey = resolved.suburbs ? resolved.suburbs.join(",") : "*";

  const q = useQuery<unknown>({
    queryKey: ["grow-market-activity", filters.range, filters.type, suburbsKey],
    queryFn: () => apiFetch(marketActivityQueryPath(filters, resolved.suburbs)),
    enabled: areaReady,
    retry: (n, e) => !isFeatureHiddenError(e) && n < 1,
  });

  const data = isMarketActivityResponse(q.data) ? q.data : null;
  const event = data ? findMarketEvent(data.events, filters.event) : null;
  const detail = event ? buildMarketEventDetail(event, filters) : null;

  // Keyboard: opening a panel moves focus to its heading; Escape closes it.
  useEffect(() => {
    if (!detail) return;
    document.getElementById(MARKET_EVENT_TITLE_ID)?.focus();
    const panel = document.getElementById(MARKET_EVENT_PANEL_ID);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      navigate(detail.closeHref);
      // Return focus to the row's Details link after the panel closes.
      setTimeout(() => (document.querySelector(`[data-mm-event-details="${detail.key}"]`) as HTMLElement | null)?.focus(), 0);
    };
    panel?.addEventListener("keydown", onKey);
    return () => panel?.removeEventListener("keydown", onKey);
  }, [detail?.key, detail?.closeHref]);

  function mapState(events: Parameters<typeof marketMapPoints>[0], pins: Parameters<typeof marketAreaPinPoints>[0]) {
    const points = marketMapPoints(events, filters);
    const areaPins = marketAreaPinPoints(pins);
    return {
      points,
      areaPins,
      total: events.length,
      canvas: (
        <Suspense fallback={<p className="am-empty-note" role="status">Loading map…</p>}>
          <MinimalMarketMapCanvas points={points} areaPins={areaPins} selectedKey={detail?.key ?? null} />
        </Suspense>
      ),
    };
  }

  if (q.isError && isFeatureHiddenError(q.error)) return <Redirect to="/grow" replace />;
  // Nothing (not even chips) until the flag-gated API has answered.
  if (!areaReady || q.isLoading) return <MinimalMarketActivityView filters={filters} state={{ kind: "loading" }} />;
  const areaProps = { chips: marketAreaChips(filters, mine ?? [], visible), note: resolved.note };
  if (q.isError || !data) {
    return (
      <MinimalMarketActivityView
        filters={filters}
        area={areaProps}
        state={{ kind: "error", text: apiErrorMessage(q.error, "Couldn't load market activity."), onRetry: () => void q.refetch() }}
      />
    );
  }
  return (
    <MinimalMarketActivityView
      filters={filters}
      area={areaProps}
      state={{
        kind: "ready",
        rows: buildMarketRows(data.events),
        counts: marketCountLines(data.counts),
        truncated: data.truncated,
        detail,
        followUp: detail?.propertyId != null && detail.propertyHref ? (
          <MinimalMarketEventFollowUp key={detail.key} detail={detail} propertyId={detail.propertyId} propertyHref={detail.propertyHref} />
        ) : null,
        map: filters.view === "map" ? mapState(data.events, data.areaPins) : undefined,
      }}
    />
  );
}
