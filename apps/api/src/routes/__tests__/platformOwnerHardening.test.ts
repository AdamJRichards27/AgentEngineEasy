import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@aee/db";
import { checkReadiness } from "../health.js";
// Operator script is plain JavaScript. The assertions below fix the result shape.
// @ts-expect-error no declaration file for the preflight script
import { platformOwnerPreflightDecision } from "../../../../../packages/db/scripts/preflight-migrations.mjs";
import {
  databaseTargetLabel,
  platformOwnerBootstrapBlockReason,
} from "../../scripts/bootstrapPlatformOwners.js";
import {
  isOwnerCrossBrokerageWriteAllowed,
  lookupPlatformOwner,
  platformOwnerAuditSurface,
  postgresErrorCode,
  requestPathname,
} from "../../lib/platformOwner.js";
import type { Request } from "express";

const WHEN_0035 = 1791244800000;
const entry = { tag: "0035_platform_owner_access", when: WHEN_0035 };

describe("platform owner preflight decision", () => {
  test("skips when the journal has no 0035 entry", () => {
    const decision = platformOwnerPreflightDecision({
      journalEntry: null,
      maxCreatedAt: WHEN_0035,
      platformOwnersExists: false,
      platformOwnerAuditExists: false,
    });
    assert.equal(decision.outcome, "skip");
  });

  test("skips a database that has not been migrated yet", () => {
    const decision = platformOwnerPreflightDecision({
      journalEntry: entry,
      maxCreatedAt: null,
      platformOwnersExists: false,
      platformOwnerAuditExists: false,
    });
    assert.equal(decision.outcome, "skip");
    assert.match(decision.message, /platform_owners/);
  });

  test("skips when 0035 is still ahead of applied history", () => {
    const decision = platformOwnerPreflightDecision({
      journalEntry: entry,
      maxCreatedAt: WHEN_0035 - 1,
      platformOwnersExists: false,
      platformOwnerAuditExists: false,
    });
    assert.equal(decision.outcome, "skip");
  });

  test("fails when the journal has 0035, applied history is past its when, and a table is missing", () => {
    const both = platformOwnerPreflightDecision({
      journalEntry: entry,
      maxCreatedAt: 1791330872933,
      platformOwnersExists: false,
      platformOwnerAuditExists: false,
    });
    assert.equal(both.outcome, "fail");
    assert.match(both.message, /platform_owners and platform_owner_audit/);
    assert.match(both.message, /1791244800000/);
    assert.match(both.message, /silently skip 0035/);
    const auditOnly = platformOwnerPreflightDecision({
      journalEntry: entry,
      maxCreatedAt: WHEN_0035,
      platformOwnersExists: true,
      platformOwnerAuditExists: false,
    });
    assert.equal(auditOnly.outcome, "fail");
    assert.match(auditOnly.message, /platform_owner_audit/);
    assert.doesNotMatch(auditOnly.message, /platform_owners and/);
  });

  test("passes when both platform owner tables exist", () => {
    const decision = platformOwnerPreflightDecision({
      journalEntry: entry,
      maxCreatedAt: 1791330872933,
      platformOwnersExists: true,
      platformOwnerAuditExists: true,
    });
    assert.equal(decision.outcome, "ok");
  });
});

describe("platform owner bootstrap guard", () => {
  const argv = ["node", "bootstrapPlatformOwners.ts", "--confirm-platform-owner-bootstrap"];

  test("refuses without the explicit allow flag", () => {
    const reason = platformOwnerBootstrapBlockReason({ NODE_ENV: "development" }, argv);
    assert.match(reason ?? "", /PLATFORM_OWNER_BOOTSTRAP_ALLOWED/);
    assert.match(reason ?? "", /Refusing platform owner bootstrap/);
  });

  test("refuses production even when the allow flag is set", () => {
    const reason = platformOwnerBootstrapBlockReason({
      NODE_ENV: "production",
      PLATFORM_OWNER_BOOTSTRAP_ALLOWED: "true",
    }, argv);
    assert.match(reason ?? "", /NODE_ENV is production/);
  });

  test("refuses a deployment environment even when NODE_ENV is not production", () => {
    const reason = platformOwnerBootstrapBlockReason({
      NODE_ENV: "development",
      PLATFORM_OWNER_BOOTSTRAP_ALLOWED: "true",
      REPLIT_DEPLOYMENT: "1",
    }, argv);
    assert.match(reason ?? "", /REPLIT_DEPLOYMENT/);
    assert.match(reason ?? "", /NODE_ENV alone does not identify/);
  });

  test("allows an explicit non-production, non-deployment opt-in and labels the database without secrets", () => {
    const reason = platformOwnerBootstrapBlockReason({
      NODE_ENV: "development",
      PLATFORM_OWNER_BOOTSTRAP_ALLOWED: "true",
    }, argv);
    assert.equal(reason, null);
    const label = databaseTargetLabel("postgresql://aee_ci:super-secret@db.example:5432/aee_ci");
    assert.match(label, /host=db\.example/);
    assert.match(label, /database=aee_ci/);
    assert.doesNotMatch(label, /super-secret/);
  });
});

describe("platform owner audit surface", () => {
  test("classifies owner-console actions from the original URL, not the router-relative path", () => {
    const routed = { originalUrl: "/api/owner/context", path: "/context", baseUrl: "/api/owner" } as Request;
    assert.equal(platformOwnerAuditSurface(routed), "owner");
    const relativeOnly = { originalUrl: "", url: "", path: "/context", baseUrl: "/api/owner" } as Request;
    assert.equal(platformOwnerAuditSurface(relativeOnly), "other");
    const auth = { originalUrl: "/api/auth/admin/invitations?page=1", path: "/api/auth/admin/invitations" } as Request;
    assert.equal(platformOwnerAuditSurface(auth), "auth");
  });
});

test("readiness reports missing platform owner tables as degraded and still answers", async () => {
  const original = db.execute.bind(db) as (query: unknown) => Promise<unknown>;
  (db as { execute: typeof db.execute }).execute = (async (query: unknown) => {
    const text = String(query);
    let sqlText = text;
    try {
      sqlText = (db as unknown as { dialect: { sqlToQuery: (q: unknown) => { sql: string } } }).dialect.sqlToQuery(query).sql;
    } catch {
      sqlText = text;
    }
    if (sqlText.includes("to_regclass('public.platform_owners')")) {
      return { rows: [{ platform_owners: null, platform_owner_audit: null }] };
    }
    return original(query);
  }) as typeof db.execute;
  try {
    const result = await checkReadiness();
    assert.equal(result.status, "degraded", JSON.stringify(result));
    assert.ok(result.reasons.some((reason) => reason === "platform owner tables missing: platform_owners, platform_owner_audit"));
    assert.notEqual(result.status, "unavailable");
  } finally {
    (db as { execute: typeof db.execute }).execute = original as typeof db.execute;
  }
});

describe("platform owner request path normalisation (F2 allow-list)", () => {
  const req = (originalUrl: string) => ({ originalUrl }) as Request;

  test("matches Express routing: case, repeated slashes, trailing slash, query, absolute form", () => {
    assert.equal(requestPathname(req("/api/auth/Admin/users/7/disable")), "/api/auth/admin/users/7/disable");
    assert.equal(requestPathname(req("/api/auth//admin/users/7/disable")), "/api/auth/admin/users/7/disable");
    assert.equal(requestPathname(req("/API/OWNER/context/")), "/api/owner/context");
    assert.equal(requestPathname(req("/api/payments/refund?x=1")), "/api/payments/refund");
    assert.equal(requestPathname(req("http://evil.example/api/auth/admin/invitations")), "/api/auth/admin/invitations");
    assert.equal(requestPathname(req("")), "/");
  });

  test("the cross-brokerage write allow-list accepts only the five user and invitation admin routes", () => {
    for (const allowed of [
      "/api/auth/admin/users/12/disable",
      "/api/auth/admin/users/12/enable",
      "/api/auth/admin/invitations",
      "/api/auth/admin/invitations/12/revoke",
      "/api/auth/admin/succession",
    ]) {
      assert.equal(isOwnerCrossBrokerageWriteAllowed(allowed), true, allowed);
    }
    for (const denied of [
      "/api/auth/admin/users/12/disable/extra",
      "/api/auth/admin/users/abc/disable",
      "/api/auth/admin/users/12/role",
      "/api/auth/admin/invitations/12",
      "/api/auth/admin",
      "/api/payments/refund",
      "/api/admin/privacy-requests/1/resolve",
      "/prefix/api/auth/admin/invitations",
    ]) {
      assert.equal(isOwnerCrossBrokerageWriteAllowed(denied), false, denied);
    }
  });
});

describe("platform owner lookup maps database errors (F1a)", () => {
  type Selectable = { select: (...args: unknown[]) => unknown };

  async function withSelectError(err: unknown, run: () => Promise<void>): Promise<void> {
    const target = db as unknown as Selectable;
    const original = target.select;
    target.select = () => ({
      from: () => ({ where: async () => { throw err; } }),
    });
    try {
      await run();
    } finally {
      target.select = original;
    }
  }

  test("reads the SQLSTATE through a wrapped cause chain", () => {
    assert.equal(postgresErrorCode({ code: "42P01" }), "42P01");
    assert.equal(postgresErrorCode(new Error("query failed", { cause: { code: "42P01" } })), "42P01");
    assert.equal(postgresErrorCode(new Error("no code")), undefined);
  });

  test("a real 42P01 from the platform_owners query means nobody is an owner", async () => {
    const wrapped = new Error("Failed query", {
      cause: Object.assign(new Error('relation "platform_owners" does not exist'), { code: "42P01" }),
    });
    await withSelectError(wrapped, async () => {
      assert.equal(await lookupPlatformOwner(1), "missing");
    });
  });

  test("any other lookup failure is an error, not a silent non-owner", async () => {
    await withSelectError(Object.assign(new Error("connection terminated"), { code: "57P01" }), async () => {
      assert.equal(await lookupPlatformOwner(1), "error");
    });
  });
});
