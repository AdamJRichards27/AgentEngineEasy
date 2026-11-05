// Owner t277u: in-app notice when a contact export is ready for its owner, with its expiry.
// Counts and dates only — the data is only in the owner's download. No email is sent.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

import { exportNoticeText, type ExportNotification } from "../lib/exportNotice";

export function ExportNotifications() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifications"], queryFn: () => apiFetch<{ notifications: ExportNotification[] }>("/notifications"), refetchInterval: 60_000 });
  const dismiss = useMutation({
    mutationFn: (id: string) => apiFetch(`/notifications/${encodeURIComponent(id)}/dismiss`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const items = q.data?.notifications ?? [];
  if (items.length === 0) return null;
  return (
    <section className="card stack" role="status" aria-live="polite" data-ae-notifications>
      {items.map((n) => (
        <div key={n.id} className="inline-form" data-ae-notification={n.id}>
          <span data-ae-notification-text>{exportNoticeText(n)}</span>
          <a className="btn btn-primary btn-small" data-ae-notification-download href={`/api${n.downloadPath}`} onClick={() => setTimeout(() => void qc.invalidateQueries({ queryKey: ["notifications"] }), 1500)}>
            Download
          </a>
          <button className="btn btn-link" data-ae-notification-dismiss disabled={dismiss.isPending} onClick={() => dismiss.mutate(n.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </section>
  );
}
