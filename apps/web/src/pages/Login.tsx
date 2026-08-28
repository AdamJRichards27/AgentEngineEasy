import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiFetch, ApiError } from "../lib/api";
import type { SessionUser } from "../lib/session";

interface KnownUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  brokerageName: string | null;
}

// Prototype-priority screen 1 (staging brief). Staging sign-in only — no
// password, and deliberately not pretending to be real Clerk auth (that's
// documented future scope, ARCHITECTURE.md §10). Lets an agent either pick
// an identity they've used before or set one up in a few fields, so every
// other screen in the app is actually reachable.
export default function Login() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [brokerageName, setBrokerageName] = useState("");

  const { data: knownUsers } = useQuery({
    queryKey: ["known-users"],
    queryFn: () => apiFetch<{ users: KnownUser[] }>("/auth/known-users").then((r) => r.users),
  });

  const signIn = useMutation({
    mutationFn: (input: { firstName: string; lastName: string; email: string; brokerageName: string }) =>
      apiFetch<{ user: SessionUser }>("/auth/dev-login", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (data) => {
      queryClient.setQueryData(["session"], data.user);
      setLocation("/");
    },
  });

  const continueAs = (u: KnownUser) =>
    signIn.mutate({ firstName: u.firstName, lastName: u.lastName, email: u.email, brokerageName: u.brokerageName ?? "" });

  const submit = () => {
    if (!firstName || !lastName || !email || !brokerageName) return;
    signIn.mutate({ firstName, lastName, email, brokerageName });
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo" role="img" aria-label="Agent Engine">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
        </svg>
        <span>Agent Engine</span>
      </div>
        <p className="muted">Sign in to get started.</p>

        {knownUsers && knownUsers.length > 0 && !showForm && (
          <div className="stack">
            {knownUsers.map((u) => (
              <button
                key={u.id}
                className="btn btn-block"
                onClick={() => continueAs(u)}
                disabled={signIn.isPending}
              >
                Continue as {u.firstName} {u.lastName}
                {u.brokerageName ? ` · ${u.brokerageName}` : ""}
              </button>
            ))}
            <button className="btn btn-secondary btn-block" onClick={() => setShowForm(true)}>
              Use a different account
            </button>
          </div>
        )}

        {(showForm || !knownUsers || knownUsers.length === 0) && (
          <div className="stack">
            <label>
              First name
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Jane" />
            </label>
            <label>
              Last name
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Agent" />
            </label>
            <label>
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@youragency.com.au" />
            </label>
            <label>
              Brokerage
              <input value={brokerageName} onChange={(e) => setBrokerageName(e.target.value)} placeholder="Your agency name" />
            </label>
            <button
              className="btn btn-primary btn-block"
              onClick={submit}
              disabled={signIn.isPending || !firstName || !lastName || !email || !brokerageName}
            >
              {signIn.isPending ? "Signing in…" : "Continue"}
            </button>
            {knownUsers && knownUsers.length > 0 && (
              <button className="btn btn-link" onClick={() => setShowForm(false)}>
                Back
              </button>
            )}
          </div>
        )}

        {signIn.isError && <p className="error-text">{(signIn.error as ApiError).friendly}</p>}
      </div>
    </div>
  );
}
