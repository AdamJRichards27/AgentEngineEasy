// Critical Blocker Remediation, Phase 2/4 — authentication email delivery.
//
// Deliberately separate from the Communications Hub's provider interface
// (lib/communications/providers/types.ts EmailProvider/SendEmailInput):
// that interface is designed around the Hub's outbox (idempotency keys,
// quiet-hours deferral, retry/backoff scheduling — see
// docs/INTEGRATION_EVENT_AND_DELIVERY_MODEL.md) for tenant-configurable
// customer-facing messaging. An invitation or password-reset email is a
// security-critical, synchronous, operator-facing message that must be
// sent (or fail loudly) immediately, never deferred by quiet-hours or
// batched with marketing/transactional send policy. Reusing the Hub's
// interface would either have to bypass its outbox (defeating the point of
// sharing it) or accept a delivery delay that is actively harmful for a
// time-limited security token. A separate, minimal interface is the
// correct boundary — mirrors the Hub's own sandbox-adapter pattern
// (communications/providers/sandboxEmail.ts) without inheriting its
// tenant-messaging concerns.

import { logger } from "@aee/events";
import { isProductionEnvironment } from "../env.js";

export interface AuthEmailProvider {
  readonly name: string;
  sendInvitation(input: { to: string; brokerageName: string; acceptUrl: string; expiresAt: Date }): Promise<void>;
  sendPasswordReset(input: { to: string; resetUrl: string; expiresAt: Date }): Promise<void>;
  sendAdministratorSuccession(input: { to: string; counterpartEmail: string; becameAdministrator: boolean }): Promise<void>;
}

// Never performs a real network call. Records only that a send was
// attempted (recipient + template name) — never the token/URL — so tests
// can assert "an invitation email was sent to X" without ever handling,
// logging, or asserting on the token itself. This mirrors
// sandboxEmailProvider's own "provider name always says sandbox, so
// delivery evidence can never be mistaken for real" rule.
export const SANDBOX_AUTH_EMAIL_PROVIDER_NAME = "sandbox_auth_email";

interface RecordedSend {
  provider: string;
  template: "invitation" | "password_reset" | "administrator_succession";
  to: string;
}

const sentLog: RecordedSend[] = [];

/** Test-only accessor — never exposed on any HTTP route. */
export function __getSandboxAuthEmailLog(): readonly RecordedSend[] {
  return sentLog;
}

/** Test-only accessor — never exposed on any HTTP route. */
export function __clearSandboxAuthEmailLog(): void {
  sentLog.length = 0;
}

export const sandboxAuthEmailProvider: AuthEmailProvider = {
  name: SANDBOX_AUTH_EMAIL_PROVIDER_NAME,

  async sendInvitation(input) {
    sentLog.push({ provider: SANDBOX_AUTH_EMAIL_PROVIDER_NAME, template: "invitation", to: input.to });
    logger.info("auth_email_sandbox_send", { provider: SANDBOX_AUTH_EMAIL_PROVIDER_NAME, template: "invitation" });
    logPilotModeLinkIfAcknowledged("invitation", input.to, input.acceptUrl);
  },

  async sendPasswordReset(input) {
    sentLog.push({ provider: SANDBOX_AUTH_EMAIL_PROVIDER_NAME, template: "password_reset", to: input.to });
    logger.info("auth_email_sandbox_send", { provider: SANDBOX_AUTH_EMAIL_PROVIDER_NAME, template: "password_reset" });
    logPilotModeLinkIfAcknowledged("password_reset", input.to, input.resetUrl);
  },

  async sendAdministratorSuccession(input) {
    sentLog.push({ provider: SANDBOX_AUTH_EMAIL_PROVIDER_NAME, template: "administrator_succession", to: input.to });
    logger.info("auth_email_sandbox_send", {
      provider: SANDBOX_AUTH_EMAIL_PROVIDER_NAME,
      template: "administrator_succession",
      becameAdministrator: input.becameAdministrator,
    });
  },
};

/**
 * Critical Blocker Remediation, Phase 9 — production-mode pilot deployment
 * readiness.
 *
 * A production-mode boot with the sandbox provider (see
 * assertAuthEmailProviderConfigured below) has no other channel to ever
 * deliver an invitation/reset link at all: routes/auth.ts's admin
 * invitation endpoint never returns the plaintext token in its HTTP
 * response (only {id, email, role, expiresAt}), and only the token's hash
 * is ever persisted (token-hash-at-rest — see routes/auth.ts). Without
 * this, a link generated while sandbox pilot mode is acknowledged would be
 * irrecoverable the instant this function returns, and no pilot
 * participant could ever be onboarded even with an operator willing to
 * hand-deliver the link out of band (phone call, in-person, or another
 * already-verified channel) — exactly the operational gap
 * docs/CONTROLLED_PILOT_PLAN.md §B.4 already anticipates ("A real,
 * approved email provider must be configured before this link reaches a
 * genuine pilot participant's real inbox").
 *
 * Fail-closed in the opposite direction from every other gate in this
 * file: logs nothing by default, in every environment, including ordinary
 * test runs (existing tests assert __getSandboxAuthEmailLog() never
 * contains a URL — see the module comment on sentLog above — and that
 * assertion is unaffected, since this writes to the structured logger, a
 * separate channel, never to sentLog). Only ever logs the real,
 * hand-deliverable link when an operator has explicitly set
 * PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED=true — the same flag
 * assertAuthEmailProviderConfigured() requires to boot at all in
 * production without a real provider. See
 * docs/REPLIT_PILOT_DEPLOYMENT_RUNBOOK.md and
 * docs/gate-evidence/PHASE9_DEPLOYMENT_READINESS_AUDIT.md.
 */
function logPilotModeLinkIfAcknowledged(template: "invitation" | "password_reset", to: string, url: string): void {
  if (process.env.PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED !== "true") return;
  logger.warn("pilot_mode_sandbox_email_link", {
    template,
    to,
    url,
    message:
      "No real email provider is configured (pilot mode). Hand-deliver this link to the participant " +
      "out of band — it is never emailed for real while pilot mode is acknowledged.",
  });
}

/**
 * Fail-closed selection, mirroring assertSessionSecretConfigured() /
 * assertCorsConfigured() in index.ts. A real, approved email provider is an
 * outstanding external dependency for this pilot (Owner decision: test/
 * sandbox external services only, pending procurement/approval of a real
 * provider) — so production startup must refuse to boot with the sandbox
 * provider silently standing in for it, rather than "working" while
 * silently never delivering a real invitation or reset email to anyone.
 */
export function assertAuthEmailProviderConfigured(): void {
  if (!isProductionEnvironment()) return;
  if (process.env.AUTH_EMAIL_PROVIDER && process.env.AUTH_EMAIL_PROVIDER !== "sandbox") return;

  // Critical Blocker Remediation, Phase 9 — production-mode pilot
  // deployment readiness. The AE Project Owner has explicitly authorised
  // preparing a private, production-mode pilot environment while external
  // services — including email — stay test/sandbox only ("AE Operational
  // Readiness — Critical Blocker Remediation," Owner decision: "External
  // services: test/sandbox modes only; no real ... email ... action
  // authorised"). That is a deliberate instruction to boot
  // NODE_ENV=production with no real email provider — exactly the state
  // this assertion exists to prevent by accident elsewhere. Rather than
  // weaken the assertion itself (which would silently permit this for ANY
  // future production boot, pilot or not), a second, separately-named,
  // explicit flag is required, so this state is only ever reachable when
  // an operator has typed this exact acknowledgement — never by omission,
  // and never merely because AUTH_EMAIL_PROVIDER is unset.
  if (process.env.PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED === "true") {
    logger.warn("pilot_mode_sandbox_email_active", {
      message:
        "Booting in production with the sandbox auth-email provider. Invitation and password-reset " +
        "emails are NOT delivered to real inboxes — see pilot_mode_sandbox_email_link log lines for " +
        "the hand-deliverable link. This is only acceptable for the controlled pilot environment under " +
        "the AE Project Owner's explicit sandbox-external-services decision. Unset " +
        "PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED and configure a real AUTH_EMAIL_PROVIDER " +
        "before any wider launch. See docs/REPLIT_PILOT_DEPLOYMENT_RUNBOOK.md.",
    });
    return;
  }

  throw new Error(
    "AUTH_EMAIL_PROVIDER is not configured for production. Refusing to start: without a real, " +
      "approved email provider, invitation and password-reset emails cannot be delivered, and the " +
      "sandbox provider must never be used in production (it performs no real delivery). Set " +
      "AUTH_EMAIL_PROVIDER to a real, integrated provider name once one has been approved, or — for " +
      "the controlled pilot only, per the AE Project Owner's explicit sandbox-external-services " +
      "decision — set PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED=true. See " +
      "docs/REPLIT_PILOT_DEPLOYMENT_RUNBOOK.md and docs/gate-evidence/PHASE2_AUTHENTICATION_DESIGN.md §6.",
  );
}

/**
 * Returns the active provider. Only the sandbox provider is implemented in
 * this remediation pass — a real provider integration is out of scope
 * (Owner decision: sandbox/test external services only) and is recorded as
 * an outstanding external dependency in the final gate report. Because
 * assertAuthEmailProviderConfigured() above already refuses to boot in
 * production without AUTH_EMAIL_PROVIDER naming something other than
 * "sandbox", reaching this function's fallback in production is
 * unreachable in practice — this function does not itself re-derive that
 * decision, it only ever returns the one provider that exists.
 */
export function getAuthEmailProvider(): AuthEmailProvider {
  return sandboxAuthEmailProvider;
}
