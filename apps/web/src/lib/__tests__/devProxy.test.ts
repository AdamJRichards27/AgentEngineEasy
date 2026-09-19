import assert from "node:assert/strict";
import test from "node:test";
import { API_PROXY_TARGET_ENV_VARS, DEFAULT_API_PROXY_TARGET, resolveApiProxyTarget } from "../devProxy";

// AE GROW Pilot Readiness WP8 — D-web-3: the Vite dev server's /api proxy
// target comes from the environment, so a QA web server can be pointed at a
// second API instance without editing vite.config.ts.

test("with nothing set, the dev proxy keeps its existing target", () => {
  assert.equal(resolveApiProxyTarget({}), DEFAULT_API_PROXY_TARGET);
  assert.equal(resolveApiProxyTarget(), DEFAULT_API_PROXY_TARGET);
  assert.equal(DEFAULT_API_PROXY_TARGET, "http://localhost:8080");
});

test("either env var points the proxy at another API instance", () => {
  assert.equal(resolveApiProxyTarget({ VITE_API_PROXY_TARGET: "http://localhost:8081" }), "http://localhost:8081");
  assert.equal(resolveApiProxyTarget({ API_PROXY_TARGET: "http://127.0.0.1:9090" }), "http://127.0.0.1:9090");
  assert.equal(resolveApiProxyTarget({ API_PROXY_TARGET: "https://qa-api.internal" }), "https://qa-api.internal");
});

test("VITE_API_PROXY_TARGET wins when both are set", () => {
  assert.deepEqual([...API_PROXY_TARGET_ENV_VARS], ["VITE_API_PROXY_TARGET", "API_PROXY_TARGET"]);
  assert.equal(
    resolveApiProxyTarget({ VITE_API_PROXY_TARGET: "http://localhost:8081", API_PROXY_TARGET: "http://localhost:9999" }),
    "http://localhost:8081",
  );
});

test("blank or whitespace-only values are treated as unset, not as an error", () => {
  assert.equal(resolveApiProxyTarget({ VITE_API_PROXY_TARGET: "" }), DEFAULT_API_PROXY_TARGET);
  assert.equal(resolveApiProxyTarget({ VITE_API_PROXY_TARGET: "   " }), DEFAULT_API_PROXY_TARGET);
  assert.equal(
    resolveApiProxyTarget({ VITE_API_PROXY_TARGET: "  ", API_PROXY_TARGET: "http://localhost:8081" }),
    "http://localhost:8081",
    "an empty .env entry must not shadow the one that is actually set",
  );
  assert.equal(resolveApiProxyTarget({ VITE_API_PROXY_TARGET: "  http://localhost:8081  " }), "http://localhost:8081");
});

test("a trailing slash is dropped so /api/x is not proxied to //api/x", () => {
  assert.equal(resolveApiProxyTarget({ API_PROXY_TARGET: "http://localhost:8081/" }), "http://localhost:8081");
  assert.equal(resolveApiProxyTarget({ API_PROXY_TARGET: "http://localhost:8081///" }), "http://localhost:8081");
});

test("a malformed target stops the dev server instead of silently using the default", () => {
  // Silently proxying to the wrong API is exactly the failure this fix exists
  // to remove — a typo must be loud.
  for (const value of ["localhost:8081", "8081", "ws://localhost:8081", "http://", "http:// localhost:8081"]) {
    assert.throws(
      () => resolveApiProxyTarget({ API_PROXY_TARGET: value }),
      /API_PROXY_TARGET must be an http\(s\) URL/,
      value,
    );
  }
});
