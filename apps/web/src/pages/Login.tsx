import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, ApiError, SESSION_ENDED_MESSAGE } from "../lib/api";
import { useCompleteSignIn, useSessionEndedNotice, type SessionUser } from "../lib/session";

interface KnownUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  brokerageName: string | null;
}

// Critical Blocker Remediation, Phase 4 — real sign-in for the controlled
// pilot. The primary path below is POST /auth/login (email + password);
// the "known users" quick-picker is a local-development convenience only
// (see docs/gate-evidence/AUTHENTICATION_THREAT_MODEL.md §6) — GET
// /auth/known-users returns 404 everywhere outside an explicitly enabled
// development environment, so it simply never appears for the pilot or in
// production. There is no self-service "create an account" form here any
// more: accounts are created only by accepting an admin-issued invitation
// (see AcceptInvitation.tsx), matching the invitation-only model.
export default function Login() {
  // AE GROW Pilot Readiness WP5 — once the session is re-fetched, App.tsx's
  // /login route redirects to the entitlement-aware landing route itself.
  const completeSignIn = useCompleteSignIn();
  const sessionEnded = useSessionEndedNotice();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showDevPicker, setShowDevPicker] = useState(true);

  const { data: knownUsers } = useQuery({
    queryKey: ["known-users"],
    queryFn: () => apiFetch<{ users: KnownUser[] }>("/auth/known-users").then((r) => r.users),
    // Foundation Remediation Stage 1.1 / Critical Blocker Remediation Phase 3:
    // this endpoint is intentionally unavailable (404) outside an explicitly
    // enabled development environment. Do not retry a disabled route — a
    // missing result just means the dev picker below never renders.
    retry: false,
  });

  const devSignIn = useMutation({
    mutationFn: (u: KnownUser) =>
      apiFetch<{ user: SessionUser }>("/auth/dev-login", {
        method: "POST",
        body: JSON.stringify({ firstName: u.firstName, lastName: u.lastName, email: u.email, brokerageName: u.brokerageName ?? "" }),
      }),
    onSuccess: () => completeSignIn(),
  });

  const login = useMutation({
    mutationFn: () => apiFetch<{ user: SessionUser }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    onSuccess: () => completeSignIn(),
  });

  const submit = () => {
    if (!email || !password) return;
    login.mutate();
  };

  const hasDevPicker = showDevPicker && knownUsers && knownUsers.length > 0;

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo" role="img" aria-label="Agent Engine">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
          </svg>
          <span>Agent Engine</span>
        </div>
        {sessionEnded ? (
          <p className="session-ended-notice" role="status">
            {SESSION_ENDED_MESSAGE}
          </p>
        ) : (
          <p className="muted">Sign in to get started.</p>
        )}

        {hasDevPicker ? (
          <div className="stack">
            <p className="muted" style={{ fontSize: "0.85em" }}>
              Development environment — quick sign-in:
            </p>
            {knownUsers!.map((u) => (
              <button key={u.id} className="btn btn-block" onClick={() => devSignIn.mutate(u)} disabled={devSignIn.isPending}>
                Continue as {u.firstName} {u.lastName}
                {u.brokerageName ? ` · ${u.brokerageName}` : ""}
              </button>
            ))}
            <button className="btn btn-secondary btn-block" onClick={() => setShowDevPicker(false)}>
              Sign in with email and password instead
            </button>
          </div>
        ) : (
          <div className="stack">
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@youragency.com.au"
              />
            </label>
            <label>
              Password
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button className="btn btn-primary btn-block" onClick={submit} disabled={login.isPending || !email || !password}>
              {login.isPending ? "Signing in…" : "Sign in"}
            </button>
            <Link href="/forgot-password" className="btn btn-link">
              Forgot your password?
            </Link>
            {knownUsers && knownUsers.length > 0 && (
              <button className="btn btn-link" onClick={() => setShowDevPicker(true)}>
                Back to quick sign-in
              </button>
            )}
          </div>
        )}

        {(login.isError || devSignIn.isError) && (
          <p className="error-text">{((login.error ?? devSignIn.error) as ApiError).friendly}</p>
        )}
        <p className="muted" style={{ fontSize: "0.8em", marginTop: "1.5rem" }}>
          New to Agent Engine? You'll need an invitation from your Brokerage Administrator — check
          your email for an invite link.
        </p>
      </div>
    </div>
  );
}
