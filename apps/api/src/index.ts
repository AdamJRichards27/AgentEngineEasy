// AE GROW Pilot Readiness WP2a: these two MUST stay the first imports.
// asyncRouteErrors patches Express so a rejected async route/middleware is
// forwarded to next(err) (see that module) before any router is used;
// installProcessSafetyHandlers() below runs before start() kicks off any
// background work (schedulers, seeds) — see lib/processSafety.ts.
import "./lib/asyncRouteErrors.js";
import { installProcessSafetyHandlers } from "./lib/processSafety.js";
import { logger } from "@aee/events";
import { createApp } from "./app.js";
import { configureEvents } from "./lib/events.js";
import { ensureCatalogueSeeded } from "./lib/billing/catalogue.js";
import { ensureRunAccessBackfilled } from "./lib/billing/runAccessBackfill.js";
import { assertSessionSecretConfigured } from "./lib/session.js";
import { assertCorsConfigured } from "./lib/cors.js";
import { assertMetricsAuthConfigured } from "./lib/metricsAuth.js";
import { assertAuthEmailProviderConfigured } from "./lib/auth/email.js";
import { assertApprovedLegalVersionsConfigured } from "./lib/auth/legalVersions.js";
import { assertAiUsageLimitsConfigured } from "./lib/ai/usageLimits.js";
import { registerAutomationEngine } from "./lib/automation/bootstrap.js";
import { ensureStage2CatalogueSeeded } from "./lib/automation/catalogueBootstrap.js";
import { registerExceptionEngine } from "./lib/exceptions/bootstrap.js";
import { registerSignalSweep } from "./lib/propertyIntelligence/sweepBootstrap.js";
import { registerPitCrewWaitingOnSweep } from "./lib/pitCrew/waitingOnSweepBootstrap.js";
import { registerLaunchEngine } from "./lib/launch/bootstrap.js";
import { registerCommunicationsEngine } from "./lib/communications/bootstrap.js";
import { registerFinancialEngine } from "./lib/financial/bootstrap.js";
import { registerIntegrationsEngine } from "./lib/integrations/bootstrap.js";
import { assertOperationalAlertsConfigured } from "./lib/operationalAlerts.js";
import {
  assertDocumentStorageConfigured,
  checkDocumentStorageReadiness,
} from "./lib/documentStorage.js";
import { registerDocumentStorageReconciler } from "./lib/documentStorageReconciler.js";
import { registerCallTranscriptionReconciler } from "./lib/telephony/callTranscriptionReconciler.js";
import { assertESignProviderConfigured } from "@aee/integration-esign";
import { assertDatabaseSessionTimezoneUtc } from "./lib/dbTimezone.js";
import { runTrackedStartupTask } from "./lib/startupHealth.js";

installProcessSafetyHandlers();

// Foundation Remediation Stage 1.2: fail closed at boot, not at first
// request, if SESSION_SECRET is missing or too weak. A process that
// can't sign trustworthy sessions must not accept traffic at all.
assertSessionSecretConfigured();

// Same fail-closed shape as above: refuse to start in production if
// CORS_ALLOWED_ORIGINS is unset (see lib/cors.ts) rather than quietly
// booting a cookie-authenticated API with no operator-decided cross-origin
// policy.
assertCorsConfigured();

// Step 2 hardening: same fail-closed shape as the two checks above — a
// production process must not silently expose GET /api/internal/metrics
// (request volumes, integration failure rates, which providers are
// configured) with no authentication because an operator forgot to set
// METRICS_TOKEN. See lib/metricsAuth.ts.
assertMetricsAuthConfigured();

// Critical Blocker Remediation, Phase 2/4: same fail-closed shape as the
// three checks above — a production process must not silently rely on the
// sandbox (non-delivering) auth email provider for invitation/password-reset
// emails. See lib/auth/email.ts.
assertAuthEmailProviderConfigured();
assertOperationalAlertsConfigured();
assertApprovedLegalVersionsConfigured();
assertDocumentStorageConfigured();
assertESignProviderConfigured();

// AE GROW post-merge hardening — same fail-closed shape as the checks above. A process
// approved to send real brokerage/contact context to a real model provider
// (LIVE_AI_PROVIDER_APPROVED=true) must not start until an operator has explicitly decided
// BOTH the per-user daily allowance and the brokerage-level daily safety ceiling: the
// provisional per-tier numbers in TIER_CAPABILITIES are technical safety defaults, not a
// commercial allowance, and must never be reached for silently. A no-op in the pilot's
// mock-provider default, which needs no new environment variables at all. See
// lib/ai/usageLimits.ts for the variables, their accepted values, and the one explicit
// escape hatch (AI_DAILY_CAP_ENFORCED=false), which is warned about rather than hidden.
assertAiUsageLimitsConfigured(process.env, (event, detail) => logger.warn(event, detail));

async function start(): Promise<void> {
// AE GROW Pilot Readiness WP2a (P0-3): every timestamp column is
// `timestamp without time zone` in UTC; a non-UTC database session silently
// shifts DB-computed timestamps. Refuses to start in production (warns
// elsewhere) — see lib/dbTimezone.ts.
await assertDatabaseSessionTimezoneUtc();

if (process.env.NODE_ENV === "production") {
  const storageReadiness = await checkDocumentStorageReadiness();
  if (!storageReadiness.ready) {
    throw new Error(
      `Production document storage readiness failed: ${storageReadiness.message ?? "unavailable"}`,
    );
  }
}

configureEvents();

// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
// Registers the automation engine's domain-event handler for every
// canonical event type (see lib/automation/bootstrap.ts). Must run after
// configureEvents() so the event dispatch map already exists, and before
// the app starts accepting traffic so no early event is missed.
registerAutomationEngine();

// Agent Engine 2.0 — Exception & Risk Engine (Priority 4). Registers the
// event-driven exception handler and starts the periodic scan scheduler —
// same "after configureEvents(), before the app accepts traffic" ordering
// requirement as registerAutomationEngine() above, for the same reason (no
// canonical event fired between boot and registration should be missed).
registerExceptionEngine();

// AE GROW "Brokerage-wide Signal Sweep" (stage 1). Starts the periodic,
// single-flighted Property Intelligence signal sweep — no event handlers,
// so it has no ordering requirement relative to configureEvents(), but it
// is registered here alongside the other schedulers so every background
// engine is wired in one place. Never starts under NODE_ENV=test, and can
// be disabled entirely with GROW_SIGNAL_SWEEP_ENABLED=false (see
// lib/propertyIntelligence/sweep.ts's sweepConfig() for every variable).
registerSignalSweep();

// R-F4: Pit Crew WAITING_ON expected-at sweep. Off unless
// PIT_CREW_WAITING_ON_SWEEP_ENABLED=true.
registerPitCrewWaitingOnSweep();

// Agent Engine 2.0 — Property Launch & Campaign Coordination. Registers
// the AGENCY_AGREEMENT_SIGNED auto-propose handler — same ordering
// requirement as the two engines above.
registerLaunchEngine();

// Agent Engine 2.0 — Communications Hub (Priority 8). Starts the outbox
// sweep scheduler (quiet-hours-deferred sends, retry backoff) — same
// ordering requirement as the engines above.
registerCommunicationsEngine();

// Agent Engine 2.0 — Financial Transaction Engine (Priority 9, Stage F).
// Registers the SETTLEMENT_COMPLETED handler (commission finalisation +
// PC success-fee billing) and starts the payment outbox sweep scheduler —
// same ordering requirement as the engines above.
registerFinancialEngine();

// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
// Registers the one mock adapter/domain-proof handler this build ships and
// starts the outbox retry-sweep scheduler — same ordering requirement as
// the engines above.
registerIntegrationsEngine();

// Resolves interrupted two-phase document ingestions in bounded batches.
// Matching bytes are finalized; missing/corrupt terminal states are
// quarantined with audit evidence rather than silently discarded.
registerDocumentStorageReconciler();
registerCallTranscriptionReconciler();

// Fire-and-forget, non-blocking - same pattern as the rest of this app's boot-time setup.
// Never gates server startup on the seed completing.
// AE GROW Pilot Readiness WP2a: a failure is still logged under its original
// event name, and is now ALSO alerted and recorded so GET /api/health/ready
// reports this instance not-ready (lib/startupHealth.ts) — a broken
// entitlement catalogue must be visible, not just a log line. Boot continues.
// runTrackedStartupTask retries with bounded backoff before it marks anything
// not-ready, so a database still coming up at boot self-heals rather than
// taking the single always-on pilot instance permanently out of rotation; the
// per-attempt logger.error below therefore fires once per failed attempt.
void runTrackedStartupTask("entitlement_catalogue_seed", () =>
  ensureCatalogueSeeded().catch((err) => {
    logger.error("boot_ensure_catalogue_seeded_failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }),
);

// AE GROW Priority 0.5 — Workstream 3: idempotent, non-destructive backfill granting every
// pre-existing brokerage the run.access entitlement they implicitly always had, before that
// key existed to gate anything. Fire-and-forget, non-blocking, same pattern as
// ensureCatalogueSeeded above. See lib/billing/runAccessBackfill.ts's own module comment.
// Readiness-tracked and alerted exactly like the catalogue seed above.
void runTrackedStartupTask("run_access_backfill", () =>
  ensureRunAccessBackfilled().catch((err) => {
    logger.error("boot_ensure_run_access_backfilled_failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }),
);

// Agent Engine 2.0 — Run Transaction Vertical Slice. Idempotent per-brokerage
// install+activate sweep for the WAE Stage 2 workflow catalogue (see
// lib/automation/catalogueBootstrap.ts) — closes the confirmed gap where
// templates.ts's five workflow templates had zero production call sites.
// Fire-and-forget, non-blocking, same pattern as ensureCatalogueSeeded above.
// Readiness-tracked and alerted exactly like the catalogue seed above.
void runTrackedStartupTask("stage2_workflow_catalogue_seed", () =>
  ensureStage2CatalogueSeeded().catch((err) => {
    logger.error("boot_ensure_stage2_catalogue_seeded_failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }),
);

const app = createApp();
const port = Number(process.env.PORT ?? 8080);

app.listen(port, () => {
  logger.info("api_listening", { port });
});
}

start().catch((error) => {
  logger.error("api_startup_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
