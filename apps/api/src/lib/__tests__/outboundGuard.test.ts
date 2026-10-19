// WS4-09: with AEE_RESTORED_ENVIRONMENT on, every request-path outbound seam fails closed with
// RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED (HTTP 503 when it reaches the global error handler) and nothing leaves the
// process. fetch / http(s) / sockets are spied process-wide (loopback + test DB pass; anything else is recorded and
// refused). Switch-off controls prove each seam really calls its provider (and, for real transports, that the spies
// see the attempt). A guard test fails on any new transport that is not registered with a guard.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installOutboundSpies } from "./fixtures/outboundSpies.js";

const spies = installOutboundSpies();
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");

const guard = await import("../outboundGuard.js");
const { RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED, RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED_HTTP_STATUS, RestoredEnvironmentOutboundBlockedError, OUTBOUND_CHANNELS, NOT_GUARDED_TRANSPORTS } = guard;

const saved = { ...process.env };
beforeEach(() => { spies.reset(); process.env.AEE_RESTORED_ENVIRONMENT = "true"; });
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
const off = () => { delete process.env.AEE_RESTORED_ENVIRONMENT; };

function isBlocked(err: unknown, channel: string): boolean {
  assert.ok(err instanceof RestoredEnvironmentOutboundBlockedError, `expected the restored-environment block, got ${String(err)}`);
  assert.equal(err.code, RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED);
  assert.equal(err.httpStatus, 503);
  assert.equal(err.channel, channel);
  return true;
}
const expectBlocked = async (fn: () => unknown, channel: string) => {
  await assert.rejects(async () => { await fn(); }, (e) => isBlocked(e, channel));
  assert.deepEqual(spies.sends, [], "nothing may leave the process");
};
const expectNotBlocked = async (fn: () => unknown) => {
  try { await fn(); } catch (e) { assert.ok(!(e instanceof RestoredEnvironmentOutboundBlockedError), `control must not be blocked: ${String(e)}`); }
};

test("contract: one error code, HTTP 503, same parsing as WS4-07 (unknown values fail closed)", () => {
  assert.equal(RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED, "RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED");
  assert.equal(RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED_HTTP_STATUS, 503);
  for (const [v, blocked] of [["true", true], ["1", true], ["copy-of-prod", true], ["false", false], ["", false], [undefined, false]] as const) {
    const env = { AEE_RESTORED_ENVIRONMENT: v };
    assert.equal(guard.outboundBlocked("ai_provider", env) !== null, blocked, String(v));
  }
  assert.equal(guard.outboundBlocked("ai_provider", { AEE_RESTORED_ENVIRONMENT: "copy-of-prod" })?.reason, "unrecognised_value_fail_closed");
});

test("AI provider: generateWithGateway refuses before any provider (no silent fallback to mock); control reaches Anthropic", async () => {
  Object.assign(process.env, { AI_PROVIDER: "anthropic", AI_FALLBACK_PROVIDER: "mock", LIVE_AI_PROVIDER_APPROVED: "true", ANTHROPIC_API_KEY: "test-only-not-a-key", AI_RETRY_LIMIT: "0" });
  const { generateWithGateway, loadAiGatewayConfig } = await import("../ai/gateway.js");
  const req = { systemPrompt: "s", userPrompt: "u", model: "m", temperature: 0, maxOutputTokens: 8, timeoutMs: 1000 };
  await expectBlocked(() => generateWithGateway(req, loadAiGatewayConfig()), "ai_provider");
  const { AnthropicAiProvider } = await import("../ai/providers/anthropicProvider.js");
  await expectBlocked(() => new AnthropicAiProvider("test-only-not-a-key").generate(req), "ai_provider");
  off();
  await expectNotBlocked(() => generateWithGateway(req, loadAiGatewayConfig()));
  assert.ok(spies.sends.some((s) => s.target.includes("api.anthropic.com")), `control: the spy saw the Anthropic call ${JSON.stringify(spies.sends)}`);
});

test("voice + call transcription: provider construction refused; Deepgram transport refused; control reaches Deepgram", async () => {
  Object.assign(process.env, { LIVE_VOICE_TRANSCRIPTION_APPROVED: "true", LIVE_CALL_TRANSCRIPTION_APPROVED: "true", DEEPGRAM_API_KEY: "test-only-not-a-key" });
  const { buildVoiceTranscriptionProvider, buildCallTranscriptionProvider } = await import("../ai/voice/gateway.js");
  await expectBlocked(() => buildVoiceTranscriptionProvider({ provider: "deepgram", timeoutMs: 1000 }), "voice_transcription");
  await expectBlocked(() => buildVoiceTranscriptionProvider({ provider: "mock", timeoutMs: 1000 }), "voice_transcription");
  await expectBlocked(() => buildCallTranscriptionProvider({ provider: "deepgram", timeoutMs: 1000 }), "voice_transcription");
  const { DeepgramTranscriptionProvider } = await import("../ai/voice/deepgramTranscriptionProvider.js");
  const input = { audioBytes: Buffer.from("x"), mimeType: "audio/webm", timeoutMs: 1000, correlationId: "c" };
  await expectBlocked(() => new DeepgramTranscriptionProvider("test-only-not-a-key").transcribe(input), "voice_transcription");
  off();
  await expectNotBlocked(() => new DeepgramTranscriptionProvider("test-only-not-a-key").transcribe(input));
  assert.ok(spies.sends.some((s) => s.target.includes("deepgram.com")), "control: the spy saw the Deepgram call");
});

test("operational alerts/webhooks: a structured 'blocked' result (never a throw, callers are fire-and-forget); control reaches the webhook", async () => {
  Object.assign(process.env, { OPERATIONAL_ALERTS_ENABLED: "true", OPERATIONAL_ALERTS_PROVIDER: "webhook", OPERATIONAL_ALERTS_WEBHOOK_URL: "https://alerts.example.invalid/hook", OPERATIONAL_ALERTS_TOKEN: "test-only-token-0123456789" });
  const alerts = await import("../operationalAlerts.js");
  alerts.__resetOperationalAlertsForTesting();
  const r = await alerts.dispatchOperationalAlert({ type: "TEST", summary: "s", dedupKey: `ws4-09-${Date.now()}` });
  assert.deepEqual(r, { status: "blocked", code: RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED, reason: "explicit_on" });
  assert.equal(spies.sends.length, 0, "nothing may leave the process");
  off();
  alerts.__resetOperationalAlertsForTesting();
  const c = await alerts.dispatchOperationalAlert({ type: "TEST", summary: "s", dedupKey: `ws4-09-c-${Date.now()}` });
  assert.equal(c.status, "failed");
  assert.ok(spies.sends.some((s) => s.target.includes("alerts.example.invalid")), "control: the spy saw the webhook POST");
});

test("communications EMAIL/SMS: provider resolution refused (message stays QUEUED, no SENDING); control resolves the sandbox", async () => {
  const { resolveEmailProvider, resolveSmsProvider } = await import("../communications/providers/registry.js");
  await expectBlocked(() => resolveEmailProvider(), "communications_email");
  await expectBlocked(() => resolveSmsProvider(), "communications_sms");
  off();
  assert.equal(resolveEmailProvider().name, "sandbox_email");
  assert.equal(resolveSmsProvider().name, "sandbox_sms");
});

test("auth email (invitation / reset / succession): every send rejects, sandbox log untouched; control records the send", async () => {
  const email = await import("../auth/email.js");
  email.__clearSandboxAuthEmailLog();
  const p = email.getAuthEmailProvider();
  await expectBlocked(() => p.sendPasswordReset({ to: "a@example.com", resetUrl: "http://x/r", expiresAt: new Date() }), "auth_email");
  await expectBlocked(() => p.sendInvitation({ to: "a@example.com", brokerageName: "b", acceptUrl: "http://x/a", expiresAt: new Date() }), "auth_email");
  await expectBlocked(() => p.sendAdministratorSuccession({ to: "a@example.com", counterpartEmail: "b@example.com", becameAdministrator: true }), "auth_email");
  assert.equal(email.__getSandboxAuthEmailLog().length, 0);
  off();
  await email.getAuthEmailProvider().sendPasswordReset({ to: "a@example.com", resetUrl: "http://x/r", expiresAt: new Date() });
  assert.equal(email.__getSandboxAuthEmailLog().length, 1);
});

test("e-sign / payments / mandate payments / AML / billing adapters: send methods refused, local methods untouched", async () => {
  const { esignProvider } = await import("../documents.js");
  const { paymentProvider } = await import("../payments.js");
  const { mandatePaymentProvider } = await import("../financial/provider.js");
  const { amlProvider } = await import("../aml.js");
  const { getBillingProvider, resetBillingProviderCacheForTests } = await import("../billing/gateway.js");
  resetBillingProviderCacheForTests();
  const any = {} as never;
  await expectBlocked(() => esignProvider.createEnvelope(any), "esign");
  await expectBlocked(() => paymentProvider.chargeStoredMethod(any), "payments");
  await expectBlocked(() => paymentProvider.refund("r", 1), "payments");
  await expectBlocked(() => mandatePaymentProvider.scheduleDebit(any), "mandate_payments");
  await expectBlocked(() => mandatePaymentProvider.cancelScheduledDebit("r"), "mandate_payments");
  await expectBlocked(() => mandatePaymentProvider.reverseDebit("r", 1, "x"), "mandate_payments");
  await expectBlocked(() => amlProvider.requestVerification(any), "aml");
  await expectBlocked(() => getBillingProvider().createCheckoutSession(any), "billing");
  await expectBlocked(() => getBillingProvider().cancelSubscription("s", { atPeriodEnd: true }), "billing");
  // Inbound webhook verification is local work and must keep working in a restored environment.
  assert.equal(typeof esignProvider.verifyWebhookSignature("{}", "bad"), "boolean");
  off();
  await expectNotBlocked(() => esignProvider.createEnvelope(any));
  await expectNotBlocked(() => getBillingProvider().cancelSubscription("s", { atPeriodEnd: true }));
});

test("a real package adapter behind guardOutboundProvider never reaches its fetch (Stripe billing as the example); control does", async () => {
  const { StripeBillingProvider } = await import("@aee/integration-billing");
  const real = new StripeBillingProvider({ secretKey: "test-only-not-a-key", webhookSecret: "", apiBaseUrl: "https://billing.example.invalid" });
  const guarded = guard.guardOutboundProvider("billing", real, ["createCheckoutSession", "cancelSubscription"]);
  await expectBlocked(() => guarded.cancelSubscription("sub_x", { atPeriodEnd: true }), "billing");
  off();
  await expectNotBlocked(() => guarded.cancelSubscription("sub_x", { atPeriodEnd: true }));
  assert.ok(spies.sends.some((s) => s.target.includes("billing.example.invalid")), "control: the spy saw the Stripe call");
});

test("manual financial dispatch: dispatchPendingPaymentOutbox refuses before touching the outbox; control runs", async () => {
  const { dispatchPendingPaymentOutbox } = await import("../financial/paymentOutbox.js");
  await expectBlocked(() => dispatchPendingPaymentOutbox(), "financial_payment_dispatch");
  off();
  const r = await dispatchPendingPaymentOutbox();
  assert.equal(typeof r.attempted, "number");
});

test("each block logs one structured warn line with channel, code and reason", async () => {
  const lines: string[] = [];
  // The logger writes JSON lines to stdout or stderr depending on level; capture both.
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const cap = (c: unknown) => { lines.push(String(c)); return true; };
  (process.stdout as { write: unknown }).write = cap;
  (process.stderr as { write: unknown }).write = cap;
  try { guard.outboundBlocked("auth_email"); } finally {
    (process.stdout as { write: unknown }).write = realOut;
    (process.stderr as { write: unknown }).write = realErr;
  }
  const parsed = lines.flatMap((l) => l.split("\n")).filter((l) => l.includes("restored_environment_outbound_blocked")).map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].channel, "auth_email");
  assert.equal(parsed[0].code, RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED);
  assert.equal(parsed[0].reason, "explicit_on");
});

// ---------- guard: every outbound transport is registered and guarded ----------
const TRANSPORT_RE = /\bfetch\s*\(|\bhttps?\.(request|get)\s*\(|\bnet\.connect\s*\(|\btls\.connect\s*\(|new\s+WebSocket\s*\(|createTransport\s*\(/;
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return ["__tests__", "node_modules", "dist", "test"].includes(n) ? [] : walk(p);
    return /\.(ts|mts|js|mjs)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
function transportFiles(): string[] {
  const roots = [path.join(repoRoot, "apps/api/src"), ...readdirSync(path.join(repoRoot, "packages")).flatMap((p) => {
    const d = path.join(repoRoot, "packages", p);
    return p === "integrations" ? readdirSync(d).map((s) => path.join(d, s, "src")) : [path.join(d, "src")];
  })];
  return roots.flatMap((r) => { try { return walk(r); } catch { return []; } })
    .filter((f) => readFileSync(f, "utf8").split("\n").some((l) => !/^\s*(\/\/|\*)/.test(l) && TRANSPORT_RE.test(l)))
    .map((f) => path.relative(repoRoot, f).split(path.sep).join("/")).sort();
}

test("guard: every file that opens an outbound transport is registered to a guarded channel (or explicitly not guarded, with a reason)", () => {
  const registered = new Set<string>([...Object.values(OUTBOUND_CHANNELS).flatMap((c) => [...c.transports]), ...Object.keys(NOT_GUARDED_TRANSPORTS)]);
  const files = transportFiles();
  assert.ok(files.length >= 6, files.join(","));
  assert.deepEqual(files.filter((f) => !registered.has(f)), [], "register the transport in lib/outboundGuard.ts OUTBOUND_CHANNELS and guard it");
});

test("guard: every channel's guard site (and every apps/api transport) calls the guard with its own channel id", () => {
  for (const [id, ch] of Object.entries(OUTBOUND_CHANNELS)) {
    for (const f of [ch.guard, ...ch.transports.filter((t) => t.startsWith("apps/api/"))]) {
      const src = readFileSync(path.join(repoRoot, f), "utf8");
      assert.ok(new RegExp(`(assertOutboundAllowed|outboundBlocked|guardOutboundProvider)\\(\\s*"${id}"`).test(src), `${f} must guard channel "${id}"`);
    }
  }
});
