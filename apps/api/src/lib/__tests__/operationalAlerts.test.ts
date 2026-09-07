import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetOperationalAlertsForTesting,
  __setOperationalAlertTransportForTesting,
  assertOperationalAlertsConfigured,
  dispatchOperationalAlert,
  dispatchTestOperationalAlert,
} from "../operationalAlerts.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
  __resetOperationalAlertsForTesting();
});

function configure(): void {
  process.env.OPERATIONAL_ALERTS_ENABLED = "true";
  process.env.OPERATIONAL_ALERTS_PROVIDER = "webhook";
  process.env.OPERATIONAL_ALERTS_WEBHOOK_URL = "https://alerts.example.invalid/events";
  process.env.OPERATIONAL_ALERTS_TOKEN = "test-token-at-least-sixteen-characters";
}

test("production startup unconditionally fails closed when alert configuration is missing or invalid", () => {
  process.env.NODE_ENV = "production";
  assert.throws(() => assertOperationalAlertsConfigured(), /OPERATIONAL_ALERTS_ENABLED/);

  configure();
  process.env.OPERATIONAL_ALERTS_WEBHOOK_URL = "http://alerts.example.invalid/events";
  assert.throws(() => assertOperationalAlertsConfigured(), /valid HTTPS/);

  process.env.OPERATIONAL_ALERTS_WEBHOOK_URL = "https://alerts.example.invalid/events";
  process.env.OPERATIONAL_ALERTS_TOKEN = "short";
  assert.throws(() => assertOperationalAlertsConfigured(), /at least 16/);
});

test("unselected and disabled providers never invoke outbound transport", async () => {
  let calls = 0;
  __setOperationalAlertTransportForTesting(async () => {
    calls++;
    return 204;
  });
  process.env.OPERATIONAL_ALERTS_ENABLED = "true";
  process.env.OPERATIONAL_ALERTS_PROVIDER = "unselected-provider";
  const result = await dispatchOperationalAlert({ type: "DB_READINESS_FAILURE", summary: "failure", dedupKey: "db" });
  assert.equal(result.status, "disabled");
  assert.equal(calls, 0);
});

test("valid configured alerts are delivered once during their cooldown", async () => {
  configure();
  const envelopes: Array<{ severity: string; owner: string; runbook: string }> = [];
  __setOperationalAlertTransportForTesting(async (_url, _token, envelope) => {
    envelopes.push(envelope);
    return 202;
  });
  const input = { type: "TENANT_SECURITY_SIGNAL" as const, summary: "tenant mismatch", dedupKey: "tenant:42" };
  assert.equal((await dispatchOperationalAlert(input)).status, "delivered");
  assert.equal((await dispatchOperationalAlert(input)).status, "deduplicated");
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].severity, "critical");
  assert.equal(envelopes[0].owner, "security");
  assert.equal(envelopes[0].runbook, "tenant-isolation");
});

test("failed delivery is structured as failure and can be retried", async () => {
  configure();
  let calls = 0;
  __setOperationalAlertTransportForTesting(async () => {
    calls++;
    return calls <= 3 ? 503 : 204;
  });
  const input = { type: "BACKUP_FAILURE" as const, summary: "backup failed", dedupKey: "backup:daily:1" };
  assert.equal((await dispatchOperationalAlert(input)).status, "failed");
  assert.equal((await dispatchOperationalAlert(input)).status, "delivered");
  assert.equal(calls, 4, "a failed request receives three in-process attempts, then a later boundary can retry");
});

test("test alert requires a separate explicit opt-in and has no caller payload", async () => {
  configure();
  let calls = 0;
  __setOperationalAlertTransportForTesting(async () => {
    calls++;
    return 204;
  });
  assert.equal((await dispatchTestOperationalAlert()).status, "disabled");
  process.env.OPERATIONAL_ALERTS_ALLOW_TEST = "true";
  assert.equal((await dispatchTestOperationalAlert()).status, "delivered");
  assert.equal(calls, 1);
});