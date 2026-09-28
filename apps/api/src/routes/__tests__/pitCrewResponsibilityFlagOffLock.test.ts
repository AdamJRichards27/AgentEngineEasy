// R-F19 — flag-off lock for every Pit Crew responsibility route.
// The router stack is the source of the route list. A new path containing
// responsibility, hand-back, escalate, or escalation fails until it is
// added to LOCKED_RESPONSIBILITY_ROUTES. While the flag is unset, empty,
// "false", "TRUE", or "1", an authenticated Brokerage Administrator with
// run.access gets 404 and pit_crew_responsibility_events is not touched.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { setDbQueryObserver } from "@aee/db";
import { PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG } from "../../lib/pitCrew/responsibility.js";
import { pitCrewRouter } from "../pitCrew.js";
import { cleanupBrokerages, createBrokerageWithUsers, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const NOT_FOUND = JSON.stringify({ error: "Not found." });
const EVENTS_TABLE = "pit_crew_responsibility_events";
const RESPONSIBILITY_PATH = /responsibility|hand-back|escalate|escalation/;

const LOCKED_RESPONSIBILITY_ROUTES = [
  "GET /pit-crew/responsibility-inbox",
  "GET /pit-crew/responsibility-recipients",
  "POST /pit-crew/items/:sourceType/:sourceRecordId/escalate",
  "POST /pit-crew/items/:sourceType/:sourceRecordId/escalation/acknowledge",
  "POST /pit-crew/items/:sourceType/:sourceRecordId/escalation/resolve",
  "POST /pit-crew/items/:sourceType/:sourceRecordId/escalation/return",
  "POST /pit-crew/items/:sourceType/:sourceRecordId/hand-back",
  "POST /pit-crew/items/:sourceType/:sourceRecordId/hand-back/reclaim",
] as const;

const FLAG_CASES: ReadonlyArray<{ label: string; value: string | undefined }> = [
  { label: "unset", value: undefined },
  { label: "empty", value: "" },
  { label: "false", value: "false" },
  { label: "TRUE", value: "TRUE" },
  { label: "1", value: "1" },
];

type RouteLayer = {
  path?: string;
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
  };
  handle?: { stack?: RouteLayer[] };
};

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function registeredRoutes(stack: readonly RouteLayer[], prefix = ""): string[] {
  const found: string[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const raw = layer.route.path;
      const paths = Array.isArray(raw) ? raw : [raw];
      const methods = Object.entries(layer.route.methods)
        .filter(([method, enabled]) => enabled && !method.startsWith("_"))
        .map(([method]) => method.toUpperCase());
      for (const path of paths) {
        assert.equal(typeof path, "string");
        for (const method of methods) found.push(`${method} ${prefix}${path}`);
      }
      continue;
    }
    const nested = layer.handle?.stack;
    if (nested) {
      const mount = typeof layer.path === "string" && layer.path !== "/" ? layer.path : "";
      found.push(...registeredRoutes(nested, `${prefix}${mount}`));
    }
  }
  return found;
}

function responsibilityRoutesOnPitCrewRouter(): string[] {
  const stack = (pitCrewRouter as unknown as { stack?: RouteLayer[] }).stack;
  assert.ok(stack, "Pit Crew router has no stack to enumerate");
  return registeredRoutes(stack).filter((entry) => RESPONSIBILITY_PATH.test(entry.slice(entry.indexOf(" ") + 1)));
}

test("Pit Crew router responsibility routes are exactly the known eight", () => {
  assert.deepEqual(sorted(responsibilityRoutesOnPitCrewRouter()), sorted(LOCKED_RESPONSIBILITY_ROUTES));
});

function bodyFor(path: string): unknown {
  const base = { propertyId: 1, expectedVersion: 0 };
  if (path.endsWith("/hand-back")) {
    return {
      ...base,
      reasonCategory: "WORK_COMPLETE",
      nextAction: "Review the returned condition evidence and confirm the next step.",
    };
  }
  if (path.endsWith("/escalate")) {
    return {
      ...base,
      reasonCategory: "MISSING_AUTHORITY",
      severity: "ATTENTION",
      note: "Settlement figure is outside Pit Crew authority.",
      nextAction: "Decide whether the brokerage will authorise the next settlement step.",
    };
  }
  if (path.endsWith("/escalation/resolve") || path.endsWith("/escalation/return")) {
    return { ...base, note: "Closed in the flag-off lock." };
  }
  return base;
}

function requestFor(route: (typeof LOCKED_RESPONSIBILITY_ROUTES)[number]): { method: string; path: string; body?: unknown } {
  const space = route.indexOf(" ");
  const method = route.slice(0, space);
  const template = route.slice(space + 1);
  if (template === "/pit-crew/responsibility-inbox") return { method, path: template };
  if (template === "/pit-crew/responsibility-recipients") {
    return { method, path: `${template}?kind=HAND_BACK` };
  }
  const path = template.replace(":sourceType", "EXCEPTION").replace(":sourceRecordId", "rf19-lock");
  return { method, path, body: bodyFor(path) };
}

async function withFlag(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
  if (value === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
  else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = previous;
  }
}

describe("R-F19 responsibility routes stay 404 while the flag is off", { concurrency: false }, () => {
  let server: Server;
  let baseUrl: string;
  let admin: DevLoginResult;
  let brokerageId: number;
  const savedFlag = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];

  before(async () => {
    const { configureEvents } = await import("../../lib/events.js");
    configureEvents();
    const { createApp } = await import("../../app.js");
    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const created = await createBrokerageWithUsers(baseUrl, `R-F19 Flag Off ${Date.now()}`);
    admin = created.admin;
    brokerageId = created.brokerageId;
    assert.equal(admin.user.role, "Brokerage Administrator");
  });

  after(async () => {
    if (savedFlag === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = savedFlag;
    if (brokerageId) await cleanupBrokerages([brokerageId]);
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  for (const flagCase of FLAG_CASES) {
    test(`flag ${flagCase.label}: authenticated caller with role and run.access gets 404 and the events table is untouched`, async () => {
      const statements: string[] = [];
      await withFlag(flagCase.value, async () => {
        const uninstall = setDbQueryObserver((query) => {
          statements.push(query);
        });
        try {
          for (const route of LOCKED_RESPONSIBILITY_ROUTES) {
            const request = requestFor(route);
            const res = await fetch(`${baseUrl}/api${request.path}`, {
              method: request.method,
              headers: {
                cookie: admin.cookie,
                ...(request.body === undefined ? {} : { "content-type": "application/json" }),
              },
              body: request.body === undefined ? undefined : JSON.stringify(request.body),
            });
            const text = await res.text();
            assert.equal(res.status, 404, `${route} ${text}`);
            assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
            assert.equal(text, NOT_FOUND, route);
          }
        } finally {
          uninstall();
        }
      });
      assert.deepEqual(
        statements.filter((query) => query.includes(EVENTS_TABLE)),
        [],
      );
      assert.equal(process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG], savedFlag);
    });
  }
});
