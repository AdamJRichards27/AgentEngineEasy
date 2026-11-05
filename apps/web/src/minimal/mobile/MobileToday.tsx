import "./mobileStyles";
import "./mobileToday.css";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import type { GrowTodaySummary } from "../../lib/growToday";
import { useEntitlements, useSession } from "../../lib/session";
import { formatMinimalHeaderDate } from "../../lib/minimalUx";
import { growTodayHeading } from "../../lib/todaySurfaces";
import { marketActivityQueryPath } from "../market/minimalMarketActivityModel";
import { MobileGrowSections } from "./MobileGrowSections";
import { buildMinimalTodayModel, formatMinimalAsOf } from "../minimalTodayModel";
import { isFeatureHiddenError, momentumQueryPath } from "../momentum/minimalMomentumModel";
import { marketCardData, momentumCardData } from "../momentum/minimalTodayInsightsModel";
import { MobileSearchBar } from "./MobileSearchBar";
import { MobileTodayView } from "./MobileTodayView";
import { MOBILE_ASK_AE_ON_TODAY, MOBILE_TODAY_SHOWS_GROW_SECTIONS } from "./mobileTodayConfig";
import { buildMobileTodayLayout } from "./mobileTodayLayout";

// AE Mobile (CC Task #64, M3): the phone Today. The container. It uses the data the desktop Today
// already uses, with no new endpoint:
//   GET /grow/today                 (key ["grow-today"], the same query MinimalToday runs)
//   GET /grow/momentum, /grow/market-activity   (the same two cached queries the Today cards run)
// The queries and their retry rule mirror MinimalTodayInsightCards exactly, so react-query shares
// the answers and sends nothing extra; lib/__tests__/minimalMobileTodaySource.test.ts fails if
// they drift. Not wired into any route until the wiring pull request is approved.

const noRetryWhenHidden = (n: number, e: unknown) => !isFeatureHiddenError(e) && n < 1;

export default function MobileToday() {
  const { user } = useSession();
  const { hasEntitlement } = useEntitlements();
  const [expanded, setExpanded] = useState(false);

  const today = useQuery<GrowTodaySummary>({
    queryKey: ["grow-today"],
    queryFn: () => apiFetch("/grow/today"),
  });
  const momentum = useQuery<unknown>({ queryKey: ["grow-momentum", "week"], queryFn: () => apiFetch(momentumQueryPath("week")), retry: noRetryWhenHidden });
  const market = useQuery<unknown>({
    queryKey: ["grow-market-activity", "week", null],
    queryFn: () => apiFetch(marketActivityQueryPath({ range: "week", type: null })),
    retry: noRetryWhenHidden,
  });

  const model = today.data ? buildMinimalTodayModel(today.data, new Date(), hasEntitlement) : null;
  const layout = model
    ? buildMobileTodayLayout(
        model,
        {
          // A hidden (404/403) or failed query simply offers no shortcut.
          momentum: momentum.data === undefined ? null : momentumCardData(momentum.data),
          market: market.data === undefined ? null : marketCardData(market.data),
          askAeAvailable: MOBILE_ASK_AE_ON_TODAY,
        },
        expanded,
      )
    : null;

  return (
    <MobileTodayView
      searchSlot={<MobileSearchBar />}
      sectionsSlot={MOBILE_TODAY_SHOWS_GROW_SECTIONS ? <MobileGrowSections current="today" /> : null}
      dateLabel={formatMinimalHeaderDate(new Date())}
      greeting={growTodayHeading(user?.firstName)}
      loading={today.isLoading}
      error={today.isError ? { text: apiErrorMessage(today.error, "Couldn't load Today."), onRetry: () => void today.refetch() } : null}
      layout={layout}
      asOf={today.data ? formatMinimalAsOf(today.data.generatedAt) : null}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((v) => !v)}
      onRefresh={() => void today.refetch()}
    />
  );
}
