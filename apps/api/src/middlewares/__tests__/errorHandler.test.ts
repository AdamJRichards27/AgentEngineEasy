// Agent Engine 2.0 — Step 2: Security & Observability Hardening (Part C —
// typed-error-handling audit).
//
// Proves globalErrorHandler (middlewares/errorHandler.ts) closes the gap
// this audit found: this application previously had NO global Express
// error-handling middleware, meaning Express's own default handler —
// which, whenever NODE_ENV isn't the literal string "production" (exactly
// how this repo's own `.replit` "Dev" workflow / `tsx watch` runs today),
// returns an uncaught error's message AND full stack trace directly in the
// HTTP response body — was the only thing standing between an unrecognised
// route-level throw and a real information-disclosure leak. Two proof
// styles: direct unit calls against the handler function itself (fast,
// precise control over the mock error/response), and one real end-to-end
// HTTP test against a minimal standalone Express app wired exactly like
// app.ts, proving the actual wiring (not just the function in isolation)
// produces a safe response for a real thrown error over a real request.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { globalErrorHandler } from "../errorHandler.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";

function mockReq(overrides?: Partial<{ method: string; path: string }>) {
  return { method: overrides?.method ?? "GET", path: overrides?.path ?? "/api/test" } as Parameters<typeof globalErrorHandler>[1];
}

function mockRes() {
  const res: { statusCode: number; body: unknown; headersSent: boolean; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

test("globalErrorHandler returns a generic 500 with no error message/stack in the response body, for an arbitrary unrecognised error", () => {
  const err = new Error("SENSITIVE_INTERNAL_DETAIL_a1b2c3 — connection string, table name, whatever this error object happened to carry");
  const req = mockReq();
  const res = mockRes();
  let nextCalled = false;

  globalErrorHandler(err, req, res as never, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 500);
  const bodyText = JSON.stringify(res.body);
  assert.doesNotMatch(bodyText, /SENSITIVE_INTERNAL_DETAIL_a1b2c3/, "the client-facing response must never include the underlying error's own message");
  assert.doesNotMatch(bodyText, /at Object\.<anonymous>|\.ts:\d+:\d+/, "the client-facing response must never include a stack trace");
  assert.equal((res.body as { error: string }).error, "An unexpected error occurred. Please try again or contact support if the problem persists.");
});

test("globalErrorHandler delegates to next(err) instead of responding, once headers are already sent", () => {
  const err = new Error("too late");
  const req = mockReq();
  const res = mockRes();
  res.headersSent = true;
  let nextCalledWith: unknown;

  globalErrorHandler(err, req, res as never, (e) => {
    nextCalledWith = e;
  });

  assert.equal(nextCalledWith, err);
  assert.equal(res.statusCode, 200, "must not have attempted its own response once headers were already sent");
});

test("globalErrorHandler maps a body-parser 'entity too large' error to a safe 413, distinct from the generic 500 case", () => {
  const err = Object.assign(new Error("request entity too large"), { type: "entity.too.large", status: 413 });
  const req = mockReq({ method: "POST" });
  const res = mockRes();

  globalErrorHandler(err, req, res as never, () => {
    throw new Error("must not call next() for a handled error");
  });

  assert.equal(res.statusCode, 413);
  assert.equal((res.body as { error: string }).error, "Request body is too large.");
});

test("globalErrorHandler maps a body-parser JSON-parse-failure error to a safe 400, distinct from the generic 500 case", () => {
  const err = Object.assign(new SyntaxError("Unexpected token < in JSON at position 0"), { type: "entity.parse.failed", status: 400 });
  const req = mockReq({ method: "POST" });
  const res = mockRes();

  globalErrorHandler(err, req, res as never, () => {
    throw new Error("must not call next() for a handled error");
  });

  assert.equal(res.statusCode, 400);
  assert.equal((res.body as { error: string }).error, "Malformed request body.");
  assert.doesNotMatch(JSON.stringify(res.body), /Unexpected token/, "the raw SyntaxError message must never reach the client");
});

// --- End-to-end: a minimal standalone app wired the same way app.ts wires
// globalErrorHandler (mounted last), proving the real Express plumbing —
// not just the function called directly — produces the same safe shape.

let server: Server;
let baseUrl: string;

test("end-to-end: a synchronous throw inside a real route, over a real HTTP request, produces a safe generic 500 (not Express's own default error page, which would include the stack trace)", async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.get("/boom", () => {
    throw new Error("SENSITIVE_E2E_MARKER_x9y8z7 — must never reach the client");
  });
  app.use(globalErrorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const res = await fetch(`${baseUrl}/boom`);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /SENSITIVE_E2E_MARKER_x9y8z7/, "a real thrown error's message must never reach the HTTP response body");
  assert.doesNotMatch(text, /at file:|\.ts:\d+:\d+|node_modules/, "a real thrown error's stack trace must never reach the HTTP response body");
  const body = JSON.parse(text) as { error: string };
  assert.equal(body.error, "An unexpected error occurred. Please try again or contact support if the problem persists.");

  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("end-to-end: an oversized JSON body over a real HTTP request is rejected with a safe 413, not a hang and not a stack trace", async () => {
  const app = express();
  app.use(express.json({ limit: "10b" }));
  app.post("/echo", (req, res) => res.json({ received: req.body }));
  app.use(globalErrorHandler);

  const s = app.listen(0);
  await new Promise<void>((resolve) => s.once("listening", () => resolve()));
  const address = s.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  const url = `http://127.0.0.1:${address.port}`;

  const res = await fetch(`${url}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ this: "payload is well over ten bytes long" }),
  });
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Request body is too large.");

  await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
});
