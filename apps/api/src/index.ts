import { createApp } from "./app.js";
import { configureEvents } from "./lib/events.js";
import { ensureCatalogueSeeded } from "./lib/billing/catalogue.js";
import { assertSessionSecretConfigured } from "./lib/session.js";

// Foundation Remediation Stage 1.2: fail closed at boot, not at first
// request, if SESSION_SECRET is missing or too weak. A process that
// can't sign trustworthy sessions must not accept traffic at all.
assertSessionSecretConfigured();

configureEvents();

// Fire-and-forget, non-blocking - same pattern as the rest of this app's boot-time setup.
// Never gates server startup on the seed completing.
ensureCatalogueSeeded().catch((err) => console.error("ensureCatalogueSeeded failed", err));

const app = createApp();
const port = Number(process.env.PORT ?? 8080);

app.listen(port, () => {
  console.log(`AgentEngineEasy API listening on :${port}`);
});
