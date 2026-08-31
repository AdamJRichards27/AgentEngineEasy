import { createApp } from "./app.js";
import { configureEvents } from "./lib/events.js";
import { ensureCatalogueSeeded } from "./lib/billing/catalogue.js";
import { assertSessionSecretConfigured } from "./lib/session.js";
import { registerAutomationEngine } from "./lib/automation/bootstrap.js";
import { ensureStage2CatalogueSeeded } from "./lib/automation/catalogueBootstrap.js";

// Foundation Remediation Stage 1.2: fail closed at boot, not at first
// request, if SESSION_SECRET is missing or too weak. A process that
// can't sign trustworthy sessions must not accept traffic at all.
assertSessionSecretConfigured();

configureEvents();

// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
// Registers the automation engine's domain-event handler for every
// canonical event type (see lib/automation/bootstrap.ts). Must run after
// configureEvents() so the event dispatch map already exists, and before
// the app starts accepting traffic so no early event is missed.
registerAutomationEngine();

// Fire-and-forget, non-blocking - same pattern as the rest of this app's boot-time setup.
// Never gates server startup on the seed completing.
ensureCatalogueSeeded().catch((err) => console.error("ensureCatalogueSeeded failed", err));

// Agent Engine 2.0 — Run Transaction Vertical Slice. Idempotent per-brokerage
// install+activate sweep for the WAE Stage 2 workflow catalogue (see
// lib/automation/catalogueBootstrap.ts) — closes the confirmed gap where
// templates.ts's five workflow templates had zero production call sites.
// Fire-and-forget, non-blocking, same pattern as ensureCatalogueSeeded above.
ensureStage2CatalogueSeeded().catch((err) => console.error("ensureStage2CatalogueSeeded failed", err));

const app = createApp();
const port = Number(process.env.PORT ?? 8080);

app.listen(port, () => {
  console.log(`AgentEngineEasy API listening on :${port}`);
});
