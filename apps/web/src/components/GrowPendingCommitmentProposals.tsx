import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { followupInvalidationKeys, mergeRetainedProposals, pendingCommitmentsQueryKey } from "../lib/callFollowups";
import { viewFromPendingProposal, type CommitmentProposalView, type PendingCommitmentProposal } from "../lib/commitmentProposals";
import { GrowCommitmentProposalCard } from "./GrowCommitmentProposalCard";

// AE GROW Priority 6 Stage F4.3 — Contact 360 "Pending commitment
// proposals": the caller's own, non-expired CREATE_GROW_COMMITMENT
// proposals for this contact (GET /grow/ai-actions/pending-commitments
// ?partyId=), each rendered with the shared review card. Read-only until
// the agent clicks Approve/Reject on a card. Hidden when there are none;
// a load failure is shown inline and never breaks the rest of Contact 360.
export function GrowPendingCommitmentProposals({ partyId, contactName }: { partyId: number; contactName: string }) {
  const queryClient = useQueryClient();
  // Cards acted on here stay visible (with their outcome) after the
  // refreshed list drops them.
  const [retained, setRetained] = useState<CommitmentProposalView[]>([]);
  const pending = useQuery<{ proposals: PendingCommitmentProposal[] }>({
    queryKey: pendingCommitmentsQueryKey(partyId),
    queryFn: () => apiFetch(`/grow/ai-actions/pending-commitments?partyId=${encodeURIComponent(String(partyId))}`),
    retry: false,
  });

  const fetched = (pending.data?.proposals ?? [])
    .filter((row) => row.actionKey === "CREATE_GROW_COMMITMENT")
    .map((row) => viewFromPendingProposal(row, contactName));
  const proposals = mergeRetainedProposals(fetched, retained);

  if (pending.isLoading) return null;
  if (!pending.isError && proposals.length === 0) return null;

  return (
    <section className="grow-pending-proposals" aria-labelledby={`grow-pending-proposals-${partyId}`}>
      <h3 id={`grow-pending-proposals-${partyId}`}>Pending commitment proposals</h3>
      {pending.isError && <p className="muted">Couldn&rsquo;t load pending proposals right now.</p>}
      {proposals.map((proposal) => (
        <GrowCommitmentProposalCard
          key={proposal.actionRequestId}
          proposal={proposal}
          dismissible={false}
          onSettled={() => {
            setRetained((current) =>
              current.some((item) => item.actionRequestId === proposal.actionRequestId) ? current : [...current, proposal],
            );
            for (const queryKey of followupInvalidationKeys(partyId)) {
              queryClient.invalidateQueries({ queryKey });
            }
          }}
        />
      ))}
    </section>
  );
}
