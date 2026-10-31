import { useQuery } from "@tanstack/react-query";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import { marketActivityQueryPath } from "../market/minimalMarketActivityModel";
import { isFeatureHiddenError, momentumQueryPath } from "./minimalMomentumModel";
import { marketCardData, momentumCardData } from "./minimalTodayInsightsModel";
import { TodayInsightCardsView, type InsightCardState } from "./MinimalTodayInsightCardsView";
import "./momentum.css";

// Today cards for My Momentum (CC #5) and Market Activity (CC #26), #248 APIs only.
// Mount inside MinimalToday (owned on #241). Each card hides on 404/403.

function cardState<T>(q: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown }, data: T | null, fallback: string): InsightCardState<T> {
  if (q.isError && isFeatureHiddenError(q.error)) return { kind: "hidden" };
  if (q.isLoading) return { kind: "loading" };
  if (q.isError || data === null) return { kind: "error", text: apiErrorMessage(q.error, fallback), onRetry: () => void q.refetch() };
  return { kind: "ready", data };
}

const noRetryWhenHidden = (n: number, e: unknown) => !isFeatureHiddenError(e) && n < 1;

export default function MinimalTodayInsightCards() {
  const momentum = useQuery<unknown>({ queryKey: ["grow-momentum", "week"], queryFn: () => apiFetch(momentumQueryPath("week")), retry: noRetryWhenHidden });
  const market = useQuery<unknown>({
    queryKey: ["grow-market-activity", "week", null],
    queryFn: () => apiFetch(marketActivityQueryPath({ range: "week", type: null })),
    retry: noRetryWhenHidden,
  });
  return (
    <TodayInsightCardsView
      momentum={cardState(momentum, momentum.data === undefined ? null : momentumCardData(momentum.data), "Couldn't load your momentum.")}
      market={cardState(market, market.data === undefined ? null : marketCardData(market.data), "Couldn't load market activity.")}
    />
  );
}
