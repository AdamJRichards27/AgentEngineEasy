// GP-3 / D3 — POST /grow/activities validation and FU-1 visibility, and
// Grow Today plus relationship recency. A reschedule or a note does not
// reset last contact. A logged call does. Logging a call writes an activity
// row and does not place a call.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, growActivities } from "@aee/db";
import {
  ACTIVITY_DURATION_INVALID,
  ACTIVITY_FIELDS_REQUIRED,
  ACTIVITY_TYPE_NOT_ALLOWED,
  ACTIVITY_TYPE_NOT_MANUAL,
  CALL_SUMMARY_REVIEW_ONLY,
  CONTACT_REFERENCE_INVALID,
  OCCURRED_AT_INVALID,
  OCCURRED_AT_OUT_OF_RANGE,
} from "@aee/domain";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();

const KEYS = [
  "grow.access",
  "grow.contacts.read",
  "grow.contacts.manage",
  "grow.relationships.manage",
  "grow.properties.link",
  "grow.activities.manage",
  "grow.opportunities.manage",
] as const;

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
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

async function grant(brokerageId: number) {
  for (const entitlementKey of KEYS) {
    await db.insert(entitlementGrants).values({
      brokerageId,
      entitlementKey,
      granteeType: "brokerage",
      granteeId: brokerageId,
      sourceType: "manual",
      status: "Active",
    });
  }
  invalidateEntitlementCache(brokerageId);
}

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function send(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: headers(cookie, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await send("POST", "/properties", cookie, {
    formattedAddress: address,
    state: "QLD",
    suburb: "Paddington",
    postcode: "4064",
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function createContact(cookie: string, name: string): Promise<number> {
  const res = await send("POST", "/grow/contacts", cookie, {
    firstName: name,
    lastName: `GP3${suffix}`,
    email: `${name.toLowerCase()}-${suffix}@example.com`,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { contact: { id: number } }).contact.id;
}

test("POST /grow/activities rejects a bad type, date, duration, and mismatched contact with stable codes", async () => {
  const created = await createBrokerageWithUsers(baseUrl, `GP3 Validate ${suffix}`);
  try {
    await grant(created.brokerageId);
    const cookie = created.agent.cookie;
    const cases: Array<{ body: unknown; code: string }> = [
      { body: { summary: "no type" }, code: ACTIVITY_FIELDS_REQUIRED },
      { body: { activityType: "phone", summary: "not a type" }, code: ACTIVITY_TYPE_NOT_ALLOWED },
      { body: { activityType: "call_summary", summary: "reviewed elsewhere" }, code: CALL_SUMMARY_REVIEW_ONLY },
      { body: { activityType: "call", summary: "bad date", occurredAt: "yesterday" }, code: OCCURRED_AT_INVALID },
      {
        body: { activityType: "call", summary: "future", occurredAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
        code: OCCURRED_AT_OUT_OF_RANGE,
      },
      {
        body: { activityType: "meeting", summary: "ancient", occurredAt: "1800-01-01T00:00:00.000Z" },
        code: OCCURRED_AT_OUT_OF_RANGE,
      },
      { body: { activityType: "call", summary: "bad duration", durationMinutes: 0 }, code: ACTIVITY_DURATION_INVALID },
      { body: { activityType: "call", summary: "two contacts", partyId: 1, contactId: 2 }, code: CONTACT_REFERENCE_INVALID },
    ];
    for (const entry of cases) {
      const res = await send("POST", "/grow/activities", cookie, entry.body);
      const body = (await res.json()) as { code?: string; error?: string };
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(body.code, entry.code, JSON.stringify(entry.body));
    }

    const logged = await send("POST", "/grow/activities", cookie, {
      activityType: "Call",
      summary: "Spoke with Pat yesterday",
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      durationMinutes: 12,
      outcome: "Will send the appraisal",
      contactId: null,
    });
    const loggedBody = (await logged.json()) as {
      activity: { activityType: string; source: string; summary: string; details: { durationMinutes?: number; outcome?: string } };
    };
    assert.equal(logged.status, 201, JSON.stringify(loggedBody));
    assert.equal(loggedBody.activity.activityType, "call");
    assert.equal(loggedBody.activity.source, "manual");
    assert.equal(loggedBody.activity.summary, "Spoke with Pat yesterday");
    assert.equal(loggedBody.activity.details.durationMinutes, 12);
    assert.equal(loggedBody.activity.details.outcome, "Will send the appraisal");
  } finally {
    await cleanupBrokerages([created.brokerageId]);
  }
});

test("POST /grow/activities accepts only calls, meetings and notes, and writes no row for anything else", async () => {
  const created = await createBrokerageWithUsers(baseUrl, `GP3 Manual ${suffix}`);
  try {
    await grant(created.brokerageId);
    const cookie = created.agent.cookie;
    const handLoggedOnly = "Only calls, meetings and notes can be logged by hand.";
    const rejected = [
      "system_event",
      "task_completion",
      "email",
      "sms",
      "appraisal",
      "campaign_response",
      "property_enquiry",
      "offer_related",
      "Email",
    ] as const;
    for (const activityType of rejected) {
      const res = await send("POST", "/grow/activities", cookie, {
        activityType,
        summary: `Hand log ${activityType}`,
      });
      const body = (await res.json()) as { code?: string; error?: string };
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(body.code, ACTIVITY_TYPE_NOT_MANUAL, activityType);
      assert.equal(body.error, handLoggedOnly, activityType);
    }

    const unknown = await send("POST", "/grow/activities", cookie, {
      activityType: "phone",
      summary: "not a type",
    });
    const unknownBody = (await unknown.json()) as { code?: string };
    assert.equal(unknown.status, 400, JSON.stringify(unknownBody));
    assert.equal(unknownBody.code, ACTIVITY_TYPE_NOT_ALLOWED);

    const summary = await send("POST", "/grow/activities", cookie, {
      activityType: "CALL_SUMMARY",
      summary: "reviewed elsewhere",
    });
    const summaryBody = (await summary.json()) as { code?: string };
    assert.equal(summary.status, 400, JSON.stringify(summaryBody));
    assert.equal(summaryBody.code, CALL_SUMMARY_REVIEW_ONLY);

    const untouched = await db
      .select({ id: growActivities.id })
      .from(growActivities)
      .where(eq(growActivities.brokerageId, created.brokerageId));
    assert.equal(untouched.length, 0, "a refused type writes no activity row");

    for (const activityType of ["call", "meeting", "note", "Call"] as const) {
      const res = await send("POST", "/grow/activities", cookie, {
        activityType,
        summary: `Logged ${activityType}`,
      });
      const body = (await res.json()) as { activity?: { activityType?: string; source?: string } };
      assert.equal(res.status, 201, JSON.stringify(body));
      assert.equal(body.activity?.activityType, activityType.toLowerCase());
      assert.equal(body.activity?.source, "manual");
    }
  } finally {
    await cleanupBrokerages([created.brokerageId]);
  }
});

test("a reschedule still writes its system_event", async () => {
  const created = await createBrokerageWithUsers(baseUrl, `GP3 Reschedule ${suffix}`);
  try {
    await grant(created.brokerageId);
    const cookie = created.agent.cookie;
    const partyId = await createContact(cookie, "Ren");
    const commitment = await send("POST", `/grow/contacts/${partyId}/commitments`, cookie, {
      description: "Send a market update",
      dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(commitment.status, 201, await commitment.clone().text());
    const commitmentId = ((await commitment.json()) as { commitment: { id: number } }).commitment.id;
    const nextDueAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const rescheduled = await send("PATCH", `/grow/contacts/commitments/${commitmentId}`, cookie, {
      dueAt: nextDueAt,
    });
    assert.equal(rescheduled.status, 200, await rescheduled.clone().text());

    const rows = await db
      .select()
      .from(growActivities)
      .where(eq(growActivities.brokerageId, created.brokerageId));
    const systemEvents = rows.filter((row) => row.activityType === "system_event");
    assert.equal(systemEvents.length, 1, "the reschedule writer still inserts one system_event");
    const details = systemEvents[0]?.details as { kind?: string; commitmentId?: number } | null;
    assert.equal(details?.kind, "commitment_rescheduled");
    assert.equal(details?.commitmentId, commitmentId);
    assert.equal(
      rows.some((row) => row.activityType !== "system_event"),
      false,
    );
  } finally {
    await cleanupBrokerages([created.brokerageId]);
  }
});

test("POST /grow/activities applies tenant and FU-1 visibility: a hidden opportunity is 404, the contact stays visible", async () => {
  const created = await createBrokerageWithUsers(baseUrl, `GP3 Visible ${suffix}`);
  const other = await createBrokerageWithUsers(baseUrl, `GP3 Visible Other ${suffix}`);
  try {
    await grant(created.brokerageId);
    await grant(other.brokerageId);
    const agentB = await devLogin(baseUrl, {
      email: `gp3-agent-b-${suffix}@example.com`,
      firstName: "Agent",
      lastName: "Bee",
      brokerageName: `GP3 Visible ${suffix}`,
    });
    const propertyId = await createProperty(created.agent.cookie, `${suffix} GP3 St`);
    const contactId = await createContact(created.agent.cookie, "Lou");
    const unlinked = await send("POST", "/grow/opportunities", created.agent.cookie, {
      partyId: contactId,
      opportunityType: "Other",
      reason: "Unlinked, owned by A",
    });
    assert.equal(unlinked.status, 201, await unlinked.clone().text());
    const opportunityId = ((await unlinked.json()) as { opportunity: { id: number } }).opportunity.id;

    const foreignContact = await createContact(other.agent.cookie, "Other");
    const crossTenant = await send("POST", "/grow/activities", created.agent.cookie, {
      activityType: "call",
      summary: "wrong brokerage",
      contactId: foreignContact,
    });
    assert.equal(crossTenant.status, 404);

    const hiddenOpportunity = await send("POST", "/grow/activities", agentB.cookie, {
      activityType: "meeting",
      summary: "should not land",
      partyId: contactId,
      opportunityId,
    });
    assert.equal(hiddenOpportunity.status, 404);
    assert.match(((await hiddenOpportunity.json()) as { error: string }).error, /not found in this brokerage/i);

    const contactOnly = await send("POST", "/grow/activities", agentB.cookie, {
      activityType: "note",
      summary: "Contact 360 is brokerage-wide",
      contactId,
    });
    assert.equal(contactOnly.status, 201, await contactOnly.clone().text());

    const hiddenProperty = await send("POST", "/grow/activities", agentB.cookie, {
      activityType: "call",
      summary: "not B's property",
      partyId: contactId,
      propertyId,
    });
    assert.equal(hiddenProperty.status, 404);

    const ownerLog = await send("POST", "/grow/activities", created.agent.cookie, {
      activityType: "meeting",
      summary: "Owner can log it",
      partyId: contactId,
      opportunityId,
      occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(ownerLog.status, 201, await ownerLog.clone().text());
  } finally {
    await cleanupBrokerages([created.brokerageId, other.brokerageId]);
  }
});

test("Grow Today and relationship recency ignore a note and a reschedule, and move when a call is logged", async () => {
  const created = await createBrokerageWithUsers(baseUrl, `GP3 Recency ${suffix}`);
  try {
    await grant(created.brokerageId);
    const cookie = created.agent.cookie;
    const propertyId = await createProperty(cookie, `${suffix} Recency St`);
    const partyId = await createContact(cookie, "Ada");
    const relationship = await send("POST", "/grow/relationships", cookie, {
      partyId,
      propertyId,
      relationshipType: "owner",
    });
    assert.equal(relationship.status, 201, await relationship.clone().text());

    const oldCallAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const oldCall = await send("POST", "/grow/activities", cookie, {
      activityType: "call",
      summary: "Original call",
      partyId,
      propertyId,
      occurredAt: oldCallAt,
    });
    assert.equal(oldCall.status, 201, await oldCall.clone().text());

    const note = await send("POST", "/grow/activities", cookie, {
      activityType: "note",
      summary: "A note today must not reset recency",
      partyId,
      propertyId,
    });
    assert.equal(note.status, 201, await note.clone().text());

    const commitment = await send("POST", `/grow/contacts/${partyId}/commitments`, cookie, {
      description: "Send a market update",
      dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      propertyId,
    });
    assert.equal(commitment.status, 201, await commitment.clone().text());
    const commitmentId = ((await commitment.json()) as { commitment: { id: number } }).commitment.id;
    const rescheduled = await send("PATCH", `/grow/contacts/commitments/${commitmentId}`, cookie, {
      dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(rescheduled.status, 200, await rescheduled.clone().text());

    const today = await send("GET", "/grow/today", cookie);
    const todayBody = (await today.json()) as {
      priorityActions: Array<{ id: string; type: string; reason: string; lastActivityAt: string | null }>;
    };
    assert.equal(today.status, 200, JSON.stringify(todayBody));
    const card = todayBody.priorityActions.find((item) => item.type === "relationship_cold");
    assert.ok(card, "the relationship is still cold after a note and a reschedule");
    assert.match(card.reason, /No contact recorded for (39|40|41) days\./);
    const reportedDays = Math.round((Date.now() - new Date(card.lastActivityAt ?? 0).getTime()) / (24 * 60 * 60 * 1000));
    assert.ok(reportedDays >= 39 && reportedDays <= 41, `last contact stayed on the call, got ${reportedDays} days`);

    const contact = await send("GET", `/grow/contacts/${partyId}`, cookie);
    const contactBody = (await contact.json()) as { intelligence: { mostRecentInteractionAt: string | null } };
    assert.equal(contact.status, 200, JSON.stringify(contactBody));
    const interactionDays = Math.round(
      (Date.now() - new Date(contactBody.intelligence.mostRecentInteractionAt ?? 0).getTime()) / (24 * 60 * 60 * 1000),
    );
    assert.ok(interactionDays >= 39 && interactionDays <= 41, `relationship recency stayed on the call, got ${interactionDays} days`);

    const recentCallAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const recentCall = await send("POST", "/grow/activities", cookie, {
      activityType: "call",
      summary: "Logged the call we had",
      partyId,
      propertyId,
      occurredAt: recentCallAt,
      durationMinutes: 8,
      outcome: "Booked a time",
    });
    assert.equal(recentCall.status, 201, await recentCall.clone().text());
    assert.equal(((await recentCall.json()) as { activity: { source: string } }).activity.source, "manual");

    const after = await send("GET", "/grow/today", cookie);
    const afterBody = (await after.json()) as { priorityActions: Array<{ reason: string }> };
    assert.equal(
      afterBody.priorityActions.some((item) => /No contact recorded for (39|40|41) days\./.test(item.reason)),
      false,
      "a logged call moves Grow Today off the 40-day recency",
    );
    const afterContact = await send("GET", `/grow/contacts/${partyId}`, cookie);
    const afterIntelligence = (await afterContact.json()) as { intelligence: { mostRecentInteractionAt: string | null } };
    const afterDays = Math.round(
      (Date.now() - new Date(afterIntelligence.intelligence.mostRecentInteractionAt ?? 0).getTime()) / (24 * 60 * 60 * 1000),
    );
    assert.ok(afterDays >= 1 && afterDays <= 3, `relationship recency moved to the logged call, got ${afterDays} days`);
  } finally {
    await cleanupBrokerages([created.brokerageId]);
  }
});

test("an admin can log against another agent's unlinked opportunity", async () => {
  const created = await createBrokerageWithUsers(baseUrl, `GP3 Admin ${suffix}`);
  try {
    await grant(created.brokerageId);
    const contactId = await createContact(created.agent.cookie, "Ned");
    const opportunity = await send("POST", "/grow/opportunities", created.agent.cookie, {
      partyId: contactId,
      opportunityType: "Other",
      reason: "Agent owned",
    });
    assert.equal(opportunity.status, 201, await opportunity.clone().text());
    const opportunityId = ((await opportunity.json()) as { opportunity: { id: number } }).opportunity.id;
    const logged = await send("POST", "/grow/activities", created.admin.cookie, {
      activityType: "call",
      summary: "Admin log",
      partyId: contactId,
      opportunityId,
    });
    assert.equal(logged.status, 201, await logged.clone().text());
  } finally {
    await cleanupBrokerages([created.brokerageId]);
  }
});
