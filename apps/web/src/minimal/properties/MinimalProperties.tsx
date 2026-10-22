import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ApiError, apiErrorMessage, apiFetch } from "../../lib/api";
import type { AppraisalListRow } from "../../lib/appraisalUi";
import { useEntitlements } from "../../lib/session";
import { builderPath } from "../appraisal/appraisalBuilderModel";
import {
  type MinimalPropertyOpportunity,
  type MinimalPropertyRelationship,
  type MinimalPropertyRow,
  buildMinimalPropertyCards,
  propertyRelationshipsPath,
  resolveCreateAppraisal,
  resolveStartFailure,
  startAppraisalBody,
  type StartAppraisalBody,
} from "./minimalPropertiesModel";
import { MinimalPropertiesView, type MinimalPropertiesViewProps, type PropertyChooser } from "./MinimalPropertiesView";
import "./properties.css";

// AE Minimal A Properties page, rendered only inside the Minimal shell
// (selectPropertiesView; AE_MINIMAL_UX_ENABLED default OFF). Existing routes only:
//   GET  /properties?q=                    ["properties", q] (same key as PropertiesList)
//   GET  /grow/appraisals/pipeline         ["grow-appraisals"]
//   GET  /grow/opportunities?limit=100     ["minimal-property-opportunities"]
//   GET  /grow/relationships?search=…      on demand, for Create Appraisal
//   POST /grow/appraisals/from-contact     then open the builder

const SEARCH_DEBOUNCE_MS = 300;

export default function MinimalProperties() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canCreateAppraisal = hasEntitlement("grow.access") && hasEntitlement("grow.opportunities.manage");
  const [searchText, setSearchText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [notice, setNotice] = useState<MinimalPropertiesViewProps["notice"]>(null);
  const [chooser, setChooser] = useState<PropertyChooser | null>(null);
  const [pendingPropertyId, setPendingPropertyId] = useState<number | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(searchText), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  const q = debounced.trim();
  const properties = useQuery<{ properties: MinimalPropertyRow[] }>({
    queryKey: ["properties", q],
    queryFn: () => apiFetch(q ? `/properties?q=${encodeURIComponent(q)}` : "/properties"),
  });
  const pipeline = useQuery<{ appraisals: AppraisalListRow[] }>({
    queryKey: ["grow-appraisals"],
    queryFn: () => apiFetch("/grow/appraisals/pipeline"),
    enabled: hasEntitlement("grow.access"),
  });
  const opportunities = useQuery<{ opportunities: MinimalPropertyOpportunity[] }>({
    queryKey: ["minimal-property-opportunities"],
    queryFn: () => apiFetch("/grow/opportunities?limit=100"),
    enabled: hasEntitlement("grow.access"),
  });

  const start = useMutation({
    mutationFn: (body: StartAppraisalBody) =>
      apiFetch<{ appraisal: { id: number } }>("/grow/appraisals/from-contact", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["grow-appraisals"] });
      setChooser(null);
      setPendingPropertyId(null);
      navigate(builderPath(result.appraisal.id));
    },
    onError: (error, body) => {
      setPendingPropertyId(null);
      const failure = resolveStartFailure(
        error instanceof ApiError ? error : null,
        body.propertyId,
        apiErrorMessage(error, "Couldn't start the appraisal. Try again."),
      );
      if (failure.kind === "open-existing") {
        void queryClient.invalidateQueries({ queryKey: ["grow-appraisals"] });
        setChooser(null);
        navigate(failure.builderHref);
        return;
      }
      setNotice({ propertyId: body.propertyId, text: failure.text, href: failure.href, hrefLabel: failure.hrefLabel });
    },
  });

  const rows = properties.data?.properties ?? [];
  const appraisalRows = pipeline.data?.appraisals ?? [];
  const cards = buildMinimalPropertyCards(rows, appraisalRows, opportunities.data?.opportunities ?? []);

  async function createAppraisal(propertyId: number) {
    const property = rows.find((r) => r.id === propertyId);
    if (!property) return;
    setNotice(null);
    setChooser(null);
    setPendingPropertyId(propertyId);
    try {
      const relationships = await apiFetch<{ relationships: MinimalPropertyRelationship[] }>(propertyRelationshipsPath(property.formattedAddress));
      const resolution = resolveCreateAppraisal(propertyId, appraisalRows, relationships.relationships);
      if (resolution.kind === "existing") {
        setPendingPropertyId(null);
        navigate(resolution.builderHref);
      } else if (resolution.kind === "start") {
        start.mutate(resolution.body);
      } else if (resolution.kind === "choose") {
        setPendingPropertyId(null);
        setChooser({ propertyId, choices: resolution.choices });
      } else if (resolution.kind === "closed") {
        setPendingPropertyId(null);
        setNotice({ propertyId, text: resolution.message, href: `/grow/appraisals/${resolution.appraisalId}`, hrefLabel: "Open the appraisal" });
      } else {
        setPendingPropertyId(null);
        setNotice({ propertyId, text: resolution.message, href: `/properties/${propertyId}`, hrefLabel: "Open the property" });
      }
    } catch (error) {
      setPendingPropertyId(null);
      setNotice({ propertyId, text: apiErrorMessage(error, "Couldn't check this property's contacts. Try again.") });
    }
  }

  return (
    <MinimalPropertiesView
      cards={cards}
      search={searchText}
      loading={properties.isLoading}
      error={properties.isError ? apiErrorMessage(properties.error, "Couldn't load properties. Try again.") : null}
      notice={notice}
      chooser={chooser}
      pendingPropertyId={pendingPropertyId}
      canCreateAppraisal={canCreateAppraisal}
      runAccess={hasEntitlement("run.access")}
      onSearch={setSearchText}
      onCreateAppraisal={(id) => void createAppraisal(id)}
      onChooseContact={(propertyId, partyId) => {
        setPendingPropertyId(propertyId);
        start.mutate(startAppraisalBody(partyId, propertyId));
      }}
      onCancelChooser={() => setChooser(null)}
      onRetry={() => void properties.refetch()}
    />
  );
}
