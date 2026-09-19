// AE GROW Pilot Readiness WP2a (P0-1) — async route/middleware rejections
// reach the global error handler, and the process survives.
//
// Two proof styles:
//   1. In-process HTTP tests against a minimal Express app wired like
//      app.ts (routes → globalErrorHandler), covering async throw, async
//      reject, async middleware, routers created BEFORE installation, and
//      the unchanged synchronous-throw path.
//   2. Child-process tests, because the failure mode is a process EXIT that
//      node:test would otherwise mask: (a) control — without the patch, an
//      async throw really does terminate the process; (b) importing the real
//      app module (app.ts → middlewares/auth.ts) installs the patch, so the
//      same handler returns the generic 500 and the process stays alive.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, "..", "..", "..");
const GENERIC = "An unexpected error occurred. Please try again or contact support if the problem persists.";

// A router created BEFORE the patch is installed must still be covered —
// the patch targets the shared Layer prototype, not individual routers.
const earlyRouter = express.Router();
earlyRouter.get("/early-async", async () => {
  throw new Error("SENSITIVE_EARLY_DETAIL");
});

let server: Server;
let baseUrl: string;

before(async () => {
  const { installAsyncRouteErrorForwarding, isAsyncRouteErrorForwardingInstalled } = await import("../asyncRouteErrors.js");
  installAsyncRouteErrorForwarding(); // idempotent
  assert.equal(isAsyncRouteErrorForwardingInstalled(), true);
  const { globalErrorHandler } = await import("../../middlewares/errorHandler.js");

  const app = express();
  app.use(express.json());
  app.use("/r", earlyRouter);
  app.get("/async-throw", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error("SENSITIVE_ASYNC_DETAIL");
  });
  app.get("/async-reject", () => Promise.reject(new Error("SENSITIVE_REJECT_DETAIL")));
  app.get("/async-reject-undefined", () => Promise.reject(undefined));
  app.get("/sync-throw", () => {
    throw new Error("SENSITIVE_SYNC_DETAIL");
  });
  app.use("/mw", async (_req, _res, _next) => {
    throw new Error("SENSITIVE_MIDDLEWARE_DETAIL");
  });
  app.get("/async-ok", async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    res.status(201).json({ ok: true });
  });
  const nested = express.Router();
  nested.get("/deep", async () => {
    throw new Error("SENSITIVE_NESTED_DETAIL");
  });
  app.use("/nested", nested);
  app.use(globalErrorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function expectGeneric500(pathName: string, secret: RegExp): Promise<void> {
  const res = await fetch(`${baseUrl}${pathName}`);
  assert.equal(res.status, 500, `${pathName} must reach the global error handler`);
  const text = await res.text();
  assert.doesNotMatch(text, secret);
  assert.equal((JSON.parse(text) as { error: string }).error, GENERIC);
}

test("an async handler that throws after an await returns the global error handler's generic 500", async () => {
  await expectGeneric500("/async-throw", /SENSITIVE_ASYNC_DETAIL/);
});

test("a handler returning a rejected promise returns the generic 500", async () => {
  await expectGeneric500("/async-reject", /SENSITIVE_REJECT_DETAIL/);
});

test("a rejection with no reason still produces the generic 500 (not a hang)", async () => {
  await expectGeneric500("/async-reject-undefined", /undefined/);
});

test("an async app-level middleware that throws returns the generic 500", async () => {
  await expectGeneric500("/mw/anything", /SENSITIVE_MIDDLEWARE_DETAIL/);
});

test("a router created before installation and a nested router are both covered", async () => {
  await expectGeneric500("/r/early-async", /SENSITIVE_EARLY_DETAIL/);
  await expectGeneric500("/nested/deep", /SENSITIVE_NESTED_DETAIL/);
});

test("a synchronous throw is still handled exactly as before", async () => {
  await expectGeneric500("/sync-throw", /SENSITIVE_SYNC_DETAIL/);
});

test("a successful async handler is unaffected", async () => {
  const res = await fetch(`${baseUrl}/async-ok`);
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true });
});

test("the server keeps serving after several async failures", async () => {
  for (let i = 0; i < 5; i++) await expectGeneric500("/async-throw", /SENSITIVE/);
  const res = await fetch(`${baseUrl}/async-ok`);
  assert.equal(res.status, 201);
});

function runChild(script: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: API_ROOT,
    env: { ...process.env, NODE_ENV: "test" },
    encoding: "utf8",
    timeout: 60_000,
  });
}

const CHILD_SERVER_SNIPPET = `
const app = express();
app.get("/boom", async () => { throw new Error("SENSITIVE_CHILD_DETAIL"); });
app.use(globalErrorHandler);
const server = app.listen(0, async () => {
  const port = server.address().port;
  let status = 0, body = "";
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/boom", { signal: AbortSignal.timeout(3000) });
    status = res.status; body = await res.text();
  } catch (e) { status = -1; body = String(e); }
  await new Promise((r) => setTimeout(r, 200));
  console.log("RESULT " + JSON.stringify({ status, body }));
  server.close();
  process.exit(0);
});
`;

test("control: WITHOUT the patch, an async route throw terminates the process (the bug being fixed)", () => {
  const child = runChild(`
import express from "express";
const { globalErrorHandler } = await import("./src/middlewares/errorHandler.ts");
${CHILD_SERVER_SNIPPET}
`);
  assert.notEqual(child.status, 0, `expected the unpatched child to crash; stdout=${child.stdout} stderr=${child.stderr.slice(0, 2000)}`);
  assert.doesNotMatch(child.stdout, /RESULT/);
});

test("importing the real app module installs the patch: the async throw returns the generic 500 and the process survives", () => {
  const child = runChild(`
import express from "express";
await import("./src/app.ts");
const { globalErrorHandler } = await import("./src/middlewares/errorHandler.ts");
${CHILD_SERVER_SNIPPET}
`);
  assert.equal(child.status, 0, `child exited ${child.status}; stderr=${child.stderr.slice(0, 2000)}`);
  const line = child.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `no RESULT line; stdout=${child.stdout}`);
  const result = JSON.parse(line.slice("RESULT ".length)) as { status: number; body: string };
  assert.equal(result.status, 500);
  assert.doesNotMatch(result.body, /SENSITIVE_CHILD_DETAIL/);
  assert.equal((JSON.parse(result.body) as { error: string }).error, GENERIC);
});
