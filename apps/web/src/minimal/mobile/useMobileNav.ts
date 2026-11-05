import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { useEntitlements, useSession } from "../../lib/session";
import { marketActivityQueryPath } from "../market/minimalMarketActivityModel";
import { isFeatureHiddenError, momentumQueryPath } from "../momentum/minimalMomentumModel";
import { aiAvailabilityFrom, applyAiAvailability, type AiCapabilitiesAnswer } from "./mobileCoachAvailability";
import { buildMobileNav, type MobileNav } from "./mobileNavModel";
import { aiToolsMayBeOffered } from "./mobilePermissions";

// AE Mobile (CC Task #64, M2): the one place that builds the phone navigation for a signed-in user.
// The bottom bar and the More screen both call it, so they always agree. It feeds the corrected PR #280
// model (v2) with the session's role and entitlements, and with the same two availability flags
// MinimalShell already computes. It mirrors the shell's two queries exactly (same keys, same retry rule,
// same enabled rule), so react-query shares the cached answers and sends no extra request;
// lib/__tests__/minimalMobileSearchSource.test.ts fails if the shell's queries change and this drifts.
// Display only: the API enforces every entitlement, role and brokerage rule.

const noRetryWhenHidden = (n: number, e: unknown) => !isFeatureHiddenError(e) && n < 1;

export function useMobileNav(): MobileNav {
  const { user } = useSession();
  const { entitlements, isLoading } = useEntitlements();
  const ownerWithoutContext = !!user?.platformOwner && user.ownerSelectedBrokerageId == null;
  const momentum = useQuery<unknown>({
    queryKey: ["grow-momentum", "week"],
    queryFn: () => apiFetch(momentumQueryPath("week")),
    retry: noRetryWhenHidden,
    enabled: !ownerWithoutContext,
  });
  const market = useQuery<unknown>({
    queryKey: ["grow-market-activity", "week", null],
    queryFn: () => apiFetch(marketActivityQueryPath({ range: "week", type: null })),
    retry: noRetryWhenHidden,
    enabled: !ownerWithoutContext,
  });
  // Business Coach is listed only where the deployment has it on. Same key and request as AskAgentEngine's own probe, so it is
  // shared; and it is asked only of a user who holds the entitlement, so nobody else sends the request.
  const ai = useQuery<AiCapabilitiesAnswer>({
    queryKey: ["ai-capabilities"],
    queryFn: () => apiFetch("/ai/capabilities"),
    // Asked only of a user who holds grow.ai.use: nobody else sends it. Whether that user may USE the tools is the server's answer, not ours.
    enabled: !ownerWithoutContext && aiToolsMayBeOffered(entitlements),
    retry: false,
  });
  const nav = buildMobileNav({
    role: user?.role,
    entitlements,
    entitlementsLoading: isLoading,
    ownerWithoutContext,
    marketActivityAvailable: market.isSuccess,
    momentumAvailable: momentum.isSuccess,
  });
  return applyAiAvailability(nav, aiAvailabilityFrom(ai.data));
}
