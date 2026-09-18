import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../lib/api";
import {
  createReviewItems,
  serializeReviewItems,
  transcriptionStatusLabel,
  validateReviewItems,
  type LocalReviewItem,
  type ReviewDecision,
  type ReviewDraftItem,
  type ReviewItemType,
} from "../lib/callTranscriptReview";

interface CallTranscription {
  id: number;
  callSessionId: number;
  processingState: string;
  transcript: string | null;
  draftSummary: string | null;
  draftKeyPoints: ReviewDraftItem[] | null;
  draftCommitments: ReviewDraftItem[] | null;
  draftFollowups: ReviewDraftItem[] | null;
  failureReason: string | null;
  createdAt: string;
}

interface TranscriptListResponse {
  transcriptions: CallTranscription[];
}

interface ReviewEntry {
  itemType: "TRANSCRIPT" | ReviewItemType;
  itemId: string;
  decision: ReviewDecision;
  editedText?: string | null;
  rejectionReason?: string | null;
}

function friendlyError(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.friendly : fallback;
}

function manualId() {
  return `manual-${crypto.randomUUID()}`;
}

function itemTypeLabel(type: ReviewItemType) {
  if (type === "KEY_POINT") return "Key point";
  if (type === "FOLLOWUP") return "Follow-up";
  return type[0] + type.slice(1).toLowerCase();
}

export function GrowContactTranscriptPanel({
  partyId,
  onReviewSaved,
}: {
  partyId: number;
  onReviewSaved?: (transcription: CallTranscription) => void;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [transcript, setTranscript] = useState("");
  const [items, setItems] = useState<LocalReviewItem[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const initializedId = useRef<number | null>(null);
  const listKey = ["grow-contact-transcriptions", partyId] as const;
  const list = useQuery<TranscriptListResponse>({
    queryKey: listKey,
    queryFn: () => apiFetch(`/grow/calls/contacts/${partyId}/transcriptions`),
    refetchInterval: (query) =>
      query.state.data?.transcriptions.some((row) =>
        ["PENDING", "MEDIA_PROCESSING", "TRANSCRIBING"].includes(row.processingState),
      )
        ? 3000
        : false,
  });

  useEffect(() => {
    initializedId.current = null;
    setSelectedId(null);
    setTranscript("");
    setItems([]);
    setFormError(null);
  }, [partyId]);

  const selected = list.data?.transcriptions.find((row) => row.id === selectedId) ?? null;
  const reviewable = selected?.processingState === "AWAITING_AGENT_REVIEW";

  useEffect(() => {
    if (selected && initializedId.current !== selected.id) {
      initializedId.current = selected.id;
      setTranscript(selected.transcript ?? "");
      setItems(
        createReviewItems(
          selected.draftSummary,
          selected.draftKeyPoints,
          selected.draftCommitments,
          selected.draftFollowups,
        ),
      );
      setFormError(null);
    }
    if (!selected && selectedId !== null) setSelectedId(null);
  }, [selected, selectedId]);

  const save = useMutation({
    mutationFn: ({ row, reviewState }: { row: CallTranscription; reviewState: ReviewEntry[] }) =>
      apiFetch<{ transcription: CallTranscription }>(`/grow/calls/${row.callSessionId}/transcription/${row.id}/review`, {
        method: "POST",
        body: JSON.stringify({ reviewState }),
      }),
    onSuccess: ({ transcription }) => {
      queryClient.setQueryData<TranscriptListResponse>(listKey, (old) =>
        old ? { ...old, transcriptions: old.transcriptions.map((row) => (row.id === transcription.id ? transcription : row)) } : old,
      );
      // Part F integration point: invoked only after a successful Save review,
      // never when an agent discards a transcript.
      onReviewSaved?.(transcription);
    },
  });
  const discard = useMutation({
    mutationFn: (row: CallTranscription) =>
      apiFetch<{ transcription: CallTranscription }>(`/grow/calls/${row.callSessionId}/transcription/${row.id}/discard`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: ({ transcription }) => {
      queryClient.setQueryData<TranscriptListResponse>(listKey, (old) =>
        old ? { ...old, transcriptions: old.transcriptions.map((row) => (row.id === transcription.id ? transcription : row)) } : old,
      );
    },
  });
  const pending = save.isPending || discard.isPending;

  function updateItem(index: number, update: Partial<LocalReviewItem>) {
    setItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...update } : item)));
  }

  function addItem(itemType: ReviewItemType) {
    setItems((current) => [
      ...current,
      { id: itemType === "SUMMARY" ? "summary" : manualId(), itemType, text: "", editedText: "", rejectionReason: "", manual: true },
    ]);
  }

  function submit() {
    if (!selected || !reviewable || pending) return;
    if (!transcript.trim()) {
      setFormError("Enter the reviewed transcript before saving.");
      return;
    }
    const itemError = validateReviewItems(items);
    if (itemError) {
      setFormError(itemError);
      return;
    }
    setFormError(null);
    save.mutate({
      row: selected,
      reviewState: [
        { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: transcript.trim() },
        ...serializeReviewItems(items),
      ],
    });
  }

  return (
    <section className="card grow-call-panel grow-transcript-panel">
      <div className="grow-call-panel-header">
        <div><div className="eyebrow">Call transcripts</div><h2>Review calls before CRM actions</h2></div>
      </div>
      {list.isLoading && <p className="muted">Loading call transcripts…</p>}
      {list.isError && <p className="error-text">{friendlyError(list.error, "Couldn't load call transcripts.")}</p>}
      {list.data?.transcriptions.length === 0 && <p className="empty-state">No call transcripts for this contact yet.</p>}
      {list.data && list.data.transcriptions.length > 0 && (
        <div className="grow-transcript-list">
          {list.data.transcriptions.map((row) => (
            <button key={row.id} type="button" className={`grow-transcript-row${selectedId === row.id ? " active" : ""}`} onClick={() => setSelectedId(row.id)} disabled={pending}>
              <span>Call transcript</span><span className="pill">{transcriptionStatusLabel(row.processingState, row.failureReason)}</span>
              <small>{new Date(row.createdAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
      )}
      {selected && reviewable && (
        <div className="grow-transcript-review">
          <p className="grow-review-advisory">AI draft only — review each item before saving. Nothing is saved or actioned until you choose Save review.</p>
          <label>Transcript<textarea value={transcript} onChange={(event) => setTranscript(event.target.value)} disabled={pending} /></label>
          <p className="muted">Save accepts the reviewed transcript. The original transcript remains unchanged.</p>
          {(["SUMMARY", "KEY_POINT", "COMMITMENT", "FOLLOWUP"] as ReviewItemType[]).map((type) => (
            <div className="grow-review-group" key={type}>
              <div className="grow-review-group-title"><strong>{type === "KEY_POINT" ? "Key points" : type === "FOLLOWUP" ? "Follow-ups" : itemTypeLabel(type)}</strong>
                {type !== "SUMMARY" || !items.some((item) => item.itemType === "SUMMARY") ? <button type="button" className="btn btn-link btn-small" disabled={pending} onClick={() => addItem(type)}>Add</button> : null}
              </div>
              {items.map((item, index) => item.itemType === type && (
                <div className="grow-review-item" key={item.id}>
                  <textarea aria-label={`${itemTypeLabel(type)} text`} value={item.editedText} disabled={pending} onChange={(event) => updateItem(index, { editedText: event.target.value })} />
                  <div className="grow-call-actions">
                    <button type="button" aria-pressed={item.decision === "APPROVED"} className={`btn btn-small${item.decision === "APPROVED" ? " btn-primary" : ""}`} disabled={pending} onClick={() => updateItem(index, { decision: "APPROVED" })}>Accept</button>
                    <button type="button" aria-pressed={item.decision === "REJECTED"} className={`btn btn-small${item.decision === "REJECTED" ? " btn-danger" : ""}`} disabled={pending} onClick={() => updateItem(index, { decision: "REJECTED" })}>Reject</button>
                    {item.manual && <button type="button" className="btn btn-link btn-small" disabled={pending} onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>}
                  </div>
                  {item.decision === "REJECTED" && <input aria-label={`${itemTypeLabel(type)} rejection reason`} value={item.rejectionReason} disabled={pending} placeholder="Reason (optional)" onChange={(event) => updateItem(index, { rejectionReason: event.target.value })} />}
                </div>
              ))}
            </div>
          ))}
          {formError && <p className="error-text">{formError}</p>}
          {save.isError && <p className="error-text">{friendlyError(save.error, "Couldn't save this review. Your edits are still here.")}</p>}
          {discard.isError && <p className="error-text">{friendlyError(discard.error, "Couldn't discard this transcript. Try again.")}</p>}
          <div className="grow-call-actions">
            <button type="button" className="btn btn-primary" disabled={pending} onClick={submit}>{save.isPending ? "Saving…" : "Save review"}</button>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={() => discard.mutate(selected)}>{discard.isPending ? "Discarding…" : "Discard transcript"}</button>
          </div>
        </div>
      )}
      {selected && !reviewable && (
        <p className="muted">This transcript is {transcriptionStatusLabel(selected.processingState, selected.failureReason).toLowerCase()}.</p>
      )}
    </section>
  );
}
