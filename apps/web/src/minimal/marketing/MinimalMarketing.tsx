import { useEffect, useState } from "react";
import { Redirect, useParams } from "wouter";
import { useEntitlements } from "../../lib/session";
import { marketingRouteOutcome, type MarketingTab } from "./minimalMarketingModel";
import { MinimalMarketingView } from "./MinimalMarketingView";
import "./marketing.css";

// AE Minimal v1.0 V7 Marketing container (/grow/marketing/:page?). Grow
// surface: needs grow.access (fails closed while loading). Unknown pages go to
// the Overview. Holds only local UI state (tab, open preview); no API calls.

export default function MinimalMarketing() {
  const params = useParams<{ page?: string }>();
  const { entitlements, isLoading } = useEntitlements();
  const outcome = marketingRouteOutcome(entitlements, isLoading, params.page);
  const page = outcome.kind === "render" ? outcome.page : null;
  const [tab, setTab] = useState<MarketingTab>("recommendations");
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    setTab("recommendations");
    setPreviewId(null);
  }, [page]);

  if (outcome.kind === "loading") return <p className="am-empty-note" role="status">Loading Marketing…</p>;
  if (outcome.kind === "redirect") return <Redirect to={outcome.to} replace />;
  return (
    <MinimalMarketingView
      page={outcome.page}
      tab={tab}
      previewId={previewId}
      on={{
        selectTab: (t) => {
          setTab(t);
          setPreviewId(null);
        },
        preview: (id) => setPreviewId((current) => (current === id ? null : id)),
        closePreview: () => setPreviewId(null),
      }}
    />
  );
}
