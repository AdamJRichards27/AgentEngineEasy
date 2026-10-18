// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch, apiErrorMessage } from "../lib/api";
import { appraisalWorkspacePath } from "../lib/appraisalUi";
import {
  LINK_PROPERTY_BEFORE_APPRAISAL,
  appraisalPropertyChoices,
  appraisalReadOnlyReason,
  appraisalStartPropertyChoices,
  appraisalStatusLabel,
  appraisalsForContact,
  otherContactAppraisalsForProperties,
  type GrowAppraisalSummary,
} from "../lib/growAppraisals";
import { growErrorMessage } from "./messages";
import {
  useCanReadAppraisals,
  useCanManageAppraisals,
  useAppraisalPipeline,
  invalidateAppraisalReads,
} from "./useGrowMutations";

function appraisalWriteErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "That couldn't be found.";
  if (error instanceof ApiError && error.status === 400) return apiErrorMessage(error, "Check the details and try again.");
  if (error instanceof ApiError && error.status === 403) {
    return apiErrorMessage(error, "You don't have permission to update this appraisal.");
  }
  if (error instanceof ApiError && error.status === 409) {
    return apiErrorMessage(error, "That step isn't available for this appraisal.");
  }
  return apiErrorMessage(error, "Couldn't update that appraisal. Try again.");
}
function GrowAppraisalRecord({
  appraisal,
  partyId = null,
}: {
  appraisal: GrowAppraisalSummary | null;
  partyId?: number | null;
}) {
  if (!appraisal) return null;
  const readOnlyReason = appraisalReadOnlyReason(appraisal, partyId);

  return (
    <div className="grow-appraisal-record">
      <p>
        {appraisal.propertyAddress} — Status: {appraisalStatusLabel(appraisal.status)}
        {appraisal.outcome ? ` — Outcome: ${appraisal.outcome}` : " — Outcome: Not recorded"}
      </p>
      {readOnlyReason && <p className="muted">{readOnlyReason}</p>}
      <Link href={appraisalWorkspacePath(appraisal.id)} className="btn btn-link btn-small" id={`grow-appraisal-${appraisal.id}-open`}>
        Open appraisal
      </Link>
    </div>
  );
}
export function GrowOpportunityAppraisalActions({
  opportunityId,
  partyId,
  propertyId,
  appraisal,
  canWrite,
}: {
  opportunityId: number;
  partyId: number | null;
  propertyId: number | null;
  appraisal: GrowAppraisalSummary | null;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      apiFetch("/grow/appraisals/from-opportunity", {
        method: "POST",
        body: JSON.stringify({ opportunityId }),
      }),
    onSuccess: () => {
      setErrorMessage(null);
      invalidateAppraisalReads(queryClient, partyId);
    },
    onError: (error) => setErrorMessage(appraisalWriteErrorMessage(error)),
  });

  return (
    <div className="grow-opportunity-appraisal">
      {errorMessage && (
        <p className="error-text" role="alert">
          {errorMessage}
        </p>
      )}
      {canWrite && propertyId === null && <p className="muted">{LINK_PROPERTY_BEFORE_APPRAISAL}</p>}
      {canWrite && propertyId !== null && appraisal == null && (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          id={`grow-opportunity-start-appraisal-${opportunityId}`}
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          Start appraisal
        </button>
      )}
      <GrowAppraisalRecord appraisal={appraisal} partyId={partyId} />
    </div>
  );
}
// Contact 360 lists this contact's appraisals from GET /grow/appraisals/pipeline,
// filtered here by partyId. The pipeline is already limited to properties the
// caller can see. Start posts partyId and one linked property id.
export function GrowContactAppraisalsSection({
  partyId,
  linkedProperties,
}: {
  partyId: number;
  linkedProperties: Array<{ propertyId: number | null; propertyAddress: string | null }>;
}) {
  const queryClient = useQueryClient();
  const canRead = useCanReadAppraisals();
  const canWrite = useCanManageAppraisals();
  const pipeline = useAppraisalPipeline(canRead);
  const [chosenPropertyId, setChosenPropertyId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const choices = appraisalPropertyChoices(linkedProperties);
  const pipelineRows = pipeline.data?.appraisals ?? [];
  const startChoices = appraisalStartPropertyChoices(choices, pipelineRows);
  const propertyId =
    chosenPropertyId !== null && startChoices.some((choice) => choice.id === chosenPropertyId)
      ? chosenPropertyId
      : (startChoices[0]?.id ?? null);

  const start = useMutation({
    mutationFn: (selectedPropertyId: number) =>
      apiFetch("/grow/appraisals/from-contact", {
        method: "POST",
        body: JSON.stringify({ partyId, propertyId: selectedPropertyId }),
      }),
    onSuccess: () => {
      setErrorMessage(null);
      invalidateAppraisalReads(queryClient, partyId);
    },
    onError: (error) => setErrorMessage(appraisalWriteErrorMessage(error)),
  });

  if (!canRead) return null;

  const rows = appraisalsForContact(pipelineRows, partyId);
  const otherRows = otherContactAppraisalsForProperties(
    pipelineRows,
    partyId,
    choices.map((choice) => choice.id),
  );

  return (
    <section className="card">
      <h2>Appraisals</h2>
      {pipeline.isError && <p className="error-text">{growErrorMessage(pipeline.error, "Couldn't load appraisals.")}</p>}
      {canWrite && choices.length === 0 && <p className="muted">{LINK_PROPERTY_BEFORE_APPRAISAL}</p>}
      {canWrite && startChoices.length > 0 && (
        <div className="stack grow-inline-form">
          <label htmlFor="grow-contact-appraisal-property">Property</label>
          <select
            id="grow-contact-appraisal-property"
            value={propertyId ?? ""}
            onChange={(event) => {
              const id = Number(event.target.value);
              setChosenPropertyId(Number.isInteger(id) && id > 0 ? id : null);
            }}
          >
            {startChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary btn-small"
            id="grow-contact-start-appraisal"
            disabled={propertyId === null || start.isPending}
            onClick={() => {
              if (propertyId === null) return;
              start.mutate(propertyId);
            }}
          >
            Start appraisal
          </button>
        </div>
      )}
      {errorMessage && (
        <p className="error-text" role="alert">
          {errorMessage}
        </p>
      )}
      {rows.length === 0 && otherRows.length === 0 && <p className="empty-state">No appraisals yet.</p>}
      {(rows.length > 0 || otherRows.length > 0) && (
        <ul className="item-list">
          {rows.map((appraisal) => (
            <li key={appraisal.id}>
              <GrowAppraisalRecord appraisal={appraisal} partyId={partyId} />
            </li>
          ))}
          {otherRows.map((appraisal) => (
            <li key={appraisal.id}>
              <GrowAppraisalRecord appraisal={appraisal} partyId={partyId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
