// R-F17 — GET /pit-crew/responsibility-recipients.
// Flag off is 404. The role gate is the same canAccess list as hand-back
// and escalate (Pit Crew and Brokerage Administrator). Results are active
// users in the caller's brokerage, filtered by the role that kind accepts.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  entitlementGrants,
  pitCrewResponsibilityEvents,
  users,
} from "@aee/db";
import {
  createOrUpdateException,
  newCorrelationId,
} from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import { PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG } from "../../lib/pitCrew/responsibility.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import {
  cleanupBrokerages,
  createBrokerageWithUsers,
  devLogin,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const NOT_FOUND = JSON.stringify({ error: "Not found." });
const FORBIDDEN = JSON.stringify({ error: "Forbidden" });

describe(
  "GET /pit-crew/responsibility-recipients",
  { concurrency: false },
  () => {
    let server: Server;
    let baseUrl: string;
    let admin: DevLoginResult;
    let agent: DevLoginResult;
    let pitCrew: DevLoginResult;
    let amy: DevLoginResult;
    let zoe: DevLoginResult;
    let inactive: DevLoginResult;
    let localPart: DevLoginResult;
    let blankLocal: DevLoginResult;
    let foreignAgent: DevLoginResult;
    let brokerageId: number;
    let otherBrokerageId: number;
    let propertyId: number;
    let savedFlag: string | undefined;
    let fixtureCounter = 0;

    function headers(cookie: string): Record<string, string> {
      return { cookie, "content-type": "application/json" };
    }

    async function postRaw(path: string, cookie: string, body: unknown) {
      return fetch(`${baseUrl}/api${path}`, {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify(body),
      });
    }

    async function getRecipients(
      kind: string,
      cookie?: string,
    ): Promise<Response> {
      return fetch(
        `${baseUrl}/api/pit-crew/responsibility-recipients?kind=${encodeURIComponent(kind)}`,
        {
          headers: cookie ? { cookie } : {},
        },
      );
    }

    async function setRunAccess(active: boolean): Promise<void> {
      await db
        .update(entitlementGrants)
        .set({ status: active ? "Active" : "Revoked" })
        .where(
          and(
            eq(entitlementGrants.brokerageId, brokerageId),
            eq(entitlementGrants.entitlementKey, "run.access"),
          ),
        );
      invalidateEntitlementCache(brokerageId);
    }

    before(async () => {
      savedFlag = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
      process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
      const { configureEvents } = await import("../../lib/events.js");
      configureEvents();
      const { createApp } = await import("../../app.js");
      const app = createApp();
      server = app.listen(0);
      await new Promise<void>((resolve) =>
        server.once("listening", () => resolve()),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("unexpected server address");
      baseUrl = `http://127.0.0.1:${address.port}`;

      const created = await createBrokerageWithUsers(
        baseUrl,
        `R-F17 Recipients ${Date.now()}`,
      );
      admin = created.admin;
      agent = created.agent;
      brokerageId = created.brokerageId;
      const brokerageName = admin.user.brokerageName!;

      pitCrew = await devLogin(baseUrl, {
        email: `pitcrew-rf17-${brokerageId}@example.com`,
        firstName: "Pit",
        lastName: "Crew",
        brokerageName,
      });
      await db
        .update(users)
        .set({ role: "Pit Crew" })
        .where(eq(users.id, pitCrew.user.id));

      amy = await devLogin(baseUrl, {
        email: `amy-rf17-${brokerageId}@example.com`,
        firstName: "Amy",
        lastName: "Aardvark",
        brokerageName,
      });
      zoe = await devLogin(baseUrl, {
        email: `zoe-rf17-${brokerageId}@example.com`,
        firstName: "Zoe",
        lastName: "Zebra",
        brokerageName,
      });
      inactive = await devLogin(baseUrl, {
        email: `inactive-rf17-${brokerageId}@example.com`,
        firstName: "Inactive",
        lastName: "Agent",
        brokerageName,
      });
      await db
        .update(users)
        .set({ isActive: false })
        .where(eq(users.id, inactive.user.id));

      localPart = await devLogin(baseUrl, {
        email: `localpart-rf17-${brokerageId}@example.com`,
        firstName: "Temp",
        lastName: "Name",
        brokerageName,
      });
      await db
        .update(users)
        .set({ firstName: "  ", lastName: "" })
        .where(eq(users.id, localPart.user.id));

      blankLocal = await devLogin(baseUrl, {
        email: `blank-rf17-${brokerageId}@example.com`,
        firstName: "Temp",
        lastName: "Blank",
        brokerageName,
      });
      await db
        .update(users)
        .set({
          firstName: "",
          lastName: "",
          email: `@rf17-${brokerageId}.example`,
        })
        .where(eq(users.id, blankLocal.user.id));

      const other = await createBrokerageWithUsers(
        baseUrl,
        `R-F17 Recipients Other ${Date.now()}`,
      );
      otherBrokerageId = other.brokerageId;
      foreignAgent = await devLogin(baseUrl, {
        email: `foreign-rf17-${otherBrokerageId}@example.com`,
        firstName: "Foreignonly",
        lastName: "Outsider",
        brokerageName: other.admin.user.brokerageName!,
      });

      const propertyRes = await postRaw("/properties", agent.cookie, {
        formattedAddress: "1 Recipient Picker St",
        state: "NSW",
        suburb: "Testville",
        postcode: "2000",
      });
      assert.equal(propertyRes.status, 201, await propertyRes.clone().text());
      propertyId = ((await propertyRes.json()) as { property: { id: number } })
        .property.id;
    });

    after(async () => {
      if (savedFlag === undefined)
        delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
      else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = savedFlag;
      await cleanupBrokerages([brokerageId, otherBrokerageId]);
      if (server) {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    });

    test("flag off returns 404", async () => {
      try {
        delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
        const missing = await getRecipients("HAND_BACK");
        assert.equal(missing.status, 404);
        assert.equal(await missing.text(), NOT_FOUND);

        const authed = await getRecipients("ESCALATE", pitCrew.cookie);
        assert.equal(authed.status, 404);
        assert.equal(await authed.text(), NOT_FOUND);

        process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "TRUE";
        const stillOff = await getRecipients("HAND_BACK", admin.cookie);
        assert.equal(stillOff.status, 404);
        assert.equal(await stillOff.text(), NOT_FOUND);
      } finally {
        process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
      }
    });

    test("an agent is 403, an anonymous caller is 401, and a missing entitlement is refused", async () => {
      const agentRes = await getRecipients("HAND_BACK", agent.cookie);
      assert.equal(agentRes.status, 403);
      assert.equal(await agentRes.text(), FORBIDDEN);

      const anon = await getRecipients("ESCALATE");
      assert.equal(anon.status, 401);

      const invalid = await getRecipients("ESCALATION", pitCrew.cookie);
      assert.equal(invalid.status, 400);
      assert.equal(
        await invalid.text(),
        JSON.stringify({ error: "Invalid request." }),
      );

      await setRunAccess(false);
      try {
        const res = await getRecipients("HAND_BACK", pitCrew.cookie);
        assert.equal(res.status, 403);
        const body = (await res.json()) as {
          error?: string;
          entitlementKey?: string;
        };
        assert.equal(body.error, "Not entitled");
        assert.equal(body.entitlementKey, "run.access");
      } finally {
        await setRunAccess(true);
      }
    });

    test("each kind lists active in-brokerage users of the resolver role, ordered by display name", async () => {
      const handBackRes = await getRecipients("HAND_BACK", pitCrew.cookie);
      assert.equal(handBackRes.status, 200);
      const handBack = (await handBackRes.json()) as {
        recipients: Array<{
          userId: number;
          displayName: string;
          role: string;
        }>;
      };
      const handBackIds = handBack.recipients.map((row) => row.userId);
      assert.equal(
        handBack.recipients.every((row) => row.role === "Agent"),
        true,
      );
      assert.ok(handBackIds.includes(agent.user.id));
      assert.ok(handBackIds.includes(amy.user.id));
      assert.ok(handBackIds.includes(zoe.user.id));
      assert.ok(handBackIds.includes(localPart.user.id));
      assert.ok(handBackIds.includes(blankLocal.user.id));
      assert.equal(handBackIds.includes(admin.user.id), false);
      assert.equal(handBackIds.includes(pitCrew.user.id), false);
      assert.equal(handBackIds.includes(inactive.user.id), false);
      assert.equal(handBackIds.includes(foreignAgent.user.id), false);

      const byId = new Map(handBack.recipients.map((row) => [row.userId, row]));
      assert.equal(byId.get(amy.user.id)?.displayName, "Amy Aardvark");
      assert.equal(byId.get(zoe.user.id)?.displayName, "Zoe Zebra");
      assert.equal(byId.get(agent.user.id)?.displayName, "Agent User");
      assert.equal(
        byId.get(localPart.user.id)?.displayName,
        `localpart-rf17-${brokerageId}`,
      );
      assert.equal(
        byId.get(blankLocal.user.id)?.displayName,
        `User ${blankLocal.user.id}`,
      );
      assert.deepEqual(
        handBack.recipients.map((row) => row.displayName),
        [...handBack.recipients.map((row) => row.displayName)].sort((a, b) =>
          a.localeCompare(b, "en", { sensitivity: "base" }),
        ),
      );
      const amyIndex = handBack.recipients.findIndex(
        (row) => row.userId === amy.user.id,
      );
      const zoeIndex = handBack.recipients.findIndex(
        (row) => row.userId === zoe.user.id,
      );
      assert.ok(amyIndex >= 0 && amyIndex < zoeIndex);
      for (const row of handBack.recipients) {
        assert.deepEqual(Object.keys(row).sort(), [
          "displayName",
          "role",
          "userId",
        ]);
      }
      const serialised = JSON.stringify(handBack);
      assert.equal(serialised.includes("@"), false);
      assert.equal(serialised.includes("Foreignonly"), false);
      assert.equal(serialised.includes("Inactive"), false);

      const escalateRes = await getRecipients("ESCALATE", admin.cookie);
      assert.equal(escalateRes.status, 200);
      const escalate = (await escalateRes.json()) as {
        recipients: Array<{
          userId: number;
          displayName: string;
          role: string;
        }>;
      };
      const escalateIds = escalate.recipients.map((row) => row.userId);
      assert.deepEqual(escalateIds, [admin.user.id]);
      assert.equal(escalate.recipients[0]?.displayName, "Admin User");
      assert.equal(escalate.recipients[0]?.role, "Brokerage Administrator");
      assert.equal(escalateIds.includes(agent.user.id), false);
      assert.equal(escalateIds.includes(foreignAgent.user.id), false);
    });

    test("a handed-back card names the recipient in this brokerage and not a user outside it", async () => {
      fixtureCounter += 1;
      const finding: RiskFinding = {
        ruleId: "TEST_RF17_RECIPIENT_RULE",
        ruleVersion: 1,
        category: "WORKFLOW_OPERATIONAL",
        severity: "ATTENTION",
        title: `R-F17 recipient finding ${fixtureCounter}`,
        problemDescription: "A test problem.",
        businessImpact: "Test impact.",
        detectedCause: "Test cause.",
        ownerType: "PIT_CREW",
        ownerUserId: null,
        propertyId,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Do the test thing.",
        resolutionRequirements: "The test condition clears.",
        dismissible: true,
        sourceRecordType: "property",
        sourceRecordId: String(propertyId),
        dedupKey: `TEST_RF17_RECIPIENT_RULE:${brokerageId}:RECIPIENT_${fixtureCounter}`,
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      };
      const created = await createOrUpdateException(
        finding,
        brokerageId,
        propertyId,
        null,
        newCorrelationId(),
        null,
      );
      const sourceRecordId = created.exception.id;
      const claim = await postRaw(
        `/pit-crew/items/EXCEPTION/${sourceRecordId}/claim`,
        pitCrew.cookie,
        {
          propertyId,
          expectedVersion: 0,
        },
      );
      assert.equal(claim.status, 200, await claim.clone().text());
      const version = ((await claim.json()) as { version: number }).version;
      const handed = await postRaw(
        `/pit-crew/items/EXCEPTION/${sourceRecordId}/hand-back`,
        pitCrew.cookie,
        {
          propertyId,
          expectedVersion: version,
          reasonCategory: "WORK_COMPLETE",
          nextAction: "Review the returned evidence.",
          recipientUserId: agent.user.id,
        },
      );
      assert.equal(handed.status, 200, await handed.clone().text());
      const eventId = (
        (await handed.json()) as { responsibilityEvent: { id: number } }
      ).responsibilityEvent.id;

      const workspaceRes = await fetch(`${baseUrl}/api/pit-crew/workspace`, {
        headers: { cookie: pitCrew.cookie },
      });
      assert.equal(workspaceRes.status, 200, await workspaceRes.clone().text());
      const workspace = (await workspaceRes.json()) as {
        handedBack: Array<{
          sourceRecordId: string;
          responsibility: {
            recipientDisplayName: string | null;
            operatorDisplayName: string;
            recipientUserId: number | null;
          };
        }>;
      };
      const item = workspace.handedBack.find(
        (row) => row.sourceRecordId === sourceRecordId,
      );
      assert.ok(item);
      assert.equal(item.responsibility.recipientDisplayName, "Agent User");
      assert.equal(item.responsibility.operatorDisplayName, "Pit Crew");
      assert.equal(
        JSON.stringify(item).includes(agent.user.email ?? "missing-email"),
        false,
      );

      await db
        .update(pitCrewResponsibilityEvents)
        .set({ recipientUserId: foreignAgent.user.id })
        .where(eq(pitCrewResponsibilityEvents.id, eventId));
      const leakedRes = await fetch(`${baseUrl}/api/pit-crew/workspace`, {
        headers: { cookie: pitCrew.cookie },
      });
      assert.equal(leakedRes.status, 200);
      const leaked = (await leakedRes.json()) as typeof workspace;
      const leakedItem = leaked.handedBack.find(
        (row) => row.sourceRecordId === sourceRecordId,
      );
      assert.ok(leakedItem);
      assert.equal(
        leakedItem.responsibility.recipientUserId,
        foreignAgent.user.id,
      );
      assert.equal(
        leakedItem.responsibility.recipientDisplayName,
        `User ${foreignAgent.user.id}`,
      );
      assert.equal(JSON.stringify(leakedItem).includes("Foreignonly"), false);
      assert.equal(JSON.stringify(leakedItem).includes("@"), false);
    });
  },
);
