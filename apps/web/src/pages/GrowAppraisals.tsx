import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiErrorMessage, apiFetch } from "../lib/api";
import { useEntitlements, useSession } from "../lib/session";
import { appraisalStatusLabel } from "../lib/growAppraisals";
import {
  APPRAISAL_PIPELINE_STAGES,
  APPRAISAL_STAGE_LABELS,
  type AppraisalListRow,
  type AppraisalPipelineStageFilter,
  appraisalContactPath,
  appraisalOwnerChoices,
  appraisalWorkspacePath,
  canFilterAppraisalsByOwner,
  filterAppraisalPipeline,
  formatAppraisalDate,
} from "../lib/appraisalUi";

// Grow → Appraisals. One pipeline, backed by GET /grow/appraisals/pipeline.
// Stage, owner, and search narrow that response in the browser. The API has
// already dropped properties this role cannot see.

export default function GrowAppraisals() {
  const { user } = useSession();
  const { hasEntitlement } = useEntitlements();
  const canRead = hasEntitlement("grow.access");
  const showOwner = canFilterAppraisalsByOwner(user?.role);
  const [stage, setStage] = useState<AppraisalPipelineStageFilter>("open");
  const [search, setSearch] = useState("");
  const [ownerUserId, setOwnerUserId] = useState<number | null>(null);

  const pipeline = useQuery<{ appraisals: AppraisalListRow[] }>({
    queryKey: ["grow-appraisals"],
    queryFn: () => apiFetch("/grow/appraisals/pipeline"),
    enabled: canRead,
  });

  if (!canRead) {
    return (
      <div>
        <h1>Appraisals</h1>
        <p className="muted">Grow is not active for your brokerage.</p>
      </div>
    );
  }

  const rows = pipeline.data?.appraisals ?? [];
  const owners = showOwner ? appraisalOwnerChoices(rows) : [];
  const selectedOwner = showOwner && owners.some((owner) => owner.id === ownerUserId) ? ownerUserId : null;
  const visible = filterAppraisalPipeline(rows, { stage, search, ownerUserId: selectedOwner });

  return (
    <div className="appraisal-pipeline">
      <p className="muted">
        <Link href="/grow">Grow</Link>
      </p>
      <h1>Appraisals</h1>
      <p className="muted">
        Filter by stage, and by owner when you can see the brokerage. Search matches the property or the contact.
      </p>

      <div className="appraisal-filters">
        <label htmlFor="appraisal-stage-filter">
          Stage
          <select
            id="appraisal-stage-filter"
            value={stage}
            onChange={(event) => setStage(event.target.value as AppraisalPipelineStageFilter)}
          >
            <option value="all">{APPRAISAL_STAGE_LABELS.all}</option>
            {APPRAISAL_PIPELINE_STAGES.map((value) => (
              <option key={value} value={value}>
                {APPRAISAL_STAGE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        {showOwner && (
          <label htmlFor="appraisal-owner-filter">
            Owner
            <select
              id="appraisal-owner-filter"
              value={selectedOwner ?? ""}
              onChange={(event) => {
                const id = Number(event.target.value);
                setOwnerUserId(Number.isInteger(id) && id > 0 ? id : null);
              }}
            >
              <option value="">All owners</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label htmlFor="appraisal-search">
          Search
          <input
            id="appraisal-search"
            type="search"
            value={search}
            placeholder="Property or contact"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      {pipeline.isLoading && <p className="muted">Loading appraisals…</p>}
      {pipeline.isError && <p className="error-text">{apiErrorMessage(pipeline.error, "Couldn't load appraisals.")}</p>}
      {pipeline.isSuccess && rows.length === 0 && <p className="empty-state">No appraisals yet.</p>}
      {pipeline.isSuccess && rows.length > 0 && visible.length === 0 && (
        <p className="empty-state">No appraisals match.</p>
      )}
      {visible.length > 0 && (
        <ul className="item-list appraisal-pipeline-list">
          {visible.map((row) => (
            <li key={row.id}>
              <article className="appraisal-pipeline-row">
                <h2>
                  <Link href={appraisalWorkspacePath(row.id)}>{row.propertyAddress}</Link>
                </h2>
                <p>
                  Status: {appraisalStatusLabel(row.status)}
                  {row.isFinalised ? " · Finalised" : ""}
                  {row.outcome ? ` — Outcome: ${row.outcome}` : " — Outcome: Not recorded"}
                </p>
                <p>
                  {row.partyId !== null && row.partyDisplayName ? (
                    <Link href={appraisalContactPath(row.partyId)}>{row.partyDisplayName}</Link>
                  ) : (
                    <span className="muted">No contact</span>
                  )}
                  {showOwner && row.ownerName ? <span className="muted"> · {row.ownerName}</span> : null}
                  {row.updatedAt ? <span className="muted"> · Updated {formatAppraisalDate(row.updatedAt)}</span> : null}
                </p>
                <Link href={appraisalWorkspacePath(row.id)} className="btn btn-link btn-small">
                  Open appraisal
                </Link>
              </article>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
