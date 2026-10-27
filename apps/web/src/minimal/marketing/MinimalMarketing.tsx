import { useEffect, useState } from "react";
import { Redirect, useParams } from "wouter";
import { useEntitlements } from "../../lib/session";
import { marketingAllowed, parseMarketingPage, type MarketingTab } from "./minimalMarketingModel";
import { MinimalMarketingView } from "./MinimalMarketingView";
import "./marketing.css";

// AE Minimal v1.0 V7 Marketing container (/grow/marketing/:page?). Grow
// surface: needs grow.access (fails closed while loading). Unknown pages go to
// the Overview. Holds only local UI state (tab, open preview); no API calls.

export default function MinimalMarketing() {
  const params = useParams<{ page?: string }>();
  const { entitlements, isLoading } = useEntitlements();
  const page = parseMarketingPage(params.page);
  const [tab, setTab] = useState<MarketingTab>("recommendations");
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    setTab("recommendations");
    setPreviewId(null);
  }, [page]);

  if (isLoading) return <p className="am-empty-note" role="status">Loading Marketing…</p>;
  if (!marketingAllowed(entitlements)) return <Redirect to="/grow" replace />;
  if (page === null) return <Redirect to="/grow/marketing" replace />;
  return (
    <MinimalMarketingView
      page={page}
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
