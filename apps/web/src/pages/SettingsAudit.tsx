// AE 2.0: the restricted Administration workspace for the audit history.
//  - Every Administrator sees ordinary audit metadata (what, which record, who, when) and each entry's access history (who looked at its values, who was refused).
//  - Before and after values are encrypted: they are NEVER drawn as readable text. An explicitly authorised Audit Value Reader can request one entry's values
//    with a mandatory reason; the values are then shown for that entry only, and the access is recorded.
//  - Anyone else sees a plain "for Administrators" message and no data. Whether a user is a reader comes from the server (GET /audit/capabilities), never inferred here.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../lib/api";
import { REASON_MAX, REASON_MIN, actionWords, codeText, parseAuditAccesses, parseAuditCapabilities, parseAuditEntries, parseAuditValues, reasonOk, recordWords, refusalText, valueRows, when, type AuditAccess, type AuditCapabilities, type AuditEntry, type AuditValues } from "../lib/t280uContracts";

export interface AuditViewProps {
  caps: AuditCapabilities | null;
  entries: AuditEntry[];
  names: Record<number, string>;
  loading: boolean;
  failed: boolean;
  hasMore: boolean;
  filter: { recordType: string; recordId: string };
  historyFor: number | null;
  accesses: AuditAccess[];
  historyLoading: boolean;
  requesting: { auditId: number; reason: string } | null;
  shown: Record<number, AuditValues>;
  errors: Record<number, string>;
  busy: boolean;
  onFilterChange: (next: { recordType: string; recordId: string }) => void;
  onApplyFilter: () => void;
  onLoadMore: () => void;
  onToggleHistory: (auditId: number) => void;
  onRequestStart: (auditId: number) => void;
  onRequestChange: (reason: string) => void;
  onRequestConfirm: () => void;
  onRequestCancel: () => void;
  onHideValues: (auditId: number) => void;
}

/** Changed fields as plain "Field: value" lines; anything that isn't a flat set of fields stays as text. React escapes it all. */
function ValueBlock({ text, attr }: { text: string | null; attr: "data-ae-audit-before" | "data-ae-audit-after" }) {
  const rows = valueRows(text);
  const marker = { [attr]: true } as Record<string, boolean>;
  if (rows) return <div {...marker}>{rows.map(([k, v]) => <p key={k} className="muted">{k}: <strong>{v}</strong></p>)}</div>;
  return <pre {...marker}>{text ?? "(none)"}</pre>;
}

const who = (id: number | null, names: Record<number, string>): string => (id === null ? "System" : names[id] ?? `User ${id}`);

export function AuditView(p: AuditViewProps) {
  if (!p.caps) return <div data-ae-audit><h1>Audit history</h1><p className="muted">Loading…</p></div>;
  if (!p.caps.canReadAuditMetadata) {
    return (
      <div data-ae-audit data-ae-audit-restricted>
        <h1>Audit history</h1>
        <p className="muted">The audit history is for Administrators.</p>
        <p><Link href="/settings">Back to Settings</Link></p>
      </div>
    );
  }
  return (
    <div data-ae-audit>
      <h1>Audit history</h1>
      <p className="muted" data-ae-audit-retention>
        Who did what, and when. Changed values are kept encrypted{p.caps.valueRetentionDays !== null ? ` for ${p.caps.valueRetentionDays} days` : ""} and are never shown here unless an authorised Audit Value Reader asks for one entry, with a reason, and that request is recorded.
        {p.caps.metadataRetentionDays !== null ? ` The history itself is kept for ${p.caps.metadataRetentionDays} days.` : ""}
      </p>
      <section className="card stack">
        <form className="inline-form" data-ae-audit-filter onSubmit={(e) => { e.preventDefault(); p.onApplyFilter(); }}>
          <input placeholder="Record type (optional)" value={p.filter.recordType} onChange={(e) => p.onFilterChange({ ...p.filter, recordType: e.target.value })} data-ae-filter-type />
          <input placeholder="Record id (optional)" value={p.filter.recordId} onChange={(e) => p.onFilterChange({ ...p.filter, recordId: e.target.value })} data-ae-filter-id />
          <button type="submit" className="btn btn-secondary btn-small">Filter</button>
        </form>
        {p.loading && p.entries.length === 0 ? <p className="muted">Loading…</p> : null}
        {p.failed ? <p className="error-text" role="alert">Couldn't load the audit history. Try again.</p> : null}
        {!p.loading && !p.failed && p.entries.length === 0 ? <p className="empty-state" data-ae-no-audit>No audit entries match.</p> : null}
        <ul className="item-list">
          {p.entries.map((e) => {
            const requesting = p.requesting && p.requesting.auditId === e.auditId ? p.requesting : null;
            const values = p.shown[e.auditId];
            return (
              <li key={e.auditId} data-ae-audit-entry={e.auditId}>
                <div className="pc-item-header">
                  <span>
                    <strong data-ae-audit-action>{actionWords(e.action)}</strong>
                    <span className="muted"> · {recordWords(e.recordType, e.recordId)}</span>
                  </span>
                </div>
                <p className="muted">{who(e.userId, p.names)} · {when(e.createdAt)}</p>
                <p className="muted" data-ae-audit-values-state>
                  Values: {e.valuesExpired ? "expired (past the retention period)" : e.hasEncryptedValues ? "Encrypted" : "none recorded"}
                </p>
                <div className="inline-form">
                  <button type="button" className="btn btn-link" onClick={() => p.onToggleHistory(e.auditId)} data-ae-audit-history-toggle>
                    {p.historyFor === e.auditId ? "Hide access history" : "Access history"}
                  </button>
                  {p.caps?.isAuditValueReader && e.hasEncryptedValues && !e.valuesExpired && !requesting && !values ? (
                    <button type="button" className="btn btn-secondary btn-small" disabled={p.busy} onClick={() => p.onRequestStart(e.auditId)} data-ae-audit-request>
                      Request values
                    </button>
                  ) : null}
                </div>
                {requesting ? (
                  <div className="stack" data-ae-audit-request-form>
                    <label>
                      Reason for viewing these values ({REASON_MIN} to {REASON_MAX} characters, required; it is recorded)
                      <textarea rows={2} value={requesting.reason} onChange={(ev) => p.onRequestChange(ev.target.value)} data-ae-audit-reason />
                    </label>
                    <div className="inline-form">
                      <button type="button" className="btn btn-primary btn-small" disabled={p.busy || !reasonOk(requesting.reason)} onClick={p.onRequestConfirm} data-ae-audit-confirm>
                        View values
                      </button>
                      <button type="button" className="btn btn-link" onClick={p.onRequestCancel}>Cancel</button>
                    </div>
                  </div>
                ) : null}
                {p.errors[e.auditId] ? <p className="error-text" role="alert" data-ae-audit-error>{p.errors[e.auditId]}</p> : null}
                {values ? (
                  <div className="card" data-ae-audit-values>
                    <p className="muted">Shown for this entry only. This access has been recorded.</p>
                    {values.fields.length > 0 ? <p className="muted">Fields: {values.fields.join(", ")}</p> : null}
                    {values.performedBy ? (
                      <p className="muted" data-ae-audit-performed>
                        Done by {who(values.performedBy.userId, p.names)}{values.performedBy.role ? ` (${values.performedBy.role})` : ""}
                        {values.requestedByUserId !== null ? ` on the authority of ${who(values.requestedByUserId, p.names)}` : ""}
                        {values.authorityRef ? `. Authority reference: ${values.authorityRef}` : ""}
                      </p>
                    ) : null}
                    <p><strong>Before</strong></p>
                    <ValueBlock text={values.before} attr="data-ae-audit-before" />
                    <p><strong>After</strong></p>
                    <ValueBlock text={values.after} attr="data-ae-audit-after" />
                    <button type="button" className="btn btn-link" onClick={() => p.onHideValues(e.auditId)}>Hide values</button>
                  </div>
                ) : null}
                {p.historyFor === e.auditId ? (
                  <div data-ae-audit-history>
                    {p.historyLoading ? <p className="muted">Loading…</p> : null}
                    {!p.historyLoading && p.accesses.length === 0 ? <p className="muted" data-ae-audit-no-access>No one has asked to view these values.</p> : null}
                    <ul className="item-list">
                      {p.accesses.map((a) => (
                        <li key={a.id} data-ae-audit-access={a.outcome}>
                          {who(a.userId, p.names)}{a.role ? ` (${a.role})` : ""} · {a.outcome === "accessed" ? "viewed the values" : `refused (${refusalText(a.refusal)})`} · {when(a.at)}
                          {a.reason ? <span className="muted"> · Reason: {a.reason}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {p.hasMore ? <button type="button" className="btn btn-secondary btn-small" onClick={p.onLoadMore} disabled={p.loading}>Load older entries</button> : null}
      </section>
    </div>
  );
}

export default function SettingsAudit() {
  const caps = useQuery<AuditCapabilities>({ queryKey: ["audit-capabilities"], queryFn: async () => parseAuditCapabilities(await apiFetch("/audit/capabilities")), retry: false });
  const allowed = caps.data?.canReadAuditMetadata === true;
  const names = useQuery<Record<number, string>>({
    queryKey: ["audit-user-names"], enabled: allowed, retry: false,
    queryFn: async () => { try { const r = await apiFetch<{ users: Array<{ id: number; firstName: string; lastName: string }> }>("/auth/admin/users"); return Object.fromEntries(r.users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()])); } catch { return {}; } },
  });
  const [filter, setFilter] = useState({ recordType: "", recordId: "" });
  const [applied, setApplied] = useState({ recordType: "", recordId: "" });
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = async (beforeId: number | null, reset: boolean) => {
    setLoading(true); setFailed(false);
    try {
      const qs = new URLSearchParams({ limit: "50" });
      if (applied.recordType.trim()) qs.set("recordType", applied.recordType.trim());
      if (applied.recordId.trim()) qs.set("recordId", applied.recordId.trim());
      if (beforeId !== null) qs.set("beforeId", String(beforeId));
      const r = parseAuditEntries(await apiFetch(`/audit/metadata?${qs.toString()}`));
      setEntries((cur) => (reset ? r.entries : [...cur, ...r.entries]));
      setNext(r.nextBeforeId);
    } catch (e) {
      setFailed(!(e instanceof ApiError && e.status === 403));
    } finally { setLoading(false); }
  };
  useEffect(() => { if (allowed) void load(null, true); }, [allowed, applied]); // eslint-disable-line react-hooks/exhaustive-deps
  const [historyFor, setHistoryFor] = useState<number | null>(null);
  const history = useQuery<AuditAccess[]>({ queryKey: ["audit-access-history", historyFor], enabled: historyFor !== null, retry: false, queryFn: async () => parseAuditAccesses(await apiFetch(`/audit/access-history?auditId=${historyFor}`)) });
  const [requesting, setRequesting] = useState<{ auditId: number; reason: string } | null>(null);
  const [shown, setShown] = useState<Record<number, AuditValues>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const reveal = useMutation({
    mutationFn: () => apiFetch(`/audit/contact-values/${requesting!.auditId}`, { method: "POST", body: JSON.stringify({ reason: requesting!.reason.trim() }) }),
    onSuccess: (raw) => { const v = parseAuditValues(raw); const id = requesting!.auditId; if (v) setShown((s) => ({ ...s, [id]: v })); setErrors((e) => { const { [id]: _drop, ...rest } = e; return rest; }); setRequesting(null); void history.refetch(); },
    onError: (e) => { const id = requesting!.auditId; setErrors((x) => ({ ...x, [id]: codeText(e, "Couldn't show those values.") })); setRequesting(null); void history.refetch(); },
  });
  return (
    <AuditView
      caps={caps.data ?? null}
      entries={entries}
      names={names.data ?? {}}
      loading={loading}
      failed={failed || caps.isError}
      hasMore={next !== null}
      filter={filter}
      historyFor={historyFor}
      accesses={history.data ?? []}
      historyLoading={history.isFetching}
      requesting={requesting}
      shown={shown}
      errors={errors}
      busy={reveal.isPending}
      onFilterChange={setFilter}
      onApplyFilter={() => setApplied(filter)}
      onLoadMore={() => void load(next, false)}
      onToggleHistory={(id) => setHistoryFor((cur) => (cur === id ? null : id))}
      onRequestStart={(auditId) => setRequesting({ auditId, reason: "" })}
      onRequestChange={(reason) => setRequesting((r) => (r ? { ...r, reason } : r))}
      onRequestConfirm={() => reveal.mutate()}
      onRequestCancel={() => setRequesting(null)}
      onHideValues={(id) => setShown((s) => { const { [id]: _drop, ...rest } = s; return rest; })}
    />
  );
}
