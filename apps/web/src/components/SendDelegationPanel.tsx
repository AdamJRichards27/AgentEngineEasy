// AE 2.0: who may SEND this proposal or listing agreement. Attached to the specific record (an appraisal or a document package).
//  - The owning Agent (or a dual-role Administrator who owns it) can delegate sending to another Agent or Administrator, with a mandatory reason; the
//    delegation lasts 30 days, then expires; the owner can renew or revoke it. Expired, revoked and no-longer-valid delegations are shown as such.
//  - An Administrator who is not the owner sees the delegations read-only ("Review only"). A delegate sees their own delegation.
//  - Pit Crew is refused by the server and sees NOTHING here. There is no send action anywhere in this panel: sending stays on the record's own button.
// Every action is drawn only when the server's fields allow it (canManage, renewable, revocable); the server refuses regardless.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../lib/api";
import { DELEGATION_STATE_LABEL, REASON_MAX, REASON_MIN, codeText, delegationDetail, parseDelegationStatus, reasonOk, type DelegationRow, type DelegationStatus } from "../lib/t280uContracts";

export interface GrantForm { delegateUserId: string; reason: string }
export interface Renewing { delegateUserId: number; reason: string }

export interface SendDelegationPanelViewProps {
  status: DelegationStatus;
  grant: GrantForm;
  renewing: Renewing | null;
  busy: boolean;
  errorText: string | null;
  onGrantChange: (next: GrantForm) => void;
  onGrant: () => void;
  onRenewStart: (delegateUserId: number) => void;
  onRenewChange: (reason: string) => void;
  onRenewConfirm: () => void;
  onRenewCancel: () => void;
  onRevoke: (delegateUserId: number) => void;
}

const pillClass = (d: DelegationRow): string => (d.state === "active" ? "pill pill-success" : d.state === "expired" ? "pill pill-warning" : "pill");

export function SendDelegationPanelView(p: SendDelegationPanelViewProps) {
  const { status } = p;
  const owner = status.viewer === "owner";
  const activeIds = new Set(status.delegations.filter((d) => d.state === "active").map((d) => d.delegateUserId));
  const choices = status.eligibleDelegates.filter((e) => !activeIds.has(e.userId));
  const grantReady = p.grant.delegateUserId !== "" && reasonOk(p.grant.reason);
  return (
    <section className="card stack" data-ae-send-delegation data-ae-viewer={status.viewer}>
      <h3>Who can send this</h3>
      {owner ? (
        <p className="muted" data-ae-delegation-note>
          Only you, as the owner of this record, can send it, unless you delegate sending to another Agent or Administrator. A delegation lasts {status.ttlDays} days and then expires; you can renew or revoke it.
        </p>
      ) : status.viewer === "admin" ? (
        <p className="muted" data-ae-delegation-note>Review only. The owning agent sends this, or records a delegation to you.</p>
      ) : (
        <p className="muted" data-ae-delegation-note>Sending authority recorded for you on this record.</p>
      )}
      {status.delegations.length === 0 ? (
        <p className="empty-state" data-ae-no-delegations>{owner ? "No delegation recorded. Only you can send this." : "No delegation recorded."}</p>
      ) : (
        <ul className="item-list">
          {status.delegations.map((d) => (
            <li key={`${d.delegateUserId}-${d.grantedAt}`} data-ae-delegation={d.state}>
              <div className="pc-item-header">
                <strong>{d.delegateName}</strong>
                {d.delegateRole ? <span className="muted"> ({d.delegateRole})</span> : null}
                <span className={pillClass(d)} data-ae-delegation-state>{DELEGATION_STATE_LABEL[d.state]}</span>
              </div>
              <p className="muted" data-ae-delegation-detail>{delegationDetail(d)}</p>
              {d.reason ? <p className="muted">Reason: {d.reason}</p> : null}
              {d.renewalCount > 0 ? <p className="muted">Renewed {d.renewalCount} time{d.renewalCount === 1 ? "" : "s"}.</p> : null}
              {p.renewing && p.renewing.delegateUserId === d.delegateUserId ? (
                <div className="stack" data-ae-renew-form>
                  <label>
                    Reason for renewing ({REASON_MIN} to {REASON_MAX} characters)
                    <textarea rows={2} value={p.renewing.reason} onChange={(e) => p.onRenewChange(e.target.value)} data-ae-renew-reason />
                  </label>
                  <div className="inline-form">
                    <button type="button" className="btn btn-primary btn-small" disabled={p.busy || !reasonOk(p.renewing.reason)} onClick={p.onRenewConfirm} data-ae-renew-confirm>
                      Renew for {status.ttlDays} days
                    </button>
                    <button type="button" className="btn btn-link" onClick={p.onRenewCancel}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="inline-form">
                  {d.renewable ? (
                    <button type="button" className="btn btn-secondary btn-small" disabled={p.busy} onClick={() => p.onRenewStart(d.delegateUserId)} data-ae-renew>
                      Renew
                    </button>
                  ) : null}
                  {d.revocable ? (
                    <button type="button" className="btn btn-danger btn-small" disabled={p.busy} onClick={() => p.onRevoke(d.delegateUserId)} data-ae-revoke>
                      Revoke
                    </button>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {status.canManage && choices.length > 0 ? (
        <form
          className="stack"
          data-ae-delegate-form
          onSubmit={(e) => {
            e.preventDefault();
            if (grantReady) p.onGrant();
          }}
        >
          <label>
            Delegate sending to
            <select value={p.grant.delegateUserId} onChange={(e) => p.onGrantChange({ ...p.grant, delegateUserId: e.target.value })} data-ae-delegate-select>
              <option value="">Choose a person</option>
              {choices.map((c) => (
                <option key={c.userId} value={String(c.userId)}>{c.name}{c.role ? ` (${c.role})` : ""}</option>
              ))}
            </select>
          </label>
          <label>
            Reason ({REASON_MIN} to {REASON_MAX} characters, required)
            <textarea rows={2} value={p.grant.reason} onChange={(e) => p.onGrantChange({ ...p.grant, reason: e.target.value })} data-ae-delegate-reason />
          </label>
          <p className="muted" data-ae-delegate-expiry>This delegation lasts {status.ttlDays} days from when you record it, then expires.</p>
          <button type="submit" className="btn btn-primary btn-small" disabled={p.busy || !grantReady} data-ae-delegate-submit>
            Delegate sending
          </button>
        </form>
      ) : null}
      {p.errorText ? <p className="error-text" role="alert" data-ae-delegation-error>{p.errorText}</p> : null}
    </section>
  );
}

export function SendDelegationPanel({ recordType, recordId }: { recordType: "appraisal" | "document_package"; recordId: number }) {
  const qc = useQueryClient();
  const key = ["send-delegations", recordType, recordId];
  const [grant, setGrant] = useState<GrantForm>({ delegateUserId: "", reason: "" });
  const [renewing, setRenewing] = useState<Renewing | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const q = useQuery<DelegationStatus | null>({
    queryKey: key,
    queryFn: async () => {
      try {
        return parseDelegationStatus(await apiFetch(`/send-delegations?recordType=${recordType}&recordId=${recordId}`));
      } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null; // Pit Crew, or not this brokerage's record: nothing is drawn
        throw e;
      }
    },
    retry: false,
    staleTime: 15_000,
  });
  const done = () => { setErrorText(null); setGrant({ delegateUserId: "", reason: "" }); setRenewing(null); void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ["send-delegation-check", recordType, recordId] }); };
  const fail = (e: unknown) => setErrorText(codeText(e, "Couldn't update the delegation. Try again."));
  const post = (path: string, body: Record<string, unknown>) => apiFetch(path, { method: "POST", body: JSON.stringify({ recordType, recordId, ...body }) });
  const doGrant = useMutation({ mutationFn: () => post("/send-delegations", { delegateUserId: Number(grant.delegateUserId), reason: grant.reason.trim() }), onSuccess: done, onError: fail });
  const doRenew = useMutation({ mutationFn: () => post("/send-delegations/renew", { delegateUserId: renewing!.delegateUserId, reason: renewing!.reason.trim() }), onSuccess: done, onError: fail });
  const doRevoke = useMutation({ mutationFn: (delegateUserId: number) => post("/send-delegations/revoke", { delegateUserId }), onSuccess: done, onError: fail });
  if (q.isLoading || !q.data) return null;
  return (
    <SendDelegationPanelView
      status={q.data}
      grant={grant}
      renewing={renewing}
      busy={doGrant.isPending || doRenew.isPending || doRevoke.isPending}
      errorText={errorText ?? (q.isError ? "Couldn't load who can send this." : null)}
      onGrantChange={setGrant}
      onGrant={() => doGrant.mutate()}
      onRenewStart={(id) => setRenewing({ delegateUserId: id, reason: "" })}
      onRenewChange={(reason) => setRenewing((r) => (r ? { ...r, reason } : r))}
      onRenewConfirm={() => doRenew.mutate()}
      onRenewCancel={() => setRenewing(null)}
      onRevoke={(id) => doRevoke.mutate(id)}
    />
  );
}
