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
        <h1>AgentEngineEasy</h1>
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
