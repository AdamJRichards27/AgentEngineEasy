import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import type { AppraisalListRow } from "../../lib/appraisalUi";
import { buildMinimalAppraisals, type MinimalAppraisalsTab } from "./minimalAppraisalsModel";
import { MinimalAppraisalsView } from "./MinimalAppraisalsView";

// AB-4: AE Minimal Appraisals list. Existing route only:
//   GET /grow/appraisals/pipeline  ["grow-appraisals"] (same key as Properties)
export default function MinimalAppraisals() {
  const [tab, setTab] = useState<MinimalAppraisalsTab>("active");
  const [search, setSearch] = useState("");
  const pipeline = useQuery<{ appraisals: AppraisalListRow[] }>({
    queryKey: ["grow-appraisals"],
    queryFn: () => apiFetch("/grow/appraisals/pipeline"),
  });
  const model = buildMinimalAppraisals(pipeline.data?.appraisals ?? [], { tab, search });
  return (
    <MinimalAppraisalsView
      model={model}
      search={search}
      loading={pipeline.isLoading}
      error={pipeline.isError ? apiErrorMessage(pipeline.error, "Couldn't load appraisals. Try again.") : null}
      onSearch={setSearch}
      onTab={setTab}
      onRetry={() => void pipeline.refetch()}
    />
  );
}
