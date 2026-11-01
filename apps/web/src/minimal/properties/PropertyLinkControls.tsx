import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, apiErrorMessage, apiFetch } from "../../lib/api";
import {
  linkFailureText,
  linkPath,
  PROPERTY_PARTY_ROLE_LABELS,
  PROPERTY_PARTY_ROLES,
  UNLINK_CONFIRM,
  updateLinkBody,
} from "./minimalPropertyContactsModel";

// t228u Priority 2: edit role, set/clear primary, and unlink one property_parties
// row. Shared by the property side (MinimalPropertyContacts) and the contact side
// (ContactPropertyLinks), so both directions use the same routes and messages.
export function PropertyLinkControls({
  linkId,
  role,
  isPrimary,
  onChanged,
}: {
  linkId: number;
  role: string;
  isPrimary: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (body: NonNullable<ReturnType<typeof updateLinkBody>>) => apiFetch(linkPath(linkId), { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { setError(null); onChanged(); },
    onError: (err) => setError(linkFailureText(err instanceof ApiError ? err : null, apiErrorMessage(err, "Couldn't update the link."))),
  });
  const unlink = useMutation({
    mutationFn: () => apiFetch(linkPath(linkId), { method: "DELETE" }),
    onSuccess: () => { setError(null); onChanged(); },
    onError: (err) => setError(apiErrorMessage(err, "Couldn't remove the link.")),
  });
  const busy = update.isPending || unlink.isPending;
  function change(next: { role?: string; isPrimary?: boolean }) {
    const body = updateLinkBody({ role, isPrimary }, next);
    if (body) update.mutate(body);
  }
  return (
    <div className="am-link-controls" data-ae-link-controls={linkId}>
      <label className="am-sr-only" htmlFor={`am-link-role-${linkId}`}>Relationship</label>
      <select id={`am-link-role-${linkId}`} value={role} disabled={busy} data-ae-link-role-edit={linkId} onChange={(e) => change({ role: e.target.value })}>
        {(PROPERTY_PARTY_ROLES as readonly string[]).includes(role) ? null : <option value={role}>{role}</option>}
        {PROPERTY_PARTY_ROLES.map((r) => (
          <option key={r} value={r}>{PROPERTY_PARTY_ROLE_LABELS[r]}</option>
        ))}
      </select>
      <label>
        <input type="checkbox" checked={isPrimary} disabled={busy} data-ae-link-primary={linkId} onChange={(e) => change({ isPrimary: e.target.checked })} /> Primary
      </label>
      <button
        type="button"
        className="am-data-button is-quiet"
        disabled={busy}
        data-ae-unlink={linkId}
        onClick={() => { if (window.confirm(UNLINK_CONFIRM)) unlink.mutate(); }}
      >
        Unlink
      </button>
      {error ? <p className="am-switch-error" role="alert">{error}</p> : null}
    </div>
  );
}
