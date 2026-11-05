// Owner t275u: Pit Crew records whose authority it is acting on before changing contacts,
// relationships, imports or exports. Desktop only (the phone More page is Claude's).
import { useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import {
  AUTHORITY_REF_MAX,
  getActingAuthority,
  setActingAuthority,
  subscribeActingAuthority,
  validActingAuthority,
} from "../lib/actingAuthority";

type Owner = { id: number; name: string; role: string };

export function useActingAuthority() {
  return useSyncExternalStore(subscribeActingAuthority, getActingAuthority, () => null);
}

export function PitCrewAuthorityBar() {
  const acting = useActingAuthority();
  const queryClient = useQueryClient();
  const owners = useQuery({
    queryKey: ["pit-crew-authority-owners"],
    queryFn: () => apiFetch<{ owners: Owner[] }>("/pit-crew/authority-owners"),
  });
  const [ownerId, setOwnerId] = useState("");
  const [ref, setRef] = useState("");
  const chosen = owners.data?.owners.find((o) => String(o.id) === ownerId) ?? null;
  const candidate = chosen ? { ownerId: chosen.id, ownerName: chosen.name, authorityRef: ref } : null;

  const apply = (next: Parameters<typeof setActingAuthority>[0]) => {
    setActingAuthority(next);
    // Reads are scoped to the owner while acting; refetch everything under the new scope.
    void queryClient.invalidateQueries();
  };

  if (acting) {
    return (
      <section className="card" role="status" data-ae-pc-authority="active">
        <strong>Acting for {acting.ownerName}</strong> — instruction “{acting.authorityRef}”. Changes are recorded as requested by{" "}
        {acting.ownerName} and performed by you.{" "}
        <button className="btn btn-link" data-ae-pc-authority-clear onClick={() => apply(null)}>
          Stop acting
        </button>
        <PrepareExport ownerName={acting.ownerName} />
      </section>
    );
  }
  return (
    <section className="card" data-ae-pc-authority="none">
      <p>
        Pit Crew changes contacts, relationships, imports and exports only on the contact owner&apos;s instruction. Choose the
        agent and enter the instruction reference.
      </p>
      <div className="inline-form">
        <label>
          Agent
          <select data-ae-pc-authority-owner value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Choose an agent</option>
            {(owners.data?.owners ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Instruction reference
          <input data-ae-pc-authority-ref value={ref} maxLength={AUTHORITY_REF_MAX} onChange={(e) => setRef(e.target.value)} />
        </label>
        <button
          className="btn btn-primary"
          data-ae-pc-authority-start
          disabled={!validActingAuthority(candidate)}
          onClick={() => candidate && apply(candidate)}
        >
          Act for this agent
        </button>
      </div>
      {owners.isError ? <p role="alert">Couldn&apos;t load agents.</p> : null}
    </section>
  );
}

// t277u: Pit Crew may prepare an authorised export; it is delivered to the owner, not to Pit Crew.
function PrepareExport({ ownerName }: { ownerName: string }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; rows: number; expiresInDays: number } | { kind: "error"; text: string }>({ kind: "idle" });
  const run = async () => {
    setState({ kind: "busy" });
    try {
      const r = await apiFetch<{ rows: number; expiresInDays: number }>("/grow/contacts/exports", { method: "POST", body: JSON.stringify({}) });
      setState({ kind: "done", rows: r.rows, expiresInDays: r.expiresInDays });
    } catch (e) {
      setState({ kind: "error", text: e instanceof Error ? e.message : "Couldn't prepare the export." });
    }
  };
  return (
    <div className="inline-form">
      <button className="btn btn-secondary btn-small" data-ae-pc-prepare-export disabled={state.kind === "busy"} onClick={() => void run()}>
        Prepare contact export for {ownerName}
      </button>
      {state.kind === "done" ? (
        <span data-ae-pc-export-result>
          Export of {state.rows} contact{state.rows === 1 ? "" : "s"} prepared and delivered to {ownerName}&apos;s export list (expires in {state.expiresInDays} days). You won&apos;t receive the file.
        </span>
      ) : null}
      {state.kind === "error" ? <span role="alert">{state.text}</span> : null}
    </div>
  );
}
