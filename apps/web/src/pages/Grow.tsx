// Grow route shell. Panels, hooks, and the contact/opportunity screens live in src/grow
// and are re-exported here so existing callers keep the same module path.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { useSession } from "../lib/session";
import { GrowWorkspace } from "../grow/GrowWorkspace";
import { growErrorMessage } from "../grow/messages";
import type { GrowAccess } from "../grow/types";

// Minimal proving UI for Stage A (ARCHITECTURE.md Grow Subscription/Entitlement/Core Data
// build): a locked upgrade screen for brokerages without grow.access, and a real workspace once
// entitled. This page's own /grow/access check is a rendering convenience only - every
// data-bearing request below is independently re-checked server-side via requireEntitlement.
//
// AE GROW Priority 1 — Grow Today: the entitled workspace below (GrowWorkspace) is now
// tabbed rather than one long flat page — Today (this priority's actual deliverable, and the
// default landing tab), Opportunities, Contacts, Nurture, Performance, Ask AE — mirroring
// PitCrewCommandCentre.tsx's own internal `.pc-tabs` sub-navigation pattern rather than adding
// new top-level wouter routes (RUN already owns the top-level /today Command Centre — see App.tsx).
//
// AE GROW Completion W2-B (G-8): this comment used to say "Nurture AND Performance are
// clearly-labelled coming soon placeholders". Performance stopped being one in Priority 6 Stage C
// — it renders the real AI Business Coach (GrowBusinessCoachTab below). Nurture is still a
// genuine placeholder and stays one until a backend for it exists.
export default function Grow() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const access = useQuery<GrowAccess>({
    queryKey: ["grow-access"],
    queryFn: () => apiFetch("/grow/access"),
  });

  const checkout = useMutation({
    mutationFn: () =>
      apiFetch("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ productCode: "grow" }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grow-access"] });
    },
  });

  if (access.isLoading) {
    return <div className="app-loading">Loading…</div>;
  }

  if (!access.data?.entitled) {
    return (
      <div>
        <h1>Grow</h1>
        <section className="card grow-locked">
          <h2>Grow is not active for your brokerage</h2>
          <p className="muted">
            Grow turns every appraisal, buyer enquiry, and past client into a tracked relationship
            and a visible next action - no separate contact database, no unexplained scores.
          </p>
          {access.data?.billingProviderName === "mock" && (
            <p className="muted pilot-mode-note">
              Sandbox billing — this is test-mode only. No real card is charged and no real subscription is created.
            </p>
          )}
          {user?.role === "Brokerage Administrator" ? (
            <>
              <button className="btn btn-primary" onClick={() => checkout.mutate()} disabled={checkout.isPending}>
                {checkout.isPending ? "Starting checkout…" : "Add Grow"}
              </button>
              {/* AE GROW Completion W2-B (G-5): was `(checkout.error as ApiError).friendly`, which
                  renders the string "undefined" for any failure that isn't an ApiError — a network
                  drop mid-checkout being the obvious one. See growErrorMessage above. */}
              {checkout.isError && (
                <p className="error-text">{growErrorMessage(checkout.error, "Couldn't start checkout. Try again.")}</p>
              )}
            </>
          ) : (
            <p className="muted">Ask a Brokerage Administrator to add Grow from Settings → Billing.</p>
          )}
        </section>
      </div>
    );
  }

  return <GrowWorkspace />;
}

// Re-exported so existing callers that load this module (the deep-link tests)
// keep finding it here. The rules live in lib/growWorkspace.ts.

export { growErrorMessage };
export { GrowToday } from "../grow/GrowToday";
export { GrowContactCommitmentsList } from "../grow/GrowContactCommitmentsList";
export { GrowContactActivityLog } from "../grow/GrowActivityLog";
export { GrowContactAppraisalsSection } from "../grow/GrowAppraisals";
export { GrowNewContactForm } from "../grow/GrowNewContactForm";
export { GrowContactList } from "../grow/GrowContactList";
export { GrowLinkPropertyForm } from "../grow/GrowLinkPropertyForm";
export { GrowContactDetail } from "../grow/GrowContactDetail";
export { GrowNewOpportunityForm } from "../grow/GrowNewOpportunityForm";
export { GrowContactOpportunitiesSection } from "../grow/GrowContactOpportunitiesSection";
export { GrowOpportunitiesTab } from "../grow/GrowOpportunitiesTab";
export { growWorkspaceEntryState } from "../lib/growWorkspace";
