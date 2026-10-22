import { useQuery } from "@tanstack/react-query";
import { Redirect, useSearch } from "wouter";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import {
  buildMomentumModel,
  isFeatureHiddenError,
  isMomentumResponse,
  momentumQueryPath,
  parseMomentumPeriod,
} from "./minimalMomentumModel";
import { MinimalMomentumView } from "./MinimalMomentumView";
import "./momentum.css";

// AE Minimal A My Momentum page (CC #5). GET /grow/momentum only (#248).
// Flag off (404) or no grow.access (403): the page does not exist → back to /grow.

export default function MinimalMomentum() {
  const period = parseMomentumPeriod(useSearch());
  const q = useQuery<unknown>({
    queryKey: ["grow-momentum", period],
    queryFn: () => apiFetch(momentumQueryPath(period)),
    retry: (n, e) => !isFeatureHiddenError(e) && n < 1,
  });
  if (q.isError && isFeatureHiddenError(q.error)) return <Redirect to="/grow" replace />;
  if (q.isLoading) return <MinimalMomentumView period={period} state={{ kind: "loading" }} />;
  if (q.isError || !isMomentumResponse(q.data)) {
    return (
      <MinimalMomentumView
        period={period}
        state={{ kind: "error", text: apiErrorMessage(q.error, "Couldn't load your momentum."), onRetry: () => void q.refetch() }}
      />
    );
  }
  return <MinimalMomentumView period={period} state={{ kind: "ready", period, model: buildMomentumModel(q.data) }} />;
}
