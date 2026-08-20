import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

interface WorkspaceResponse {
  property: { id: number; formattedAddress: string; workflowStage: string };
  parties: Array<{ role: string; party: { firstName?: string; lastName?: string } | null }>;
  nextActions: Array<{ label: string; status: string; blockedReason?: string | null }>;
}

// The Property Action Screen (Build Brief §13 / ARCHITECTURE.md §4) — the
// screen the whole build orients around. Answers "what needs to happen
// next?" with one primary action, not a module menu.
export default function PropertyWorkspace({ params }: { params: { id: string } }) {
  const propertyId = Number(params.id);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["property-workspace", propertyId],
    queryFn: () => apiFetch<WorkspaceResponse>(`/properties/${propertyId}/workspace`),
  });

  const readyToList = useMutation({
    mutationFn: () => apiFetch(`/properties/${propertyId}/ready-to-list`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["property-workspace", propertyId] }),
  });

  if (isLoading || !data) return <p>Loading…</p>;

  return (
    <div>
      <h1>{data.property.formattedAddress}</h1>
      <p>Stage: {data.property.workflowStage}</p>

      <section>
        <h2>People</h2>
        <ul>
          {data.parties.map((p, i) => (
            <li key={i}>
              {p.role}: {p.party ? `${p.party.firstName ?? ""} ${p.party.lastName ?? ""}` : "—"}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Next Actions</h2>
        {data.nextActions.length === 0 ? (
          <p>No active workflow yet.</p>
        ) : (
          <ul>
            {data.nextActions.map((a, i) => (
              <li key={i}>
                {a.label} — {a.status}
                {a.blockedReason ? ` (${a.blockedReason})` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.property.workflowStage === "Appraisal" && (
        <button onClick={() => readyToList.mutate()}>Ready to List</button>
      )}
    </div>
  );
}
