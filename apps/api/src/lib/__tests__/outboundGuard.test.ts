// WS4-09 + WS4-11: request-path outbound policy in a restored environment (AEE_RESTORED_ENVIRONMENT; unknown values =
// restored). In-process providers are allowed (D-MOCK); network or unclassified providers are refused unless their
// `channel:provider` pair is in AEE_RESTORED_ENV_OUTBOUND_ALLOW; auth email is always refused; object-storage writes
// need AEE_RESTORED_ENV_STORAGE_ISOLATED=true exactly (D-OS). fetch / http(s) / sockets are spied process-wide
// (loopback + test DB pass; anything else is recorded and refused), so nothing ever reaches the network, even in the
// controls. Guard tests fail on an unregistered transport, an unclassified provider class, a provider whose evidence
// contradicts its classification, or an unclassified object-storage method.
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
const { RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED, RestoredEnvironmentOutboundBlockedError, OUTBOUND_CHANNELS, NOT_GUARDED_TRANSPORTS, PROVIDERS, STORAGE_READ_METHODS, STORAGE_WRITE_METHODS } = guard;

const saved = { ...process.env };
beforeEach(() => { spies.reset(); process.env.AEE_RESTORED_ENVIRONMENT = "true"; delete process.env.AEE_RESTORED_ENV_OUTBOUND_ALLOW; delete process.env.AEE_RESTORED_ENV_STORAGE_ISOLATED; });
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
const off = () => { delete process.env.AEE_RESTORED_ENVIRONMENT; };
const allow = (v: string) => { process.env.AEE_RESTORED_ENV_OUTBOUND_ALLOW = v; };

function isBlocked(err: unknown, channel: string, provider?: string): boolean {
  assert.ok(err instanceof RestoredEnvironmentOutboundBlockedError, `expected the restored-environment block, got ${String(err)}`);
  assert.equal(err.code, RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED);
  assert.equal(err.httpStatus, 503);
  assert.equal(err.channel, channel);
  if (provider !== undefined) assert.equal(err.provider, provider);
  return true;
}
const expectBlocked = async (fn: () => unknown, channel: string, provider?: string) => {
  await assert.rejects(async () => { await fn(); }, (e) => isBlocked(e, channel, provider));
  assert.equal(spies.sends.length, 0, `nothing may leave the process: ${JSON.stringify(spies.sends)}`);
};
const expectAllowed = async (fn: () => unknown) => {
  try { await fn(); } catch (e) { assert.ok(!(e instanceof RestoredEnvironmentOutboundBlockedError), `must not be blocked: ${String(e)}`); }
};
const sawSend = (host: string) => assert.ok(spies.sends.some((s) => s.target.includes(host)), `the spy must see ${host}: ${JSON.stringify(spies.sends)}`);

test("contract: code, 503, switch parsing unchanged (unknown = restored), allow-list and isolation parsing", () => {
  assert.equal(RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED, "RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED");
  assert.equal(guard.RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED_HTTP_STATUS, 503);
  assert.equal(guard.RESTORED_ENV_OUTBOUND_ALLOW_ENV, "AEE_RESTORED_ENV_OUTBOUND_ALLOW");
  for (const [v, restored] of [["true", true], ["1", true], ["copy-of-prod", true], ["false", false], ["", false], [undefined, false]] as const) {
    assert.equal(guard.outboundBlocked("ai_provider", "anthropic", { AEE_RESTORED_ENVIRONMENT: v }) !== null, restored, String(v));
  }
  assert.equal(guard.outboundBlocked("ai_provider", "anthropic", { AEE_RESTORED_ENVIRONMENT: "copy-of-prod" })?.reason, "unrecognised_value_fail_closed");
  const list = guard.restoredOutboundAllowList({ AEE_RESTORED_ENV_OUTBOUND_ALLOW: " ai_provider:anthropic ,auth_email:sandbox_auth_email,nope:x,AI_PROVIDER:anthropic,ai_provider,operational_alerts:webhook" });
  assert.deepEqual([...list].sort(), ["ai_provider:anthropic", "operational_alerts:webhook"]);
  assert.equal(guard.restoredOutboundAllowList({}).size, 0, "default allow-list is empty");
  for (const [v, iso] of [["true", true], ["TRUE", false], ["1", false], ["yes", false], [" true", false], [undefined, false]] as const) {
    assert.equal(guard.restoredStorageIsolated({ AEE_RESTORED_ENV_STORAGE_ISOLATED: v }), iso, String(v));
  }
  assert.equal(guard.classifyProvider("ai_provider", "never-heard-of-it"), "network", "unclassified fails closed");
});

test("AI: mock allowed (UAT); Anthropic refused before any call (no fallback); allow-listed Anthropic proceeds; control proceeds", async () => {
  const { generateWithGateway, loadAiGatewayConfig } = await import("../ai/gateway.js");
  const req = { systemPrompt: "s", userPrompt: "u", model: "m", temperature: 0, maxOutputTokens: 8, timeoutMs: 1000 };
  const mockRes = await generateWithGateway(req, loadAiGatewayConfig());
  assert.equal(mockRes.response.provider, "mock");
  assert.equal(spies.sends.length, 0);
  Object.assign(process.env, { AI_PROVIDER: "anthropic", AI_FALLBACK_PROVIDER: "mock", LIVE_AI_PROVIDER_APPROVED: "true", ANTHROPIC_API_KEY: "test-only-not-a-key", AI_RETRY_LIMIT: "0" });
  await expectBlocked(() => generateWithGateway(req, loadAiGatewayConfig()), "ai_provider", "anthropic");
  const { AnthropicAiProvider } = await import("../ai/providers/anthropicProvider.js");
  await expectBlocked(() => new AnthropicAiProvider("test-only-not-a-key").generate(req), "ai_provider", "anthropic");
  allow("ai_provider:anthropic");
  await expectAllowed(() => generateWithGateway(req, loadAiGatewayConfig()));
  sawSend("api.anthropic.com");
  spies.reset(); delete process.env.AEE_RESTORED_ENV_OUTBOUND_ALLOW; off();
  await expectAllowed(() => generateWithGateway(req, loadAiGatewayConfig()));
  sawSend("api.anthropic.com");
});

test("voice/call transcription: mock allowed; Deepgram refused at build and transport; allow-listed Deepgram proceeds", async () => {
  Object.assign(process.env, { LIVE_VOICE_TRANSCRIPTION_APPROVED: "true", LIVE_CALL_TRANSCRIPTION_APPROVED: "true", DEEPGRAM_API_KEY: "test-only-not-a-key" });
  const { buildVoiceTranscriptionProvider, buildCallTranscriptionProvider } = await import("../ai/voice/gateway.js");
  assert.equal(buildVoiceTranscriptionProvider({ provider: "mock", timeoutMs: 1000 }).name, "mock");
  assert.equal(buildCallTranscriptionProvider({ provider: "mock", timeoutMs: 1000 }).name, "mock");
  await expectBlocked(() => buildVoiceTranscriptionProvider({ provider: "deepgram", timeoutMs: 1000 }), "voice_transcription", "deepgram");
  await expectBlocked(() => buildCallTranscriptionProvider({ provider: "deepgram", timeoutMs: 1000 }), "voice_transcription", "deepgram");
  const { DeepgramTranscriptionProvider } = await import("../ai/voice/deepgramTranscriptionProvider.js");
  const input = { audioBytes: Buffer.from("x"), mimeType: "audio/webm", timeoutMs: 1000, correlationId: "c" };
  await expectBlocked(() => new DeepgramTranscriptionProvider("test-only-not-a-key").transcribe(input), "voice_transcription", "deepgram");
  allow("voice_transcription:deepgram");
  assert.equal(buildVoiceTranscriptionProvider({ provider: "deepgram", timeoutMs: 1000 }).name, "deepgram");
  await expectAllowed(() => new DeepgramTranscriptionProvider("test-only-not-a-key").transcribe(input));
  sawSend("deepgram.com");
});

test("operational alerts/webhooks: refused as a structured result; allow-listed webhook proceeds; control proceeds", async () => {
  Object.assign(process.env, { OPERATIONAL_ALERTS_ENABLED: "true", OPERATIONAL_ALERTS_PROVIDER: "webhook", OPERATIONAL_ALERTS_WEBHOOK_URL: "https://alerts.example.invalid/hook", OPERATIONAL_ALERTS_TOKEN: "test-only-token-0123456789" });
  const alerts = await import("../operationalAlerts.js");
  alerts.__resetOperationalAlertsForTesting();
  const r = await alerts.dispatchOperationalAlert({ type: "TEST", summary: "s", dedupKey: `a-${Date.now()}` });
  assert.deepEqual(r, { status: "blocked", code: RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED, reason: "explicit_on" });
  assert.equal(spies.sends.length, 0);
  allow("operational_alerts:webhook");
  alerts.__resetOperationalAlertsForTesting();
  assert.equal((await alerts.dispatchOperationalAlert({ type: "TEST", summary: "s", dedupKey: `b-${Date.now()}` })).status, "failed");
  sawSend("alerts.example.invalid");
});

test("communications: in-process sandbox allowed (sends through); an unclassified provider fails closed", async () => {
  const reg = await import("../communications/providers/registry.js");
  assert.equal(reg.resolveEmailProvider().name, "sandbox_email");
  assert.equal(reg.resolveSmsProvider().name, "sandbox_sms");
  assert.equal((await reg.resolveEmailProvider().send({ to: "a@example.com", subject: "s", bodyText: "b", bodyHtml: null, idempotencyKey: "k" } as never)).status, "SENT");
  assert.equal(spies.sends.length, 0);
  process.env.LIVE_COMMUNICATIONS_APPROVED = "true";
  process.env.COMMUNICATIONS_EMAIL_PROVIDER = "acme_mail";
  reg.setCommunicationProvidersForTests({ email: { name: "acme_mail", send: async () => { throw new Error("must not be called"); } } });
  try {
    await expectBlocked(() => reg.resolveEmailProvider(), "communications_email", "acme_mail");
  } finally { reg.resetCommunicationProvidersForTests(); }
});

test("auth email: refused whatever the provider (in-process sandbox included) and not allow-listable", async () => {
  const email = await import("../auth/email.js");
  email.__clearSandboxAuthEmailLog();
  allow("auth_email:sandbox_auth_email");
  const p = email.getAuthEmailProvider();
  await expectBlocked(() => p.sendPasswordReset({ to: "a@example.com", resetUrl: "http://x/r", expiresAt: new Date() }), "auth_email");
  await expectBlocked(() => p.sendInvitation({ to: "a@example.com", brokerageName: "b", acceptUrl: "http://x/a", expiresAt: new Date() }), "auth_email");
  await expectBlocked(() => p.sendAdministratorSuccession({ to: "a@example.com", counterpartEmail: "b@example.com", becameAdministrator: true }), "auth_email");
  assert.equal(email.__getSandboxAuthEmailLog().length, 0);
});

test("mock e-sign/payments/mandate/AML/billing adapters are allowed (in-process); real HTTP adapters refused unless allow-listed", async () => {
  const { esignProvider } = await import("../documents.js");
  const { paymentProvider } = await import("../payments.js");
  const { mandatePaymentProvider } = await import("../financial/provider.js");
  const { amlProvider } = await import("../aml.js");
  const { getBillingProvider, resetBillingProviderCacheForTests } = await import("../billing/gateway.js");
  resetBillingProviderCacheForTests();
  const any = {} as never;
  for (const fn of [() => esignProvider.createEnvelope(any), () => paymentProvider.refund("r", 1), () => mandatePaymentProvider.cancelScheduledDebit("r"), () => amlProvider.requestVerification(any), () => getBillingProvider().cancelSubscription("s", { atPeriodEnd: true })]) await expectAllowed(fn);
  assert.equal(spies.sends.length, 0);
  const { StripeBillingProvider } = await import("@aee/integration-billing");
  const { HttpESignProvider } = await import("@aee/integration-esign");
  const { HttpAMLProvider } = await import("@aee/integration-aml");
  const stripe = guard.guardOutboundProvider("billing", new StripeBillingProvider({ secretKey: "test-only-not-a-key", webhookSecret: "", apiBaseUrl: "https://billing.example.invalid" }), ["createCheckoutSession", "cancelSubscription"], (p) => p.name);
  const esign = guard.guardOutboundProvider("esign", new HttpESignProvider({ baseUrl: "https://esign.example.invalid", apiKey: "test-only-not-a-key", webhookSecret: "x" } as never), ["createEnvelope"], (p) => p.kind);
  const aml = guard.guardOutboundProvider("aml", new HttpAMLProvider({ baseUrl: "https://aml.example.invalid", apiKey: "test-only-not-a-key", webhookSecret: "x" } as never), ["requestVerification"], () => "http");
  await expectBlocked(() => stripe.cancelSubscription("sub_x", { atPeriodEnd: true }), "billing", "stripe");
  await expectBlocked(() => esign.createEnvelope({ documents: [], signatories: [] } as never), "esign", "http");
  await expectBlocked(() => aml.requestVerification(any), "aml", "http");
  allow("billing:stripe");
  await expectAllowed(() => stripe.cancelSubscription("sub_x", { atPeriodEnd: true }));
  sawSend("billing.example.invalid");
});

test("seams pick the right provider id: payments/AML instanceof, e-sign kind, billing/mandate name", async () => {
  const { paymentProviderId } = await import("../payments.js");
  const { amlProviderId } = await import("../aml.js");
  const pay = await import("@aee/integration-payments");
  const amlPkg = await import("@aee/integration-aml");
  assert.equal(paymentProviderId(new pay.MockPaymentProvider() as never), "mock");
  assert.equal(paymentProviderId(new pay.StripePaymentProvider({ secretKey: "test-only", webhookSecret: "x", apiBaseUrl: "https://p.example.invalid" } as never)), "stripe");
  assert.equal(amlProviderId(new amlPkg.MockAMLProvider() as never), "mock");
  assert.equal(amlProviderId(new amlPkg.HttpAMLProvider({ baseUrl: "https://a.example.invalid", apiKey: "k", webhookSecret: "x" } as never)), "http");
  assert.equal(paymentProviderId({} as never), "unclassified", "anything else is unclassified, i.e. network");
});

test("manual financial dispatch: sandbox mandate adapter is in-process, so dispatch runs in a restored environment", async () => {
  const { dispatchPendingPaymentOutbox } = await import("../financial/paymentOutbox.js");
  const r = await dispatchPendingPaymentOutbox();
  assert.equal(typeof r.attempted, "number");
  assert.equal(spies.sends.length, 0);
});

test("telephony: the in-process sandbox dialler is allowed; an unclassified dialler is refused", async () => {
  assert.equal(guard.outboundBlocked("telephony", "sandbox"), null);
  assert.ok(guard.outboundBlocked("telephony", "twilio") instanceof RestoredEnvironmentOutboundBlockedError);
});

test("D-OS: S3 writes/deletes refused unless AEE_RESTORED_ENV_STORAGE_ISOLATED=true exactly; reads go through", async () => {
  Object.assign(process.env, { OBJECT_STORAGE_PROVIDER: "s3", OBJECT_STORAGE_ENDPOINT: "https://storage.example.invalid", OBJECT_STORAGE_REGION: "ap-southeast-2", OBJECT_STORAGE_BUCKET: "restored-test", OBJECT_STORAGE_ACCESS_KEY_ID: "test-only", OBJECT_STORAGE_SECRET_ACCESS_KEY: "test-only-not-a-secret" });
  const ds = await import("../documentStorage.js");
  ds.setDocumentStorageProviderForTests(null);
  try {
    const p = ds.documentStorageProvider();
    for (const iso of [undefined, "TRUE", "1", "yes"]) {
      if (iso === undefined) delete process.env.AEE_RESTORED_ENV_STORAGE_ISOLATED; else process.env.AEE_RESTORED_ENV_STORAGE_ISOLATED = iso;
      await expectBlocked(() => p.putObject("restored/x.txt", "x", "text/plain"), "object_storage_write", "s3");
      await expectBlocked(() => p.deleteObject("restored/x.txt"), "object_storage_write", "s3");
    }
    delete process.env.AEE_RESTORED_ENV_STORAGE_ISOLATED;
    await expectAllowed(() => p.getObject("restored/x.txt"));
    sawSend("storage.example.invalid");
    spies.reset();
    process.env.AEE_RESTORED_ENV_STORAGE_ISOLATED = "true";
    await expectAllowed(() => p.putObject("restored/x.txt", "x", "text/plain"));
    sawSend("storage.example.invalid");
    spies.reset(); delete process.env.AEE_RESTORED_ENV_STORAGE_ISOLATED; off();
    await expectAllowed(() => p.deleteObject("restored/x.txt"));
    sawSend("storage.example.invalid");
  } finally { ds.setDocumentStorageProviderForTests(null); }
});

test("each block logs one structured warn line with channel, provider, rule, code and reason", async () => {
  const lines: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const cap = (c: unknown) => { lines.push(String(c)); return true; };
  (process.stdout as { write: unknown }).write = cap;
  (process.stderr as { write: unknown }).write = cap;
  try { guard.outboundBlocked("ai_provider", "anthropic"); } finally {
    (process.stdout as { write: unknown }).write = realOut;
    (process.stderr as { write: unknown }).write = realErr;
  }
  const parsed = lines.flatMap((l) => l.split("\n")).filter((l) => l.includes("restored_environment_outbound_blocked")).map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);
  assert.deepEqual([parsed[0].channel, parsed[0].provider, parsed[0].rule, parsed[0].code, parsed[0].reason], ["ai_provider", "anthropic", "network_provider_not_allowlisted", RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED, "explicit_on"]);
});

// ---------- WS4-12 ----------
test("WS4-12 (a): local filesystem storage writes/deletes are allowed in a restored env; S3 and unclassified stay blocked", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  assert.equal(guard.storageWriteBlocked("local"), null, "local fs is exempt");
  assert.ok(guard.storageWriteBlocked("s3") instanceof RestoredEnvironmentOutboundBlockedError);
  assert.ok(guard.storageWriteBlocked("unclassified") instanceof RestoredEnvironmentOutboundBlockedError);
  const dir = await mkdtemp(path.join(tmpdir(), "ws4-12-local-"));
  Object.assign(process.env, { OBJECT_STORAGE_PROVIDER: "local", OBJECT_STORAGE_LOCAL_DIR: dir });
  const ds = await import("../documentStorage.js");
  ds.setDocumentStorageProviderForTests(null);
  try {
    const p = ds.documentStorageProvider();
    await p.putObject("restored/local.txt", Buffer.from("x"), "text/plain");
    assert.ok(await p.headObject("restored/local.txt"), "the local write landed");
    await p.deleteObject("restored/local.txt");
    assert.equal(spies.sends.length, 0);
  } finally { ds.setDocumentStorageProviderForTests(null); await rm(dir, { recursive: true, force: true }); }
});

test("WS4-12 (b): property data — mock allowed; GooglePlaces refused unless allow-listed; ownership lookup (local) untouched; control", async () => {
  const pd = await import("../propertyData.js");
  const pkg = await import("@aee/integration-property-data");
  assert.equal(guard.classifyProvider("property_data", "mock"), "in_process");
  assert.equal(guard.classifyProvider("property_data", "google-places"), "network");
  assert.equal(pd.propertyDataProviderId(new pkg.MockPropertyDataProvider()), "mock");
  assert.equal(pd.propertyDataProviderId(new pkg.GooglePlacesProvider("test-only-not-a-key")), "google-places");
  assert.equal(pd.propertyDataProviderId({} as never), "unclassified");
  // Factory default (mock) works in a restored env.
  const mock = pd.createGuardedPropertyDataProvider();
  assert.equal((await mock.searchAddress("1 Test St")).length, 1);
  assert.equal(spies.sends.length, 0);
  // GooglePlaces through the factory (non-production, key set): searchAddress/resolveAddress refused, nothing sent.
  Object.assign(process.env, { PROPERTY_DATA_PROVIDER: "google-places", GOOGLE_PLACES_API_KEY: "test-only-not-a-key" });
  const gp = pd.createGuardedPropertyDataProvider();
  await expectBlocked(() => gp.searchAddress("1 Test St"), "property_data", "google-places");
  await expectBlocked(() => gp.resolveAddress("place-1"), "property_data", "google-places");
  assert.equal(await gp.lookupOwnership("place-1"), null, "local method, not guarded");
  allow("property_data:google-places");
  await expectAllowed(() => gp.searchAddress("1 Test St"));
  sawSend("maps.googleapis.com");
  spies.reset(); delete process.env.AEE_RESTORED_ENV_OUTBOUND_ALLOW; off();
  await expectAllowed(() => gp.searchAddress("1 Test St"));
  sawSend("maps.googleapis.com");
});

test("WS4-12 (b): routes/properties.ts builds its provider through the guarded lib factory (one construction line)", () => {
  const src = readFileSync(path.join(repoRoot, "apps/api/src/routes/properties.ts"), "utf8");
  assert.match(src, /^const propertyDataProvider = createGuardedPropertyDataProvider\(\);$/m);
  assert.doesNotMatch(src, /createPropertyDataProvider\(|new GooglePlacesProvider\(/);
});

// ---------- guards ----------
// Any use of the fetch identifier (call, default parameter, injected config.fetch) or a raw transport opener.
const TRANSPORT_RE = /\bfetch\b|\bhttps?\.(request|get)\s*\(|\bnet\.connect\s*\(|\btls\.connect\s*\(|new\s+WebSocket\s*\(|createTransport\s*\(/;
const isCode = (l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l);
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return ["__tests__", "node_modules", "dist", "test"].includes(n) ? [] : walk(p);
    return /\.(ts|mts|js|mjs)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
const rel = (f: string) => path.relative(repoRoot, f).split(path.sep).join("/");
const packageSrcRoots = () => readdirSync(path.join(repoRoot, "packages")).flatMap((p) => {
  const d = path.join(repoRoot, "packages", p);
  return p === "integrations" ? readdirSync(d).map((s) => path.join(d, s, "src")) : [path.join(d, "src")];
});
function sourceFiles(): string[] {
  return [path.join(repoRoot, "apps/api/src"), ...packageSrcRoots()].flatMap((r) => { try { return walk(r); } catch { return []; } });
}
/** The text of an exported/declared symbol up to the next top-level declaration. */
function symbolBody(file: string, symbol: string): string {
  const src = readFileSync(path.join(repoRoot, file), "utf8");
  const start = src.search(new RegExp(`^(export\\s+)?(class|const|let|function)\\s+${symbol}\\b`, "m"));
  assert.ok(start >= 0, `${symbol} not found in ${file}`);
  const rest = src.slice(start + 1);
  const next = rest.search(/^(export\s+)?(class|const|let|function|interface|type)\s+\w+/m);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

test("guard: every file that opens an outbound transport is registered to a guarded channel (or explicitly not guarded, with a reason)", () => {
  const registered = new Set<string>([...Object.values(OUTBOUND_CHANNELS).flatMap((c) => [...c.transports]), ...Object.keys(NOT_GUARDED_TRANSPORTS)]);
  const files = sourceFiles().filter((f) => readFileSync(f, "utf8").split("\n").some((l) => isCode(l) && TRANSPORT_RE.test(l))).map(rel).sort();
  assert.ok(files.includes("packages/integrations/property-data/src/index.ts"), "the detector must see injected fetch (GooglePlacesProvider)");
  assert.deepEqual(Object.keys(NOT_GUARDED_TRANSPORTS), [], "WS4-12: no known-gap transports remain");
  assert.deepEqual(files.filter((f) => !registered.has(f)), [], "register the transport in lib/outboundGuard.ts OUTBOUND_CHANNELS and guard it");
});

test("guard: every channel's guard site (and every apps/api transport) calls the guard with its own channel id", () => {
  for (const [id, ch] of Object.entries(OUTBOUND_CHANNELS)) {
    for (const f of [ch.guard, ...ch.transports.filter((t) => t.startsWith("apps/api/"))]) {
      const src = readFileSync(path.join(repoRoot, f), "utf8");
      const re = id === "object_storage_write" ? /guardStorageWrites\(/ : new RegExp(`(assertOutboundAllowed|outboundBlocked|guardOutboundProvider)\\(\\s*"${id}"`);
      assert.ok(re.test(src), `${f} must guard channel "${id}"`);
    }
  }
});

test("guard: every provider class/object is classified, and its code agrees (in_process = no transport, network = transport)", () => {
  const classified = new Set(PROVIDERS.map((p) => p.symbol));
  const found: string[] = [];
  for (const f of sourceFiles()) {
    const r = rel(f);
    const inScope = r.startsWith("packages/integrations/") || /^apps\/api\/src\/lib\/(ai\/providers|ai\/voice|communications\/providers|auth|telephony)\//.test(r);
    if (!inScope) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/^export\s+(?:class|const)\s+(\w+Provider)\b/gm)) found.push(m[1]!);
  }
  assert.deepEqual(found.filter((s) => !classified.has(s)).sort(), [], "classify every provider in PROVIDERS");
  for (const p of PROVIDERS) {
    const body = symbolBody(p.file, p.symbol).split("\n").filter(isCode).join("\n");
    const opens = TRANSPORT_RE.test(body);
    assert.equal(opens, p.kind === "network", `${p.channel}:${p.provider} (${p.symbol}) is classified ${p.kind} but its code ${opens ? "opens" : "does not open"} a transport`);
  }
});

test("guard: every ObjectStorageProvider method is classified read or write, and writes are what the D-OS proxy wraps", () => {
  const src = readFileSync(path.join(repoRoot, "packages/integrations/object-storage/src/index.ts"), "utf8");
  const iface = /export interface ObjectStorageProvider \{([\s\S]*?)\n\}/.exec(src)![1]!;
  const methods = [...iface.matchAll(/^\s*(\w+)\s*\(/gm)].map((m) => m[1]!).sort();
  assert.deepEqual(methods, [...STORAGE_READ_METHODS, ...STORAGE_WRITE_METHODS].sort(), "classify new storage methods (copy, multipart, presigned PUT/DELETE...) in lib/outboundGuard.ts");
});
