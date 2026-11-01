import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiErrorMessage, apiFetch } from "../lib/api";
import { tapToCallPath, tapToCallView, type TapToCallStatus } from "./tapToCallModel";

// t236u: a plain tel: link (the device dials; nothing here auto-dials, records
// or completes a call). Rendered only for authorised agents (`enabled`), and
// only when the server says calling is allowed. Optional post-call note.
export function TapToCall({ partyId, enabled }: { partyId: number; enabled: boolean }) {
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
  if (view.kind === "unavailable") return <span className="am-agenda-sub" data-ae-tap-to-call="unavailable">{view.text}</span>;
  return (
    <span data-ae-tap-to-call="available">
      <a className="am-data-button is-quiet" href={view.href} data-ae-tel>Call</a>
      {view.restrictions ? <span className="am-agenda-sub"> {view.restrictions}</span> : null}
      <button type="button" className="am-data-button is-quiet" data-ae-call-note="open" onClick={() => { setNoteOpen((o) => !o); setMsg(null); }}>Add call note</button>
      {noteOpen ? (
        <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) save.mutate(note.trim()); }}>
          <input aria-label="Call note (optional)" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="am-data-button" disabled={save.isPending}>Save note</button>
        </form>
      ) : null}
      {msg ? <span className="am-agenda-sub" role="status"> {msg}</span> : null}
    </span>
  );
}
