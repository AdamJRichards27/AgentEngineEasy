// AE 2.0: the Contact Owner's export list. Exports the signed-in user owns (or, for Pit Crew, prepared for an owner): scope, created, expiry (7 days),
// status, who it was released to. Only the owner downloads by default; an export that has expired is shown as unavailable with no link; Pit Crew sees
// no download unless the owner has released it to them. The owner can release an export to the person who prepared it, with a reason.
// Download and Release are drawn only when the server says so (canDownload; owner and not expired); the server refuses regardless.
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { EXPORT_STATUS_LABEL, REASON_MAX, REASON_MIN, codeText, exportScope, parseExports, reasonOk, when, type ExportRow } from "../lib/t280uContracts";

export interface ExportsViewProps {
  exports: ExportRow[];
  loading: boolean;
  failed: boolean;
  releasing: { exportId: number; reason: string } | null;
  busy: boolean;
  errorText: string | null;
  onReleaseStart: (exportId: number) => void;
  onReleaseChange: (reason: string) => void;
  onReleaseConfirm: () => void;
  onReleaseCancel: () => void;
  onDownloaded: () => void;
}

const canRelease = (e: ExportRow): boolean => e.mine && e.status !== "expired" && e.initiatedBy !== e.owner && !e.releasedTo.some((r) => r.userId === e.initiatedBy);
const pill = (e: ExportRow): string => (e.status === "ready" ? "pill pill-success" : e.status === "expired" ? "pill pill-warning" : "pill");

export function ExportsView(p: ExportsViewProps) {
  return (
    <div data-ae-exports>
      <h1>Contact exports</h1>
      <p className="muted">
        An export is delivered to the contact owner and stays available for seven days, then it expires and is deleted. Only the owner downloads it, unless the owner releases it to the person who prepared it.
      </p>
      <section className="card stack">
        <h2>Exports{p.loading ? "" : ` (${p.exports.length})`}</h2>
        {p.loading ? <p className="muted">Loading…</p> : null}
        {p.failed ? <p className="error-text" role="alert">Couldn't load your exports. Try again.</p> : null}
        {!p.loading && !p.failed && p.exports.length === 0 ? <p className="empty-state" data-ae-no-exports>No exports yet.</p> : null}
        {p.exports.length > 0 ? (
          <ul className="item-list">
            {p.exports.map((e) => {
              const releasedToInitiator = e.releasedTo.some((r) => r.userId === e.initiatedBy);
              return (
                <li key={e.exportId} data-ae-export={e.exportId} data-ae-export-status={e.status}>
                  <div className="pc-item-header">
                    <strong data-ae-export-scope>{exportScope(e.rows)}</strong>
                    <span className="muted"> {e.mine ? "(your contacts)" : "(prepared for another owner)"}</span>
                    <span className={pill(e)} data-ae-export-pill>{EXPORT_STATUS_LABEL[e.status]}</span>
                  </div>
                  <p className="muted">
                    Created {when(e.preparedAt)} · {e.status === "expired" ? `expired ${when(e.expiresAt)}` : `available until ${when(e.expiresAt)}`}
                    {e.downloadedAt ? ` · downloaded ${when(e.downloadedAt)}` : ""}
                  </p>
                  {e.releasedTo.length > 0 ? <p className="muted" data-ae-export-released>{releasedToInitiator ? "Released to the person who prepared it." : `Released to ${e.releasedTo.length} ${e.releasedTo.length === 1 ? "person" : "people"}.`}</p> : null}
                  {e.status === "expired" ? (
                    <p className="muted" data-ae-export-unavailable>Unavailable: this export has expired and its file has been deleted.</p>
                  ) : e.canDownload ? (
                    <a className="btn btn-primary btn-small" href={`/api/grow/contacts/exports/${e.exportId}/download`} data-ae-export-download onClick={p.onDownloaded}>
                      Download
                    </a>
                  ) : !e.mine ? (
                    <p className="muted" data-ae-export-delivered>Delivered to the owner. Downloading it needs the owner's release.</p>
                  ) : null}
                  {canRelease(e) && !(p.releasing && p.releasing.exportId === e.exportId) ? (
                    <button type="button" className="btn btn-secondary btn-small" disabled={p.busy} onClick={() => p.onReleaseStart(e.exportId)} data-ae-export-release>
                      Release to the person who prepared it
                    </button>
                  ) : null}
                  {p.releasing && p.releasing.exportId === e.exportId ? (
                    <div className="stack" data-ae-release-form>
                      <label>
                        Reason for releasing ({REASON_MIN} to {REASON_MAX} characters)
                        <textarea rows={2} value={p.releasing.reason} onChange={(ev) => p.onReleaseChange(ev.target.value)} data-ae-release-reason />
                      </label>
                      <div className="inline-form">
                        <button type="button" className="btn btn-primary btn-small" disabled={p.busy || !reasonOk(p.releasing.reason)} onClick={p.onReleaseConfirm} data-ae-release-confirm>
                          Release
                        </button>
                        <button type="button" className="btn btn-link" onClick={p.onReleaseCancel}>Cancel</button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {p.errorText ? <p className="error-text" role="alert" data-ae-export-error>{p.errorText}</p> : null}
      </section>
      <p className="muted"><Link href="/grow/import">Imports</Link></p>
    </div>
  );
}

export default function GrowExports() {
  const qc = useQueryClient();
  const [releasing, setReleasing] = useState<{ exportId: number; reason: string } | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const q = useQuery<ExportRow[]>({ queryKey: ["contact-exports"], queryFn: async () => parseExports(await apiFetch("/grow/contacts/exports")), retry: false, refetchInterval: 60_000 });
  const marked = useRef(new Set<number>());
  const mark = useMutation({ mutationFn: (id: number) => apiFetch(`/grow/contacts/exports/${id}/seen`, { method: "POST" }), onSettled: () => void qc.invalidateQueries({ queryKey: ["contact-exports"] }) });
  // The owner has now seen their ready exports: tell the server once each (idempotent there).
  useEffect(() => {
    for (const e of q.data ?? []) {
      if (e.mine && e.status === "ready" && !e.seen && !marked.current.has(e.exportId)) { marked.current.add(e.exportId); mark.mutate(e.exportId); }
    }
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const release = useMutation({
    mutationFn: () => {
      const ex = q.data?.find((x) => x.exportId === releasing!.exportId);
      return apiFetch(`/grow/contacts/exports/${releasing!.exportId}/release`, { method: "POST", body: JSON.stringify({ recipientUserId: ex?.initiatedBy, reason: releasing!.reason.trim() }) });
    },
    onSuccess: () => { setErrorText(null); setReleasing(null); void qc.invalidateQueries({ queryKey: ["contact-exports"] }); },
    onError: (e) => setErrorText(codeText(e, "Couldn't release that export. Try again.")),
  });
  return (
    <ExportsView
      exports={q.data ?? []}
      loading={q.isLoading}
      failed={q.isError}
      releasing={releasing}
      busy={release.isPending}
      errorText={errorText}
      onReleaseStart={(exportId) => { setErrorText(null); setReleasing({ exportId, reason: "" }); }}
      onReleaseChange={(reason) => setReleasing((r) => (r ? { ...r, reason } : r))}
      onReleaseConfirm={() => release.mutate()}
      onReleaseCancel={() => setReleasing(null)}
      onDownloaded={() => { setTimeout(() => void qc.invalidateQueries({ queryKey: ["contact-exports"] }), 1500); setTimeout(() => void qc.invalidateQueries({ queryKey: ["notifications"] }), 1500); }}
    />
  );
}
