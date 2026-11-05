import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiErrorMessage, apiFetch } from "../lib/api";
import { tapToCallPath, tapToCallView, type TapToCallStatus } from "./tapToCallModel";

// A plain tel: link (the device dials; nothing here auto-dials, records or
// completes a call). Rendered for authorised agents (`enabled`) whenever the
// server returns a number. t239u: no consent/DNC gating, warning or
// confirmation before the dialler; the agent is responsible for compliance.
// Optional post-call note.
// t242u: `enabled` = caller can VIEW the contact (read-only included); `canNote`
// = caller can manage contacts (notes are writes).
export function TapToCall({ partyId, enabled, canNote = false }: { partyId: number; enabled: boolean; canNote?: boolean }) {
  const status = useQuery<TapToCallStatus>({
    queryKey: ["tap-to-call", partyId],
    queryFn: () => apiFetch(tapToCallPath(partyId)),
    enabled,
    retry: false,
  });
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (text: string) => apiFetch(`/parties/${partyId}/call-notes`, { method: "POST", body: JSON.stringify({ note: text }) }),
    onSuccess: () => { setNote(""); setNoteOpen(false); setMsg("Note added."); },
    onError: (err) => setMsg(apiErrorMessage(err, "Couldn't add the note.")),
  });
  if (!enabled || !status.isSuccess) return null;
  const view = tapToCallView(status.data);
  if (view.kind === "hidden") return null;
  return (
    <span data-ae-tap-to-call="available">
      <a className="am-data-button is-quiet" href={view.href} data-ae-tel>Call</a>
      {canNote ? <button type="button" className="am-data-button is-quiet" data-ae-call-note="open" onClick={() => { setNoteOpen((o) => !o); setMsg(null); }}>Add call note</button> : null}
      {canNote && noteOpen ? (
        <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) save.mutate(note.trim()); }}>
          <input aria-label="Call note (optional)" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="am-data-button" disabled={save.isPending}>Save note</button>
        </form>
      ) : null}
      {msg ? <span className="am-agenda-sub" role="status"> {msg}</span> : null}
    </span>
  );
}
