// WS4-07 test driver (run in a child process so registration latches are fresh). Installs spies on every timer and
// outbound transport, runs the API's boot-time register calls in apps/api/src/index.ts order, "advances time" by
// invoking every interval callback that was started, then prints one WS4-07-RESULT JSON line.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";

const srcRoot = fileURLToPath(new URL("../../../", import.meta.url)); // apps/api/src/
const fromSrc = (): string | null => {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(3)) {
    if (line.includes("/node_modules/") || line.includes("restoredEnvBootDriver")) continue;
    const m = line.match(/(\/[^\s()]+\.ts)/);
    if (m && m[1]!.startsWith(srcRoot)) return m[1]!.slice(srcRoot.length);
  }
  return null;
};

const intervals: Array<{ file: string | null; ms: number; fn: () => unknown }> = [];
const srcTimeouts: Array<{ file: string; ms: number }> = [];
const sends: Array<{ via: string; target: string }> = [];
const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
(globalThis as { setInterval: unknown }).setInterval = ((fn: () => unknown, ms?: number, ...rest: unknown[]) => {
  intervals.push({ file: fromSrc(), ms: ms ?? 0, fn });
  const h = (realSetInterval as (...a: unknown[]) => NodeJS.Timeout)(() => undefined, 1 << 30, ...rest); // never fires on its own; we drive ticks below
  h.unref?.();
  return h;
}) as typeof setInterval;
(globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => unknown, ms?: number, ...rest: unknown[]) => {
  const file = fromSrc();
  if (file) srcTimeouts.push({ file, ms: ms ?? 0 });
  return (realSetTimeout as (...a: unknown[]) => NodeJS.Timeout)(fn, ms, ...rest);
}) as typeof setTimeout;
// Outbound transports: fetch, http(s).request/get, and raw sockets except the test database.
const dbUrl = new URL(process.env.DATABASE_URL ?? "postgresql://127.0.0.1:5432/x");
const dbTarget = `${dbUrl.hostname}:${dbUrl.port || "5432"}`;
globalThis.fetch = (async (input: unknown) => {
  sends.push({ via: "fetch", target: String(input instanceof Request ? input.url : input) });
  throw new Error("WS4-07 spy: outbound fetch blocked");
}) as typeof fetch;
for (const [name, mod] of [["http", http], ["https", https]] as const) {
  for (const fn of ["request", "get"] as const) {
    (mod as unknown as Record<string, unknown>)[fn] = (...args: unknown[]) => {
      sends.push({ via: `${name}.${fn}`, target: JSON.stringify(args[0]).slice(0, 200) });
      throw new Error("WS4-07 spy: outbound http blocked");
    };
  }
}
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const opts = (typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: args[1] }) as { host?: string; port?: number | string; path?: string };
  const target = opts.path ? `unix:${opts.path}` : `${opts.host ?? "localhost"}:${opts.port}`;
  const isDb = target === dbTarget || target === `localhost:${dbUrl.port}` || opts.path?.includes(`.s.PGSQL.${dbUrl.port}`);
  if (!isDb) sends.push({ via: "net.connect", target });
  return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

const logLines: Array<Record<string, unknown>> = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
const capture = (chunk: unknown): boolean => {
  for (const raw of String(chunk).split("\n")) {
    if (raw.trim().startsWith("{")) { try { logLines.push(JSON.parse(raw)); } catch { /* not json */ } }
  }
  return true;
};
(process.stdout as { write: unknown }).write = capture;
(process.stderr as { write: unknown }).write = capture;

const { configureEvents } = await import("../../events.js");
const { registerAutomationEngine } = await import("../../automation/bootstrap.js");
const { registerExceptionEngine } = await import("../../exceptions/bootstrap.js");
const { registerSignalSweep } = await import("../../propertyIntelligence/sweepBootstrap.js");
const { registerPitCrewWaitingOnSweep } = await import("../../pitCrew/waitingOnSweepBootstrap.js");
const { registerLaunchEngine } = await import("../../launch/bootstrap.js");
const { registerCommunicationsEngine } = await import("../../communications/bootstrap.js");
const { registerFinancialEngine } = await import("../../financial/bootstrap.js");
const { registerIntegrationsEngine } = await import("../../integrations/bootstrap.js");
const { registerDocumentStorageReconciler } = await import("../../documentStorageReconciler.js");
const { registerCallTranscriptionReconciler } = await import("../../telephony/callTranscriptionReconciler.js");

const errors: string[] = [];
const step = (name: string, fn: () => unknown) => { try { fn(); } catch (e) { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); } };
// Same order as apps/api/src/index.ts. Explicit startScheduler: true where accepted, so the switch must win over it.
step("configureEvents", () => configureEvents());
step("registerAutomationEngine", () => registerAutomationEngine());
step("registerExceptionEngine", () => registerExceptionEngine({ startScheduler: true }));
step("registerSignalSweep", () => registerSignalSweep({ startScheduler: true }));
step("registerPitCrewWaitingOnSweep", () => registerPitCrewWaitingOnSweep({ startScheduler: true }));
step("registerLaunchEngine", () => registerLaunchEngine());
step("registerCommunicationsEngine", () => registerCommunicationsEngine());
step("registerFinancialEngine", () => registerFinancialEngine({ startScheduler: true }));
step("registerIntegrationsEngine", () => registerIntegrationsEngine());
const immediate = process.env.WS4_07_RUN_IMMEDIATELY === "1";
step("registerDocumentStorageReconciler", () => registerDocumentStorageReconciler({ startScheduler: true, runImmediately: immediate }));
step("registerCallTranscriptionReconciler", () => registerCallTranscriptionReconciler({ startScheduler: true, runImmediately: immediate }));

if (process.env.WS4_07_SPY_SELFTEST === "1") {
  // Positive control for the transport spies themselves: each of these must be recorded as a send.
  await fetch("https://spy-selftest.invalid/").catch(() => undefined);
  try { https.request("https://spy-selftest.invalid/"); } catch { /* blocked */ }
  try { http.get("http://spy-selftest.invalid/"); } catch { /* blocked */ }
  const s = new net.Socket(); s.on("error", () => undefined); s.connect(9, "203.0.113.1"); s.destroy();
}
const intervalsStarted = intervals.map((i) => ({ file: i.file, ms: i.ms }));
// "Advance fake time": 3 ticks of every interval that was started (only when asked; the positive control does not
// tick, so it never reaches real providers).
if (process.env.WS4_07_TICK === "1") {
  for (let n = 0; n < 3; n++) for (const i of intervals) { try { await i.fn(); } catch { /* the loop's own catch */ } }
}
await new Promise((r) => realSetTimeout(r, 1500)); // let any async seeding / dispatch attempts settle
(process.stdout as { write: unknown }).write = realOut;
(process.stderr as { write: unknown }).write = realErr;
const summary = logLines.filter((l) => l.message === "restored_environment_background_loops_disabled");
realOut(`WS4-07-RESULT ${JSON.stringify({ intervalsStarted, srcTimeouts, sends, errors, summary })}\n`);
process.exit(0);
