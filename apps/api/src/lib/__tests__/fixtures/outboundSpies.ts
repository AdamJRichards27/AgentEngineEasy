// WS4-09 test helper: process-wide spies on every outbound transport. Loopback traffic (the test's own HTTP server)
// and the test database pass through; anything else is RECORDED and REFUSED, so a test can assert "nothing left the
// process" without any real network call ever being made, even in the switch-off controls.
import http from "node:http";
import https from "node:https";
import net from "node:net";

export interface RecordedSend { via: string; target: string }

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function installOutboundSpies(): { sends: RecordedSend[]; reset(): void } {
  const sends: RecordedSend[] = [];
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://127.0.0.1:5432/x");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
    sends.push({ via: "fetch", target: `${init?.method ?? "GET"} ${url.origin}${url.pathname}` });
    throw new Error("WS4-09 spy: outbound fetch refused");
  }) as typeof fetch;
  for (const [name, mod] of [["http", http], ["https", https]] as const) {
    for (const fn of ["request", "get"] as const) {
      const real = (mod as unknown as Record<string, (...a: unknown[]) => unknown>)[fn]!;
      (mod as unknown as Record<string, unknown>)[fn] = (...args: unknown[]) => {
        const a = args[0];
        const host = typeof a === "string" || a instanceof URL ? new URL(String(a)).hostname : ((a as { hostname?: string; host?: string })?.hostname ?? (a as { host?: string })?.host ?? "localhost");
        if (LOOPBACK.has(host)) return real.apply(mod, args);
        sends.push({ via: `${name}.${fn}`, target: host });
        throw new Error("WS4-09 spy: outbound http refused");
      };
    }
  }
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const o = (typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: args[1] }) as { host?: string; port?: number | string; path?: string };
    const host = o.host ?? "localhost";
    const isLocal = Boolean(o.path) || LOOPBACK.has(host) || (host === db.hostname && String(o.port) === (db.port || "5432"));
    if (!isLocal) {
      sends.push({ via: "net.connect", target: `${host}:${o.port}` });
      throw new Error("WS4-09 spy: outbound socket refused");
    }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  return { sends, reset: () => { sends.length = 0; } };
}
