import { useQuery } from "@tanstack/react-query";
import { Redirect, useSearch } from "wouter";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import { isFeatureHiddenError } from "../momentum/minimalMomentumModel";
import {
  buildMarketRows,
  isMarketActivityResponse,
  marketActivityQueryPath,
  marketCountLines,
  parseMarketFilters,
} from "./minimalMarketActivityModel";
import { MinimalMarketActivityView } from "./MinimalMarketActivityView";
import "../momentum/momentum.css";

// AE Minimal A Market Activity list (CC #26). GET /grow/market-activity only (#248).
// Flag off (404) or no grow.access (403): the page does not exist → back to /grow.

export default function MinimalMarketActivity() {
  const filters = parseMarketFilters(useSearch());
  const q = useQuery<unknown>({
    queryKey: ["grow-market-activity", filters.range, filters.type],
    queryFn: () => apiFetch(marketActivityQueryPath(filters)),
    retry: (n, e) => !isFeatureHiddenError(e) && n < 1,
  });
  if (q.isError && isFeatureHiddenError(q.error)) return <Redirect to="/grow" replace />;
  if (q.isLoading) return <MinimalMarketActivityView filters={filters} state={{ kind: "loading" }} />;
  if (q.isError || !isMarketActivityResponse(q.data)) {
    return (
      <MinimalMarketActivityView
        filters={filters}
        state={{ kind: "error", text: apiErrorMessage(q.error, "Couldn't load market activity."), onRetry: () => void q.refetch() }}
      />
    );
  }
  return (
    <MinimalMarketActivityView
      filters={filters}
      state={{ kind: "ready", rows: buildMarketRows(q.data.events), counts: marketCountLines(q.data.counts), truncated: q.data.truncated }}
    />
  );
}
