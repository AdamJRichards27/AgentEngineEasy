// AE 2.0: imports held for review because their owner can't be established. Shown on the Import page to whoever the server lets review them:
//  - an Administrator can assign an owner (any active Agent or Administrator in the brokerage);
//  - an Agent can take ownership of an import for themselves;
//  - both must give an authority reference (3 to 200 characters).
// Pit Crew is refused by the server and sees nothing here. The reason an import is held, and its status, are shown in words. Controls are drawn only
// when the server's fields say so (canAssignAnyOwner, canAcceptForSelf); the server refuses regardless.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../lib/api";
import { useSession } from "../lib/session";
import { AUTHORITY_REF_MAX, AUTHORITY_REF_MIN, authorityRefOk, codeText, heldReasonText, parseHeldImports, when, type HeldImport } from "../lib/t280uContracts";

export interface OwnerChoice { id: number; name: string; role: string }
export interface HeldDraft { ownerUserId: string; authorityRef: string }

export interface HeldImportsViewProps {
  held: HeldImport[];
  owners: OwnerChoice[];
  drafts: Record<number, HeldDraft>;
  busyId: number | null;
  errorText: string | null;
  selfId: number | null;
  onDraft: (jobId: number, next: HeldDraft) => void;
  onSubmit: (jobId: number) => void;
}

export function HeldImportsView(p: HeldImportsViewProps) {
  if (p.held.length === 0) return null;
  return (
    <section className="card stack" data-ae-held-imports>
      <h2>Imports held for review ({p.held.length})</h2>
      <p className="muted">An import is held when its owner can't be established. Every contact it creates is recorded as the owner's, so an owner must be assigned before it can run.</p>
      <ul className="item-list">
        {p.held.map((h) => {
          const draft = p.drafts[h.importJobId] ?? { ownerUserId: "", authorityRef: "" };
          const open = h.releaseStatus === "held";
          const admin = open && h.canAssignAnyOwner;
          const self = open && !admin && h.canAcceptForSelf;
          const ownerValue = admin ? draft.ownerUserId : self && p.selfId !== null ? String(p.selfId) : "";
          const ready = ownerValue !== "" && authorityRefOk(draft.authorityRef);
          return (
            <li key={h.importJobId} data-ae-held-import={h.importJobId} data-ae-held-status={h.releaseStatus}>
              <div className="pc-item-header">
                <strong>{h.filename}</strong>
                <span className={open ? "pill pill-warning" : "pill pill-success"} data-ae-held-pill>{open ? "Held" : "Released"}</span>
              </div>
              <p className="muted">{h.totalRows} row{h.totalRows === 1 ? "" : "s"}{h.uploadedAt ? ` · uploaded ${when(h.uploadedAt)}` : ""}</p>
              {open ? (
                <>
                  <p data-ae-held-reason>{heldReasonText(h.reasonCode)}</p>
                  <p className="muted" data-ae-held-state>
                    {admin ? "Held for review. Assign an owner to release it." : self ? "Held for review. You can take ownership of this import for yourself, or an administrator can assign the owner." : "Held for review. An administrator must assign the owner."}
                  </p>
                </>
              ) : (
                <p className="muted" data-ae-held-state>
                  Released{h.release ? ` on ${when(h.release.releasedAt)}` : ""}. Authority reference: {h.release?.authorityRef || "none recorded"}.
                </p>
              )}
              {admin || self ? (
                <form className="stack" data-ae-held-form onSubmit={(e) => { e.preventDefault(); if (ready) p.onSubmit(h.importJobId); }}>
                  {admin ? (
                    <label>
                      Assign owner
                      <select value={draft.ownerUserId} onChange={(e) => p.onDraft(h.importJobId, { ...draft, ownerUserId: e.target.value })} data-ae-held-owner>
                        <option value="">Choose an Agent or Administrator</option>
                        {p.owners.map((o) => (
                          <option key={o.id} value={String(o.id)}>{o.name} ({o.role})</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label>
                    Authority reference ({AUTHORITY_REF_MIN} to {AUTHORITY_REF_MAX} characters, required)
                    <input value={draft.authorityRef} onChange={(e) => p.onDraft(h.importJobId, { ...draft, authorityRef: e.target.value })} data-ae-held-authority />
                  </label>
                  <button type="submit" className="btn btn-primary btn-small" disabled={p.busyId !== null || !ready} data-ae-held-submit>
                    {admin ? "Assign owner" : "Take ownership"}
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
      {p.errorText ? <p className="error-text" role="alert" data-ae-held-error>{p.errorText}</p> : null}
    </section>
  );
}

export function HeldImportsPanel() {
  const qc = useQueryClient();
  const { user } = useSession();
  const [drafts, setDrafts] = useState<Record<number, HeldDraft>>({});
  const [errorText, setErrorText] = useState<string | null>(null);
  const q = useQuery<HeldImport[]>({
    queryKey: ["import-held"],
    queryFn: async () => {
      try {
        return parseHeldImports(await apiFetch("/import/held"));
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) return []; // Pit Crew, read-only, other roles: nothing is drawn
        throw e;
      }
    },
    retry: false,
  });
  const needsOwners = (q.data ?? []).some((h) => h.releaseStatus === "held" && h.canAssignAnyOwner);
  const owners = useQuery<OwnerChoice[]>({
    queryKey: ["held-owner-choices"],
    enabled: needsOwners,
    retry: false,
    queryFn: async () => {
      const r = await apiFetch<{ users: Array<{ id: number; firstName: string; lastName: string; role: string; isActive: boolean }> }>("/auth/admin/users");
      return r.users.filter((u) => u.isActive && (u.role === "Agent" || u.role === "Brokerage Administrator")).map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), role: u.role }));
    },
  });
  const assign = useMutation({
    mutationFn: (jobId: number) => {
      const row = (q.data ?? []).find((h) => h.importJobId === jobId)!;
      const d = drafts[jobId] ?? { ownerUserId: "", authorityRef: "" };
      const ownerUserId = row.canAssignAnyOwner ? Number(d.ownerUserId) : user?.id;
      return apiFetch(`/import/jobs/${jobId}/owner`, { method: "POST", body: JSON.stringify({ ownerUserId, authorityRef: d.authorityRef.trim() }) });
    },
    onSuccess: () => { setErrorText(null); setDrafts({}); void qc.invalidateQueries({ queryKey: ["import-held"] }); void qc.invalidateQueries({ queryKey: ["import-jobs"] }); },
    onError: (e) => setErrorText(codeText(e, "Couldn't assign the owner. Try again.")),
  });
  return (
    <HeldImportsView
      held={q.data ?? []}
      owners={owners.data ?? []}
      drafts={drafts}
      busyId={assign.isPending ? (assign.variables ?? null) : null}
      errorText={errorText}
      selfId={user?.id ?? null}
      onDraft={(jobId, next) => setDrafts((d) => ({ ...d, [jobId]: next }))}
      onSubmit={(jobId) => assign.mutate(jobId)}
    />
  );
}
