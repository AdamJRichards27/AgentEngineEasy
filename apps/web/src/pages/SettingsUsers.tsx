// Critical Blocker Remediation — minimal admin UI for the controlled-pilot
// invitation-only auth model (Settings → Users & Access). Every mutation
// below hits an already tenant-scoped, admin-only API route (routes/auth.ts
// /admin/invitations..., /admin/users...; routes/privacy.ts
// /admin/privacy-requests...) — the isAdmin gate here is the same "UX
// nicety, not the security boundary" convention every other role-gated page
// in this app uses (see SettingsIntegrations.tsx's own header comment).
//
// Two tabs: Team (invite people, watch pending invitations, manage existing
// members) and Privacy Requests (the export/deletion request queue —
// resolving a request here only records a human decision; it never itself
// exports or deletes anything, per the Owner's instruction that regulated
// data must never be auto-deleted).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../lib/session";
import { apiFetch, ApiError } from "../lib/api";

const TABS = [
  { key: "team", label: "Team" },
  { key: "privacy", label: "Privacy Requests" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const ROLES = ["Agent", "Brokerage Administrator", "Pit Crew"] as const;

export default function SettingsUsers() {
  const { user, isLoading: sessionLoading } = useSession();
  const isAdmin = user?.role === "Brokerage Administrator";
  const [tab, setTab] = useState<TabKey>("team");

  if (sessionLoading) return <p className="muted">Loading…</p>;

  if (!isAdmin) {
    return (
      <div className="primary-action">
        <p className="eyebrow">Settings</p>
        <h2>Users &amp; Access</h2>
        <p className="muted">Team and access settings are only visible to Brokerage Administrators.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="primary-action">
        <p className="eyebrow">Settings</p>
        <h2>Users &amp; Access</h2>
        <p className="muted">
          Invitation-only accounts (Critical Blocker Remediation): there is no self-service sign-up anywhere in this
          app — every account starts as an invitation sent from here.
        </p>
      </div>

      <nav className="pc-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={`pc-tab${tab === t.key ? " active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "team" && <TeamTab currentUserId={user!.id} />}
      {tab === "privacy" && <PrivacyRequestsTab />}
    </div>
  );
}

// =======================================================================
// Team: invite form + pending invitations + member directory.
// =======================================================================

interface InvitationRow {
  id: number;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface UserRow {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
}

function invitationStatus(inv: InvitationRow): { label: string; pillClass: string } {
  if (inv.acceptedAt) return { label: "Accepted", pillClass: "pill pill-success" };
  if (inv.revokedAt) return { label: "Revoked", pillClass: "pill" };
  if (new Date(inv.expiresAt).getTime() < Date.now()) return { label: "Expired", pillClass: "pill pill-warning" };
  return { label: "Pending", pillClass: "pill pill-warning" };
}

function TeamTab({ currentUserId }: { currentUserId: number }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("Agent");

  const invitations = useQuery({
    queryKey: ["admin-invitations"],
    queryFn: () => apiFetch<{ invitations: InvitationRow[] }>("/auth/admin/invitations").then((r) => r.invitations),
  });
  const members = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => apiFetch<{ users: UserRow[] }>("/auth/admin/users").then((r) => r.users),
  });

  const invite = useMutation({
    mutationFn: () => apiFetch("/auth/admin/invitations", { method: "POST", body: JSON.stringify({ email: email.trim(), role }) }),
    onSuccess: () => {
      setEmail("");
      queryClient.invalidateQueries({ queryKey: ["admin-invitations"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/auth/admin/invitations/${id}/revoke`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-invitations"] }),
  });

  const disable = useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/auth/admin/users/${id}/disable`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  const enable = useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/auth/admin/users/${id}/enable`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  const memberBusy = disable.isPending || enable.isPending;

  return (
    <>
      <section className="card">
        <h2>Invite someone</h2>
        <p className="muted">
          Sends a one-time, expiring invitation link to a sandbox/test-only email provider — see
          docs/gate-evidence/AUTHENTICATION_THREAT_MODEL.md. Nothing is emailed to a real inbox in this environment
          until an approved email provider is configured.
        </p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!email.trim()) return;
            invite.mutate();
          }}
        >
          <input
            type="email"
            placeholder="name@youragency.com.au"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <select value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-small" type="submit" disabled={invite.isPending || !email.trim()}>
            {invite.isPending ? "Sending…" : "Send Invitation"}
          </button>
        </form>
        {invite.isError && <p className="error-text">{(invite.error as ApiError).friendly}</p>}
      </section>

      <section className="card">
        <h2>Invitations{invitations.data ? ` (${invitations.data.length})` : ""}</h2>
        {invitations.isLoading && <p className="muted">Loading…</p>}
        {invitations.isError && <p className="error-text">{(invitations.error as ApiError).friendly}</p>}
        {invitations.data && invitations.data.length === 0 && <p className="empty-state">No invitations sent yet.</p>}
        {invitations.data && invitations.data.length > 0 && (
          <ul className="item-list">
            {invitations.data.map((inv) => {
              const s = invitationStatus(inv);
              const canRevoke = !inv.acceptedAt && !inv.revokedAt;
              return (
                <li key={inv.id}>
                  <div className="pc-item-header">
                    <strong>{inv.email}</strong>
                    <span className={s.pillClass}>{s.label}</span>
                  </div>
                  <p className="muted">
                    {inv.role} · sent {new Date(inv.createdAt).toLocaleString()} · expires {new Date(inv.expiresAt).toLocaleString()}
                  </p>
                  {canRevoke && (
                    <button className="btn btn-danger btn-small" disabled={revoke.isPending} onClick={() => revoke.mutate(inv.id)}>
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {revoke.isError && <p className="error-text">{(revoke.error as ApiError).friendly}</p>}
      </section>

      <section className="card">
        <h2>Team members{members.data ? ` (${members.data.length})` : ""}</h2>
        {members.isLoading && <p className="muted">Loading…</p>}
        {members.isError && <p className="error-text">{(members.error as ApiError).friendly}</p>}
        {members.data && members.data.length > 0 && (
          <table className="grow-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {members.data.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.firstName} {m.lastName}
                  </td>
                  <td>{m.email}</td>
                  <td>{m.role}</td>
                  <td>
                    <span className={m.isActive ? "pill pill-success" : "pill pill-danger"}>{m.isActive ? "Active" : "Disabled"}</span>
                  </td>
                  <td>
                    {m.id === currentUserId ? (
                      <span className="muted">You</span>
                    ) : m.isActive ? (
                      <button className="btn btn-danger btn-small" disabled={memberBusy} onClick={() => disable.mutate(m.id)}>
                        Disable
                      </button>
                    ) : (
                      <button className="btn btn-secondary btn-small" disabled={memberBusy} onClick={() => enable.mutate(m.id)}>
                        Re-enable
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(disable.isError || enable.isError) && <p className="error-text">{((disable.error ?? enable.error) as ApiError).friendly}</p>}
      </section>
    </>
  );
}

// =======================================================================
// Privacy request queue.
// =======================================================================

interface PrivacyRequestRow {
  id: number;
  userId: number;
  userEmail: string;
  userFirstName: string;
  userLastName: string;
  type: "export" | "deletion";
  status: "pending" | "completed" | "declined";
  notes: string | null;
  requestedAt: string;
  handledAt: string | null;
  handledByUserId: number | null;
}

function PrivacyRequestsTab() {
  const queryClient = useQueryClient();
  const requests = useQuery({
    queryKey: ["admin-privacy-requests"],
    queryFn: () => apiFetch<{ requests: PrivacyRequestRow[] }>("/admin/privacy-requests").then((r) => r.requests),
  });
  const [notesById, setNotesById] = useState<Record<number, string>>({});

  const resolve = useMutation({
    mutationFn: (args: { id: number; status: "completed" | "declined" }) =>
      apiFetch(`/admin/privacy-requests/${args.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ status: args.status, notes: notesById[args.id]?.trim() || undefined }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-privacy-requests"] }),
  });

  return (
    <section className="card">
      <h2>Privacy requests{requests.data ? ` (${requests.data.length})` : ""}</h2>
      <p className="muted">
        Resolving a request here only records that a human handled it through the appropriate process — it never
        itself exports or deletes data. See docs/legal/DATA_ACCESS_CORRECTION_DELETION_PROCESS.md.
      </p>
      {requests.isLoading && <p className="muted">Loading…</p>}
      {requests.isError && <p className="error-text">{(requests.error as ApiError).friendly}</p>}
      {requests.data && requests.data.length === 0 && <p className="empty-state">No privacy requests.</p>}
      {requests.data && requests.data.length > 0 && (
        <ul className="item-list">
          {requests.data.map((r) => (
            <li key={r.id}>
              <div className="pc-item-header">
                <strong>
                  {r.type === "export" ? "Data export" : "Deletion"} — {r.userFirstName} {r.userLastName} ({r.userEmail})
                </strong>
                <span
                  className={
                    r.status === "pending" ? "pill pill-warning" : r.status === "completed" ? "pill pill-success" : "pill pill-danger"
                  }
                >
                  {r.status}
                </span>
              </div>
              <p className="muted">Requested {new Date(r.requestedAt).toLocaleString()}</p>
              {r.notes && <p className="muted">Requester notes: {r.notes}</p>}
              {r.status === "pending" && (
                <div className="inline-form">
                  <input
                    placeholder="Resolution notes (optional)"
                    value={notesById[r.id] ?? ""}
                    onChange={(e) => setNotesById((cur) => ({ ...cur, [r.id]: e.target.value }))}
                  />
                  <button
                    className="btn btn-primary btn-small"
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate({ id: r.id, status: "completed" })}
                  >
                    Mark Completed
                  </button>
                  <button
                    className="btn btn-secondary btn-small"
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate({ id: r.id, status: "declined" })}
                  >
                    Decline
                  </button>
                </div>
              )}
              {r.handledAt && <p className="muted">Handled {new Date(r.handledAt).toLocaleString()}</p>}
            </li>
          ))}
        </ul>
      )}
      {resolve.isError && <p className="error-text">{(resolve.error as ApiError).friendly}</p>}
    </section>
  );
}
