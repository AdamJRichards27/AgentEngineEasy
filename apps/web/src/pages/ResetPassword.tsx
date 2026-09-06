import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiFetch, ApiError } from "../lib/api";

// Critical Blocker Remediation, Phase 2 §4.5 — POST /auth/password-reset/confirm
// consumes the single-use token from the emailed link, sets a new password,
// and revokes every existing session for the account (sessionEpoch bump on
// the server) so a stolen session can't survive a reset. It does NOT sign
// the user in automatically (204 No Content, no cookie) — this screen sends
// the person back to /login on success rather than pretending it did.
export default function ResetPassword({ params }: { params: { token: string } }) {
  const { token } = params;
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const confirm = useMutation({
    mutationFn: () => apiFetch<void>("/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token, password }) }),
  });

  const passwordsMatch = password.length > 0 && password === confirmPassword;
  const canSubmit = passwordsMatch && !confirm.isPending;

  const submit = () => {
    if (!canSubmit) return;
    confirm.mutate();
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

        {confirm.isSuccess ? (
          <div className="stack">
            <p className="muted">Your password has been reset. Please sign in with your new password.</p>
            <button className="btn btn-primary btn-block" onClick={() => setLocation("/login")}>
              Go to sign in
            </button>
          </div>
        ) : (
          <div className="stack">
            <p className="muted">Choose a new password for your account.</p>
            <label>
              New password
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              Confirm new password
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
            {confirmPassword.length > 0 && !passwordsMatch && <p className="error-text">Passwords don't match.</p>}
            <button className="btn btn-primary btn-block" onClick={submit} disabled={!canSubmit}>
              {confirm.isPending ? "Resetting…" : "Reset password"}
            </button>
            {confirm.isError && <p className="error-text">{(confirm.error as ApiError).friendly}</p>}
            <Link href="/forgot-password" className="btn btn-link">
              Request a new link
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
