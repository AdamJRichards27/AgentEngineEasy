import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiFetch, ApiError } from "../lib/api";
import { useCompleteSignIn, type SessionUser } from "../lib/session";

// Critical Blocker Remediation, Phases 2/4/8 — the ONLY way an account is
// ever created for the pilot. A Brokerage Administrator issues an
// invitation (POST /auth/admin/invitations); the invited person opens the
// emailed link (/accept-invitation/:token) and lands here. There is no
// self-service sign-up anywhere in this app — see Login.tsx's own comment
// and docs/gate-evidence/AUTHENTICATION_THREAT_MODEL.md.
//
// GET /auth/invitations/:token/status deliberately reveals only one of two
// opaque states ("valid" / "invalid_or_expired") — never who was invited or
// why a token is dead — so this page must not try to be more specific than
// that either. POST /auth/invitations/:token/accept requires both
// acceptedTerms and acceptedPrivacyPolicy to be exactly `true`. The linked
// server endpoints return the exact active content whose SHA-256 identity is
// recorded on acceptance; production cannot expose these unless approved,
// hash-verified artifacts are configured.
export default function AcceptInvitation({ params }: { params: { token: string } }) {
  const { token } = params;
  const [, setLocation] = useLocation();
  const completeSignIn = useCompleteSignIn();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacyPolicy, setAcceptedPrivacyPolicy] = useState(false);

  const status = useQuery({
    queryKey: ["invitation-status", token],
    queryFn: () => apiFetch<{ status: "valid" | "invalid_or_expired" }>(`/auth/invitations/${token}/status`),
    retry: false,
  });
  const legal = useQuery({
    queryKey: ["legal-versions"],
    queryFn: () => apiFetch<{ termsVersion: string; privacyVersion: string }>("/legal/versions"),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () =>
      apiFetch<{ user: SessionUser }>(`/auth/invitations/${token}/accept`, {
        method: "POST",
        body: JSON.stringify({ password, acceptedTerms, acceptedPrivacyPolicy }),
      }),
    onSuccess: async () => {
      await completeSignIn();
      setLocation("/");
    },
  });

  const passwordsMatch = password.length > 0 && password === confirmPassword;
  const canSubmit = passwordsMatch && acceptedTerms && acceptedPrivacyPolicy && !accept.isPending;

  const submit = () => {
    if (!canSubmit) return;
    accept.mutate();
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

        {status.isLoading ? (
          <p className="muted">Checking your invitation…</p>
        ) : status.isError || status.data?.status !== "valid" ? (
          <div className="stack">
            <p className="muted">This invitation link is invalid or has expired.</p>
            <p className="muted" style={{ fontSize: "0.85em" }}>
              Ask your Brokerage Administrator to send a new invitation, or{" "}
              <Link href="/login">sign in</Link> if you already have an account.
            </p>
          </div>
        ) : accept.isSuccess ? (
          <p className="muted">Your account is ready — taking you in…</p>
        ) : (
          <div className="stack">
            <p className="muted">Set a password to finish creating your account.</p>
            <label>
              Password
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
            {confirmPassword.length > 0 && !passwordsMatch && <p className="error-text">Passwords don't match.</p>}
            <label className="checkbox-row">
              <input type="checkbox" checked={acceptedTerms} onChange={(e) => setAcceptedTerms(e.target.checked)} />
              <span>I have read and agree to the <a href="/api/legal/terms" target="_blank" rel="noreferrer">Terms of Use</a>{legal.data ? ` (${legal.data.termsVersion})` : ""}.</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={acceptedPrivacyPolicy}
                onChange={(e) => setAcceptedPrivacyPolicy(e.target.checked)}
              />
              <span>I have read and agree to the <a href="/api/legal/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>{legal.data ? ` (${legal.data.privacyVersion})` : ""}.</span>
            </label>
            <button className="btn btn-primary btn-block" onClick={submit} disabled={!canSubmit}>
              {accept.isPending ? "Creating your account…" : "Create account"}
            </button>
            {accept.isError && <p className="error-text">{(accept.error as ApiError).friendly}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
