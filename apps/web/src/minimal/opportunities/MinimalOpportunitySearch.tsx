import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GrowOpportunityListTypeFilter } from "@aee/domain";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import type { MinimalOpportunityRow } from "./minimalOpportunitiesModel";
import { buildOpportunitySearchResults, opportunitySearchQueryPath } from "./minimalOpportunityDetailModel";
import { MinimalOpportunitySearchView } from "./MinimalOpportunitySearchView";

// Server-side opportunity search + type filter (GET /grow/opportunities?search=&type=).
// A self-contained block meant to sit above the Minimal pipeline board; each result opens the detail page.

const SEARCH_DEBOUNCE_MS = 300;

export default function MinimalOpportunitySearch() {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [type, setType] = useState<GrowOpportunityListTypeFilter>("all");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  const q = debounced.trim();
  const active = q.length > 0 || type !== "all";
  const results = useQuery<{ opportunities: MinimalOpportunityRow[]; total: number }>({
    queryKey: ["minimal-opportunity-search", q, type],
    queryFn: () => apiFetch(opportunitySearchQueryPath(q, type)),
    enabled: active,
  });
  return (
    <MinimalOpportunitySearchView
      search={text}
      type={type}
      active={active}
      loading={active && results.isLoading}
      error={results.isError ? apiErrorMessage(results.error, "Couldn't search opportunities. Try again.") : null}
      results={buildOpportunitySearchResults(results.data?.opportunities ?? [])}
      total={results.data?.total ?? 0}
      onSearch={setText}
      onType={setType}
      onRetry={() => void results.refetch()}
    />
  );
}
