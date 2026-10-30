import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import type { AppraisalListRow } from "../../lib/appraisalUi";
import { useEntitlements } from "../../lib/session";
import {
  buildMinimalPropertyDetail,
  classifyPropertyOpportunityPage,
  minimalPropertyOpportunitiesPath,
  parseDetailId,
  type MinimalPropertyDetailOpportunity,
  type MinimalPropertyDetailRow,
} from "./minimalPropertyDetailModel";
import { MinimalPropertyDetailView } from "./MinimalPropertyDetailView";
import { MinimalPropertyContacts } from "./MinimalPropertyContacts";
import "./properties.css";

// AE Minimal A property detail. Rendered only inside the Minimal shell
// (selectPropertyDetailView; AE_MINIMAL_UX_ENABLED default OFF). Read-only
// apart from Link a Contact / Start appraisal (MinimalPropertyContacts).

export default function MinimalPropertyDetail() {
  const params = useParams<{ id: string }>();
  const id = parseDetailId(params.id);
  const { hasEntitlement } = useEntitlements();
  const growAccess = hasEntitlement("grow.access");

  const property = useQuery<{ property: MinimalPropertyDetailRow }>({
    queryKey: ["property", id],
    queryFn: () => apiFetch(`/properties/${id}`),
    enabled: id !== null,
  });
  const pipeline = useQuery<{ appraisals: AppraisalListRow[] }>({
    queryKey: ["grow-appraisals"],
    queryFn: () => apiFetch("/grow/appraisals/pipeline"),
    enabled: id !== null && growAccess,
  });
  const opportunities = useQuery<{ opportunities: MinimalPropertyDetailOpportunity[]; nextCursor?: string | null }>({
    queryKey: ["minimal-property-detail-opportunities", id],
    queryFn: () => apiFetch(minimalPropertyOpportunitiesPath(id!)),
    enabled: id !== null && growAccess,
  });

  if (id === null) return <MinimalPropertyDetailView state={{ kind: "error", text: "That property couldn't be found." }} />;
  if (property.isLoading) return <MinimalPropertyDetailView state={{ kind: "loading" }} />;
  if (property.isError || !property.data) {
    return (
      <MinimalPropertyDetailView
        state={{
          kind: "error",
          text: apiErrorMessage(property.error, "Couldn't load this property."),
          onRetry: () => void property.refetch(),
        }}
      />
    );
  }
  const relatedError =
    pipeline.isError || opportunities.isError ? "Couldn't load this property's appraisals or opportunities. Refresh to try again." : null;
  const model = buildMinimalPropertyDetail(property.data.property, pipeline.data?.appraisals ?? [], opportunities.data?.opportunities ?? [], {
    runAccess: hasEntitlement("run.access"),
    opportunityPageFull: Boolean(opportunities.data?.nextCursor),
    opportunityScope: classifyPropertyOpportunityPage(opportunities.data?.opportunities ?? [], id),
  });
  return (
    <MinimalPropertyDetailView
      state={{
        kind: "ready",
        model,
        contacts: (
          <MinimalPropertyContacts
            propertyId={id}
            canSearch={growAccess && hasEntitlement("grow.contacts.read")}
            canCreateContact={growAccess && hasEntitlement("grow.contacts.manage")}
            canStartAppraisal={growAccess && hasEntitlement("grow.opportunities.manage") && !pipeline.isLoading}
            existingAppraisalHref={model.appraisals[0]?.href ?? null}
          />
        ),
        relatedError,
        relatedLoading: pipeline.isLoading || opportunities.isLoading,
      }}
    />
  );
}
