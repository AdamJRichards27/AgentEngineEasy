import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { ApiError, apiErrorMessage, apiFetch } from "../../lib/api";
import type { AppraisalListRow } from "../../lib/appraisalUi";
import { useEntitlements, useSession } from "../../lib/session";
import { canManageRelationships } from "../../lib/relationshipPermission";
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
import MobilePropertyContacts from "../mobile/MobilePropertyContacts";
import { MobilePropertyDetailView } from "../mobile/MobilePropertyDetailView";
import "../mobile/mobilePropertiesStyles";
import { PROPERTY_NOT_FOUND, propertyLoadMessage } from "../mobile/mobilePropertyMessages";
import { useIsPhone } from "../mobile/useIsPhone";
import { propertyLinkControlsEnabled } from "./minimalPropertyContactsModel";
import "./properties.css";

// AE Minimal A property detail. Rendered only inside the Minimal shell
// (selectPropertyDetailView; AE_MINIMAL_UX_ENABLED default OFF). Read-only
// apart from Link a Contact / Start appraisal (MinimalPropertyContacts).

export default function MinimalPropertyDetail() {
  const params = useParams<{ id: string }>();
  const id = parseDetailId(params.id);
  const { hasEntitlement } = useEntitlements();
  const session = useSession();
  const growAccess = hasEntitlement("grow.access");
  const isPhone = useIsPhone();
  // On a phone the same container renders the phone view: same queries, same actions, a layout made for a phone. Above 760 px nothing changes.
  const View = isPhone ? MobilePropertyDetailView : MinimalPropertyDetailView;

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

  if (id === null) return <View state={{ kind: "error", text: PROPERTY_NOT_FOUND }} />;
  if (property.isLoading) return <View state={{ kind: "loading" }} />;
  if (property.isError || !property.data) {
    // A property in another brokerage is a 404: say so without "Try again", which cannot help and must not hint which it is.
    const failure = propertyLoadMessage(property.error instanceof ApiError ? property.error.status : null, apiErrorMessage(property.error, "Couldn't load this property."));
    return <View state={{ kind: "error", text: failure.text, onRetry: failure.retry ? () => void property.refetch() : undefined }} />;
  }
  const relatedError =
    pipeline.isError || opportunities.isError ? "Couldn't load this property's appraisals or opportunities. Refresh to try again." : null;
  const model = buildMinimalPropertyDetail(property.data.property, pipeline.data?.appraisals ?? [], opportunities.data?.opportunities ?? [], {
    runAccess: hasEntitlement("run.access"),
    opportunityPageFull: Boolean(opportunities.data?.nextCursor),
    opportunityScope: classifyPropertyOpportunityPage(opportunities.data?.opportunities ?? [], id),
  });
  return (
    <View
      state={{
        kind: "ready",
        model,
        // A phone gets the mobile contacts section: linked contacts with roles and a call button, Start appraisal, and the canonical link
        // controls (disabled until the backend supports them). The EXISTING panel (link a contact, Add new contact) is kept inside it,
        // in a disclosure, while those controls are off, so nothing that works today is removed. Above 760 px nothing changes.
        contacts: isPhone ? (
          <MobilePropertyContacts
            propertyId={id}
            propertyLabel={model.address}
            canStartAppraisal={growAccess && hasEntitlement("grow.opportunities.manage") && !pipeline.isLoading}
            canCreateContact={growAccess && hasEntitlement("grow.contacts.manage")}
            existingAppraisalHref={model.appraisals[0]?.href ?? null}
            legacyActions={
              <MinimalPropertyContacts
                propertyId={id}
                canSearch={growAccess && hasEntitlement("grow.contacts.read")}
                canCreateContact={growAccess && hasEntitlement("grow.contacts.manage")}
                canManageLinks={propertyLinkControlsEnabled() && canManageRelationships(hasEntitlement, session.user?.role)}
                canStartAppraisal={false}
                existingAppraisalHref={null}
              />
            }
          />
        ) : (
            <MinimalPropertyContacts
              propertyId={id}
              canSearch={growAccess && hasEntitlement("grow.contacts.read")}
              canCreateContact={growAccess && hasEntitlement("grow.contacts.manage")}
              canManageLinks={propertyLinkControlsEnabled() && canManageRelationships(hasEntitlement, session.user?.role)}
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
