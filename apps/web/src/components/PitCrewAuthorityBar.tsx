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
