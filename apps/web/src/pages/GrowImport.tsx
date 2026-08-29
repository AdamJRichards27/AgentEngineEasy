import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../lib/api";

// Mirrors apps/api/src/lib/import/mapping.ts's CANONICAL_FIELDS exactly --
// this list is presentation-only (labels + ordering for the mapping step),
// never re-derives or re-guesses a mapping; the source of truth for what a
// mapping value means stays server-side.
const CANONICAL_FIELDS = [
  "person.title",
  "person.firstName",
  "person.middleName",
  "person.lastName",
  "person.preferredName",
  "person.company",
  "person.email",
  "person.alternateEmail",
  "person.mobile",
  "person.alternatePhone",
  "contactAddress.full",
  "contactAddress.unit",
  "contactAddress.streetNumber",
  "contactAddress.streetName",
  "contactAddress.suburb",
  "contactAddress.state",
  "contactAddress.postcode",
  "contactAddress.country",
  "property.address.full",
  "property.address.unit",
  "property.address.streetNumber",
  "property.address.streetName",
  "property.address.suburb",
  "property.address.state",
  "property.address.postcode",
  "property.type",
  "property.ownership",
  "property.notes",
  "relationship.type",
] as const;
type CanonicalField = (typeof CANONICAL_FIELDS)[number];

const FIELD_LABELS: Record<CanonicalField, string> = {
  "person.title": "Title",
  "person.firstName": "First name",
  "person.middleName": "Middle name",
  "person.lastName": "Last name",
  "person.preferredName": "Preferred name",
  "person.company": "Organisation / company",
  "person.email": "Email",
  "person.alternateEmail": "Alternate email",
  "person.mobile": "Mobile",
  "person.alternatePhone": "Alternate phone",
  "contactAddress.full": "Contact address (full)",
  "contactAddress.unit": "Contact address - unit",
  "contactAddress.streetNumber": "Contact address - street number",
  "contactAddress.streetName": "Contact address - street name",
  "contactAddress.suburb": "Contact address - suburb",
  "contactAddress.state": "Contact address - state",
  "contactAddress.postcode": "Contact address - postcode",
  "contactAddress.country": "Contact address - country",
  "property.address.full": "Property address (full)",
  "property.address.unit": "Property address - unit",
  "property.address.streetNumber": "Property address - street number",
  "property.address.streetName": "Property address - street name",
  "property.address.suburb": "Property address - suburb",
  "property.address.state": "Property address - state",
  "property.address.postcode": "Property address - postcode",
  "property.type": "Property type",
  "property.ownership": "Ownership",
  "property.notes": "Property notes",
  "relationship.type": "Relationship type",
};

interface GrowAccess {
  entitled: boolean;
}

interface ImportJob {
  id: number;
  filename: string;
  sourceFileType: string;
  status: string;
  mapping: Record<string, string | null> | null;
  totalRows: number;
  processedRows: number;
  validRows: number;
  warningRows: number;
  rejectedRows: number;
  duplicateCandidates: number;
  contactsCreated: number;
  contactsUpdated: number;
  propertiesCreated: number;
  propertiesUpdated: number;
  relationshipsCreated: number;
  uploadedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
}

interface ColumnMappingSuggestion {
  sourceHeader: string;
  canonicalField: CanonicalField | null;
  confidence: "high" | "none";
}

interface MappingResult {
  validRows: number;
  warningRows: number;
  rejectedRows: number;
}

interface ImportPreviewSummary {
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  contactsTotal: number;
  contactsNew: number;
  contactsMatchedExact: number;
  contactsMatchedProbable: number;
  contactsMatchedPossible: number;
  propertiesTotal: number;
  propertiesNew: number;
  propertiesMatchedExact: number;
  propertiesMatchedProbable: number;
  propertiesMatchedPossible: number;
  relationshipsTotal: number;
  relationshipsPendingReview: number;
  duplicatesRequiringReview: number;
}

interface MatchResult {
  candidateId: number;
  matchType: "exact" | "probable" | "possible" | "new";
  matchedOn: string[];
  score: number;
}

interface DuplicateReviewItem {
  kind: "contact" | "property";
  groupKey: string;
  matches: MatchResult[];
  suggestedResolution: string;
  requiresDecision: boolean;
}

interface GroupInfo {
  sourceRowNumbers: number[];
  displayName: string;
}

interface ImportPreviewResponse {
  summary: ImportPreviewSummary;
  contactDuplicates: DuplicateReviewItem[];
  propertyDuplicates: DuplicateReviewItem[];
  contactGroupInfo: Record<string, GroupInfo>;
  propertyGroupInfo: Record<string, GroupInfo>;
}

interface ExecuteResult {
  contactsCreated: number;
  contactsUpdated: number;
  propertiesCreated: number;
  propertiesUpdated: number;
  relationshipsCreated: number;
}

interface RollbackReportEntry {
  kind: "party" | "property" | "relationship";
  id: number;
  rolledBack: boolean;
  reason?: string;
}

interface RollbackResult {
  importJobId: number;
  entries: RollbackReportEntry[];
}

function statusLabel(status: string): string {
  switch (status) {
    case "UPLOADED":
    case "MAPPING_REQUIRED":
      return "Needs mapping";
    case "VALIDATING":
      return "Validating";
    case "REVIEW_REQUIRED":
      return "Ready to review";
    case "IMPORTING":
      return "Importing";
    case "COMPLETED":
      return "Completed";
    case "ROLLED_BACK":
      return "Rolled back";
    default:
      return status;
  }
}

function statusPillClass(status: string): string {
  if (status === "COMPLETED") return "pill-success";
  if (status === "ROLLED_BACK") return "pill-danger";
  if (status === "IMPORTING" || status === "VALIDATING") return "pill-warning";
  return "";
}

// This page's own /grow/access check is a rendering convenience only, same
// as Grow.tsx -- every import route is independently re-checked server-side
// via requireEntitlement(grow.import.execute / grow.import.review).
export default function GrowImport() {
  const access = useQuery<GrowAccess>({
    queryKey: ["grow-access"],
    queryFn: () => apiFetch("/grow/access"),
  });

  if (access.isLoading) {
    return <div className="app-loading">Loading…</div>;
  }

  if (!access.data?.entitled) {
    return (
      <div>
        <h1>Import contacts &amp; properties</h1>
        <section className="card grow-locked">
          <h2>Grow is not active for your brokerage</h2>
          <p className="muted">
            Importing your existing contact and property database is part of Grow.{" "}
            <Link href="/grow">Go to Grow</Link> to add it.
          </p>
        </section>
      </div>
    );
  }

  return <ImportWorkspace />;
}

function ImportWorkspace() {
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [suggestionsByJob, setSuggestionsByJob] = useState<Record<number, ColumnMappingSuggestion[]>>({});

  if (activeJobId !== null) {
    return (
      <ImportJobWizard
        jobId={activeJobId}
        suggestions={suggestionsByJob[activeJobId]}
        onExit={() => setActiveJobId(null)}
      />
    );
  }

  return (
    <ImportHistory
      onOpenJob={(id) => setActiveJobId(id)}
      onUploaded={(job, suggestedMapping) => {
        setSuggestionsByJob((s) => ({ ...s, [job.id]: suggestedMapping }));
        setActiveJobId(job.id);
      }}
    />
  );
}

function ImportHistory({
  onOpenJob,
  onUploaded,
}: {
  onOpenJob: (id: number) => void;
  onUploaded: (job: ImportJob, suggestedMapping: ColumnMappingSuggestion[]) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const queryClient = useQueryClient();
  const jobs = useQuery<{ jobs: ImportJob[] }>({
    queryKey: ["import-jobs"],
    queryFn: () => apiFetch("/import/jobs"),
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new ApiError(400, "Choose a file first.");
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import/jobs", { method: "POST", body: form, credentials: "include" });
      if (!res.ok) {
        let serverMessage: string | undefined;
        try {
          const body = await res.json();
          serverMessage = typeof body?.error === "string" ? body.error : undefined;
        } catch {
          // non-JSON error body -- fall through with no server message
        }
        throw new ApiError(res.status, serverMessage ?? "That file couldn't be uploaded. Check the format and try again.");
      }
      return res.json() as Promise<{ job: ImportJob; suggestedMapping: ColumnMappingSuggestion[] }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["import-jobs"] });
      setFile(null);
      onUploaded(data.job, data.suggestedMapping);
    },
  });

  return (
    <div>
      <h1>Import contacts &amp; properties</h1>
      <p className="muted">
        Bring in your existing contact and property database -- matched against what's already here, never
        overwritten blind.
      </p>

      <section className="card">
        <h2>Start a new import</h2>
        <p className="muted">CSV or Excel (.xlsx), up to 50,000 rows.</p>
        <div className="stack">
          <input
            type="file"
            accept=".csv,.xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button
            className="btn btn-primary"
            disabled={!file || upload.isPending}
            onClick={() => upload.mutate()}
          >
            {upload.isPending ? "Uploading…" : "Upload & continue"}
          </button>
          {upload.isError && <p className="error-text">{(upload.error as ApiError).friendly}</p>}
        </div>
      </section>

      <section className="card">
        <h2>Import history</h2>
        {jobs.isLoading && <p className="muted">Loading…</p>}
        {jobs.data?.jobs.length === 0 && <p className="empty-state">No imports yet.</p>}
        {jobs.data && jobs.data.jobs.length > 0 && (
          <table className="grow-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Status</th>
                <th>Uploaded</th>
                <th>Rows</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.jobs
                .slice()
                .reverse()
                .map((j) => (
                  <tr key={j.id}>
                    <td>{j.filename}</td>
                    <td>
                      <span className={`pill ${statusPillClass(j.status)}`}>{statusLabel(j.status)}</span>
                    </td>
                    <td>{new Date(j.uploadedAt).toLocaleString()}</td>
                    <td>{j.totalRows}</td>
                    <td>
                      <button className="btn btn-link btn-small" onClick={() => onOpenJob(j.id)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function ImportJobWizard({
  jobId,
  suggestions,
  onExit,
}: {
  jobId: number;
  suggestions: ColumnMappingSuggestion[] | undefined;
  onExit: () => void;
}) {
  const queryClient = useQueryClient();
  const job = useQuery<{ job: ImportJob }>({
    queryKey: ["import-job", jobId],
    queryFn: () => apiFetch(`/import/jobs/${jobId}`),
  });

  if (job.isLoading || !job.data) {
    return <div className="app-loading">Loading…</div>;
  }

  const current = job.data.job;
  const refreshJob = () => queryClient.invalidateQueries({ queryKey: ["import-job", jobId] });

  return (
    <div>
      <div className="inline-form">
        <button className="btn btn-link btn-small" onClick={onExit}>
          &larr; Import history
        </button>
      </div>
      <h1>{current.filename}</h1>

      {(current.status === "UPLOADED" || current.status === "MAPPING_REQUIRED") &&
        (suggestions ? (
          <MappingStep job={current} suggestions={suggestions} onMapped={refreshJob} />
        ) : (
          <section className="card">
            <h2>This import needs to be re-opened</h2>
            <p className="muted">
              Its column mapping wasn't finished before this page was reloaded. Upload the file again to continue --
              nothing was changed yet.
            </p>
            <button className="btn btn-secondary" onClick={onExit}>
              Back to import history
            </button>
          </section>
        ))}

      {current.status === "VALIDATING" && <div className="app-loading">Validating…</div>}

      {current.status === "REVIEW_REQUIRED" && <PreviewStep job={current} onExecuted={refreshJob} />}

      {current.status === "IMPORTING" && <div className="app-loading">Import running…</div>}

      {current.status === "COMPLETED" && <ResultsStep job={current} onRolledBack={refreshJob} />}

      {current.status === "ROLLED_BACK" && (
        <section className="card">
          <h2>This import was rolled back</h2>
          <p className="muted">
            Everything this job created has been removed or reported as not safe to remove -- see the rollback
            report for details.
          </p>
        </section>
      )}
    </div>
  );
}

function MappingStep({
  job,
  suggestions,
  onMapped,
}: {
  job: ImportJob;
  suggestions: ColumnMappingSuggestion[];
  onMapped: () => void;
}) {
  const [mapping, setMapping] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const s of suggestions) m[s.sourceHeader] = s.canonicalField ?? "";
    return m;
  });
  const [result, setResult] = useState<MappingResult | null>(null);

  const submit = useMutation({
    mutationFn: () => {
      const payload: Record<string, string | null> = {};
      for (const [header, field] of Object.entries(mapping)) payload[header] = field || null;
      return apiFetch<MappingResult>(`/import/jobs/${job.id}/mapping`, {
        method: "PUT",
        body: JSON.stringify({ mapping: payload }),
      });
    },
    onSuccess: (data) => setResult(data),
  });

  return (
    <section className="card">
      <h2>Map your columns</h2>
      <p className="muted">
        We matched what we could recognise. Check each row and fix anything before continuing -- nothing is
        guessed silently.
      </p>
      <table className="grow-table">
        <thead>
          <tr>
            <th>Your column</th>
            <th>Maps to</th>
          </tr>
        </thead>
        <tbody>
          {suggestions.map((s) => (
            <tr key={s.sourceHeader}>
              <td>
                {s.sourceHeader}
                {s.confidence === "none" && <span className="muted"> (unrecognised)</span>}
              </td>
              <td>
                <select
                  value={mapping[s.sourceHeader] ?? ""}
                  onChange={(e) => setMapping((m) => ({ ...m, [s.sourceHeader]: e.target.value }))}
                >
                  <option value="">— Do not import —</option>
                  {CANONICAL_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {FIELD_LABELS[f]}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="stack">
        <button className="btn btn-primary" disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Validating…" : "Validate & continue"}
        </button>
        {submit.isError && <p className="error-text">{(submit.error as ApiError).friendly}</p>}
        {result && (
          <p className="muted">
            {result.validRows} row{result.validRows === 1 ? "" : "s"} ready
            {result.warningRows > 0 ? `, ${result.warningRows} with warnings` : ""}
            {result.rejectedRows > 0 ? `, ${result.rejectedRows} couldn't be used` : ""}.{" "}
            <button className="btn btn-link btn-small" onClick={onMapped}>
              Continue to duplicate review →
            </button>
          </p>
        )}
      </div>
    </section>
  );
}

function PreviewStep({ job, onExecuted }: { job: ImportJob; onExecuted: (result: ExecuteResult) => void }) {
  const preview = useQuery<ImportPreviewResponse>({
    queryKey: ["import-preview", job.id],
    queryFn: () => apiFetch(`/import/jobs/${job.id}/preview`),
  });
  const queryClient = useQueryClient();

  const resolve = useMutation({
    mutationFn: (input: { kind: "contact" | "property"; groupKey: string; resolution: string; candidateId?: number }) =>
      apiFetch(`/import/jobs/${job.id}/resolve`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["import-preview", job.id] }),
  });

  const execute = useMutation({
    mutationFn: () => apiFetch<ExecuteResult>(`/import/jobs/${job.id}/execute`, { method: "POST" }),
    onSuccess: (result) => onExecuted(result),
  });

  if (preview.isLoading || !preview.data) {
    return <div className="app-loading">Loading preview…</div>;
  }

  const { summary, contactDuplicates, propertyDuplicates, contactGroupInfo, propertyGroupInfo } = preview.data;

  return (
    <div>
      <section className="card">
        <h2>Preview</h2>
        <div className="stat-tiles">
          <div className="stat-tile">
            <div className="stat-tile-label">Contacts</div>
            <div className="stat-tile-value">{summary.contactsTotal}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">New contacts</div>
            <div className="stat-tile-value">{summary.contactsNew}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Properties</div>
            <div className="stat-tile-value">{summary.propertiesTotal}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">New properties</div>
            <div className="stat-tile-value">{summary.propertiesNew}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Relationships</div>
            <div className="stat-tile-value">{summary.relationshipsTotal}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Needs review</div>
            <div className="stat-tile-value">{summary.duplicatesRequiringReview}</div>
          </div>
        </div>
        {summary.errorRows > 0 && (
          <p className="error-text">
            {summary.errorRows} row{summary.errorRows === 1 ? "" : "s"} couldn't be imported.{" "}
            <a href={`/api/import/jobs/${job.id}/rejected.csv`} target="_blank" rel="noreferrer">
              Download the list
            </a>
            .
          </p>
        )}
      </section>

      {(contactDuplicates.length > 0 || propertyDuplicates.length > 0) && (
        <section className="card">
          <h2>Duplicate review</h2>
          <p className="muted">
            Anything not decided here uses a safe default: one clear existing match is reused, everything else
            creates a new record.
          </p>
          {contactDuplicates.map((item) => (
            <DuplicateRow
              key={`c-${item.groupKey}`}
              item={item}
              info={contactGroupInfo[item.groupKey]}
              pending={resolve.isPending}
              onResolve={(resolution, candidateId) =>
                resolve.mutate({ kind: "contact", groupKey: item.groupKey, resolution, candidateId })
              }
            />
          ))}
          {propertyDuplicates.map((item) => (
            <DuplicateRow
              key={`p-${item.groupKey}`}
              item={item}
              info={propertyGroupInfo[item.groupKey]}
              pending={resolve.isPending}
              onResolve={(resolution, candidateId) =>
                resolve.mutate({ kind: "property", groupKey: item.groupKey, resolution, candidateId })
              }
            />
          ))}
        </section>
      )}

      <section className="card">
        <h2>Run the import</h2>
        <p className="muted">
          This creates and updates records in Agent Engine. You can undo it immediately after if something looks
          wrong.
        </p>
        <button className="btn btn-primary" disabled={execute.isPending} onClick={() => execute.mutate()}>
          {execute.isPending ? "Importing…" : "Run import"}
        </button>
        {execute.isError && <p className="error-text">{(execute.error as ApiError).friendly}</p>}
      </section>
    </div>
  );
}

function DuplicateRow({
  item,
  info,
  pending,
  onResolve,
}: {
  item: DuplicateReviewItem;
  info: GroupInfo | undefined;
  pending: boolean;
  onResolve: (resolution: string, candidateId?: number) => void;
}) {
  const [candidateId, setCandidateId] = useState<number | undefined>(item.matches[0]?.candidateId);

  return (
    <div className="stack dup-row">
      <div>
        <strong>{info?.displayName ?? item.groupKey}</strong>
        {info && info.sourceRowNumbers.length > 0 && (
          <span className="muted"> -- row{info.sourceRowNumbers.length === 1 ? "" : "s"} {info.sourceRowNumbers.join(", ")}</span>
        )}
        {!item.requiresDecision && (
          <span className="muted"> (default: {item.suggestedResolution === "use_existing" ? "use existing match" : "create new"})</span>
        )}
      </div>
      <ul>
        {item.matches.map((m) => (
          <li key={m.candidateId}>
            {item.kind === "contact" ? "Contact" : "Property"} #{m.candidateId} -- {m.matchType} match on{" "}
            {m.matchedOn.join(", ")} (score {m.score})
          </li>
        ))}
      </ul>
      <div className="inline-form">
        {item.matches.length > 0 && (
          <select value={candidateId ?? ""} onChange={(e) => setCandidateId(Number(e.target.value))}>
            {item.matches.map((m) => (
              <option key={m.candidateId} value={m.candidateId}>
                #{m.candidateId} ({m.matchType})
              </option>
            ))}
          </select>
        )}
        <button
          className="btn btn-secondary btn-small"
          disabled={pending || !candidateId}
          onClick={() => onResolve("use_existing", candidateId)}
        >
          Use existing
        </button>
        <button className="btn btn-secondary btn-small" disabled={pending} onClick={() => onResolve("create_new")}>
          Create new
        </button>
        <button className="btn btn-link btn-small" disabled={pending} onClick={() => onResolve("skip")}>
          Skip
        </button>
      </div>
    </div>
  );
}

function ResultsStep({ job, onRolledBack }: { job: ImportJob; onRolledBack: () => void }) {
  const [rollback, setRollback] = useState<RollbackResult | null>(null);
  const [confirmingRollback, setConfirmingRollback] = useState(false);

  const rollbackMutation = useMutation({
    mutationFn: () => apiFetch<RollbackResult>(`/import/jobs/${job.id}/rollback`, { method: "POST" }),
    onSuccess: (data) => {
      setRollback(data);
      setConfirmingRollback(false);
      onRolledBack();
    },
  });

  return (
    <div>
      <section className="card">
        <h2>Import complete</h2>
        <div className="stat-tiles">
          <div className="stat-tile">
            <div className="stat-tile-label">Contacts created</div>
            <div className="stat-tile-value">{job.contactsCreated}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Contacts updated</div>
            <div className="stat-tile-value">{job.contactsUpdated}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Properties created</div>
            <div className="stat-tile-value">{job.propertiesCreated}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Properties updated</div>
            <div className="stat-tile-value">{job.propertiesUpdated}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Relationships</div>
            <div className="stat-tile-value">{job.relationshipsCreated}</div>
          </div>
        </div>
        {job.rejectedRows > 0 && (
          <p className="muted">
            {job.rejectedRows} row{job.rejectedRows === 1 ? "" : "s"} couldn't be imported.{" "}
            <a href={`/api/import/jobs/${job.id}/rejected.csv`} target="_blank" rel="noreferrer">
              Download the list
            </a>
            .
          </p>
        )}
      </section>

      <section className="card">
        <h2>Undo this import</h2>
        <p className="muted">
          Removes everything this job created that hasn't since been touched or linked to other Grow records.
          Anything that can't be safely removed is reported, not silently skipped.
        </p>
        {!confirmingRollback && !rollback && (
          <button className="btn btn-danger" onClick={() => setConfirmingRollback(true)}>
            Undo this import…
          </button>
        )}
        {confirmingRollback && (
          <div className="inline-form">
            <span>Undo everything this import created?</span>
            <button
              className="btn btn-danger"
              disabled={rollbackMutation.isPending}
              onClick={() => rollbackMutation.mutate()}
            >
              {rollbackMutation.isPending ? "Undoing…" : "Yes, undo it"}
            </button>
            <button className="btn btn-secondary" onClick={() => setConfirmingRollback(false)}>
              Cancel
            </button>
          </div>
        )}
        {rollbackMutation.isError && <p className="error-text">{(rollbackMutation.error as ApiError).friendly}</p>}
        {rollback && (
          <div>
            <p className="muted">
              {rollback.entries.filter((e) => e.rolledBack).length} of {rollback.entries.length} records removed.
            </p>
            {rollback.entries.some((e) => !e.rolledBack) && (
              <ul>
                {rollback.entries
                  .filter((e) => !e.rolledBack)
                  .map((e) => (
                    <li key={`${e.kind}-${e.id}`}>
                      {e.kind} #{e.id} -- {e.reason}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
