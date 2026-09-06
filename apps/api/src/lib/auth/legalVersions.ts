// Critical Blocker Remediation, Phase 8 — the single source of truth for
// "what version of the Terms of Use / Privacy Policy is currently in
// effect." Bumping these constants is the only correct way to require
// existing users to re-consent to a changed document — see
// docs/legal/PILOT_TERMS_OF_USE.md / PILOT_PRIVACY_POLICY.md, both of
// which are still marked DRAFT — LEGAL REVIEW REQUIRED (see
// docs/legal/LEGAL_APPROVAL_REGISTER.md) and must not be presented to a
// real pilot participant as final until that changes.
//
// Deliberately NOT taken from request input anywhere this is used
// (routes/auth.ts, routes/privacy.ts): the server always stamps consent
// records with ITS OWN idea of the current version, never a
// client-supplied string, so a client cannot claim to have accepted a
// version that was never actually shown to them.
export const CURRENT_TERMS_VERSION = "2026-09-06-draft-1";
export const CURRENT_PRIVACY_VERSION = "2026-09-06-draft-1";
