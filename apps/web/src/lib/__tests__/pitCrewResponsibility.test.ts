import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiError } from "../api.ts";
import {
  PIT_CREW_ESCALATION_REASON_CATEGORIES,
  PIT_CREW_ESCALATION_SEVERITIES,
  PIT_CREW_HAND_BACK_REASON_CATEGORIES,
  PIT_CREW_RESPONSIBILITY_UNAVAILABLE_MESSAGE,
  acknowledgePcEscalation,
  canAcknowledgeEscalation,
  canResolveOrReturnEscalation,
  escalatePcItem,
  fetchResponsibilityRecipients,
  handBackPcItem,
  isPitCrewActiveActionStatus,
  pitCrewResponsibilityActionError,
  pitCrewResponsibilityActionsVisible,
  reclaimPcHandBack,
  resolvePcEscalation,
  returnPcEscalation,
  type PcResponsibilityWorkItem,
} from "../pitCrew.ts";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const base = {
  sourceType: "EXCEPTION",
  sourceRecordId: SOURCE,
  propertyId: 15,
  expectedVersion: 3,
};

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function capture<T>(status: number, body: unknown, run: () => Promise<T>): Promise<{ result: T; call: FetchCall }> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return jsonResponse(status, body);
  };
  try {
    const result = await run();
    assert.equal(calls.length, 1);
    return { result, call: calls[0]! };
  } finally {
    globalThis.fetch = original;
  }
}

function postedBody(call: FetchCall): Record<string, unknown> {
  assert.equal(call.init?.method, "POST");
  assert.equal(typeof call.init?.body, "string");
  return JSON.parse(call.init!.body as string) as Record<string, unknown>;
}

const mutationResponse = {
  id: 3,
  brokerageId: 1,
  sourceType: "EXCEPTION",
  sourceRecordId: SOURCE,
  propertyId: 15,
  status: "HANDED_BACK",
  assignedToUserId: null,
  claimedAt: null,
  waitingOnParty: null,
  waitingOnNote: null,
  waitingOnSince: null,
  waitingOnExpectedAt: null,
  handoffFromUserId: null,
  handoffToUserId: null,
  handoffNote: null,
  handoffAt: null,
  completedAt: null,
  version: 4,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  responsibilityEvent: {
    id: 8,
    brokerageId: 1,
    assignmentId: 3,
    propertyId: 15,
    kind: "HAND_BACK",
    reasonCategory: "WORK_COMPLETE",
    severity: null,
    note: null,
    closingNote: null,
    nextAction: "Review the returned evidence.",
    originatingUserId: 9,
    recipientUserId: 42,
    recipientRole: null,
    resultingResponsibility: "AGENT",
    expectedResponseAt: null,
    status: "OPEN",
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    closedAt: null,
    closedByUserId: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  },
};

test("fetchResponsibilityRecipients requests one kind and does not expect contact fields", async () => {
  const { result, call } = await capture(
    200,
    { recipients: [{ userId: 7, displayName: "Amy Agent", role: "Agent" }] },
    () => fetchResponsibilityRecipients("ESCALATE"),
  );
  assert.equal(call.url, "/api/pit-crew/responsibility-recipients?kind=ESCALATE");
  assert.equal(call.init?.method, undefined);
  assert.equal(result.recipients[0]?.displayName, "Amy Agent");
  assert.equal(result.recipients[0]?.userId, 7);
  assert.equal("email" in (result.recipients[0] ?? {}), false);
});

test("reason and severity lists mirror packages/db/src/schema/pitCrew.ts", () => {
  const schema = readFileSync(new URL("../../../../../packages/db/src/schema/pitCrew.ts", import.meta.url), "utf8");
  for (const value of [
    ...PIT_CREW_HAND_BACK_REASON_CATEGORIES,
    ...PIT_CREW_ESCALATION_REASON_CATEGORIES,
    ...PIT_CREW_ESCALATION_SEVERITIES,
  ]) {
    assert.match(schema, new RegExp(`"${value}"`));
  }
});

test("handBackPcItem posts the hand-back body and keeps closingNote on the response", async () => {
  const { result, call } = await capture(200, mutationResponse, () =>
    handBackPcItem({
      ...base,
      reasonCategory: "WORK_COMPLETE",
      nextAction: "  Review the returned evidence.  ",
      note: "  Optional context  ",
      recipientUserId: 42,
    }),
  );
  assert.equal(call.url, `/api/pit-crew/items/EXCEPTION/${SOURCE}/hand-back`);
  assert.deepEqual(postedBody(call), {
    propertyId: 15,
    expectedVersion: 3,
    reasonCategory: "WORK_COMPLETE",
    nextAction: "Review the returned evidence.",
    note: "Optional context",
    recipientUserId: 42,
  });
  assert.equal(result.responsibilityEvent.closingNote, null);
  assert.equal(result.version, 4);
});

test("handBackPcItem omits an empty note and an omitted recipient", async () => {
  const { call } = await capture(200, mutationResponse, () =>
    handBackPcItem({ ...base, reasonCategory: "NEXT_ACTION_WITH_AGENT", nextAction: "Call the agent.", note: "   " }),
  );
  assert.deepEqual(postedBody(call), {
    propertyId: 15,
    expectedVersion: 3,
    reasonCategory: "NEXT_ACTION_WITH_AGENT",
    nextAction: "Call the agent.",
  });
});

test("escalatePcItem posts severity and expectedResponseAt for AT_RISK", async () => {
  const { call } = await capture(200, mutationResponse, () =>
    escalatePcItem({
      ...base,
      reasonCategory: "MISSING_AUTHORITY",
      severity: "AT_RISK",
      note: "  Settlement figure is outside Pit Crew authority. ",
      nextAction: " Decide whether the brokerage will authorise the next settlement step. ",
      expectedResponseAt: "2026-10-01T04:00:00.000Z",
    }),
  );
  assert.equal(call.url, `/api/pit-crew/items/EXCEPTION/${SOURCE}/escalate`);
  assert.deepEqual(postedBody(call), {
    propertyId: 15,
    expectedVersion: 3,
    reasonCategory: "MISSING_AUTHORITY",
    severity: "AT_RISK",
    note: "Settlement figure is outside Pit Crew authority.",
    nextAction: "Decide whether the brokerage will authorise the next settlement step.",
    expectedResponseAt: "2026-10-01T04:00:00.000Z",
  });
});

test("escalatePcItem omits expectedResponseAt and recipient when they are not provided", async () => {
  const { call } = await capture(200, mutationResponse, () =>
    escalatePcItem({
      ...base,
      reasonCategory: "MISSING_INFORMATION",
      severity: "ATTENTION",
      note: "The file is incomplete.",
      nextAction: "Ask the agent for the missing document.",
    }),
  );
  assert.deepEqual(postedBody(call), {
    propertyId: 15,
    expectedVersion: 3,
    reasonCategory: "MISSING_INFORMATION",
    severity: "ATTENTION",
    note: "The file is incomplete.",
    nextAction: "Ask the agent for the missing document.",
  });
});

test("acknowledge, resolve, return, and reclaim post only the fields each route accepts", async () => {
  const acknowledge = await capture(200, mutationResponse, () => acknowledgePcEscalation({ ...base, note: "   " }));
  assert.equal(acknowledge.call.url, `/api/pit-crew/items/EXCEPTION/${SOURCE}/escalation/acknowledge`);
  assert.deepEqual(postedBody(acknowledge.call), { propertyId: 15, expectedVersion: 3 });

  const acknowledgeNoted = await capture(200, mutationResponse, () =>
    acknowledgePcEscalation({ ...base, note: " Seen. " }),
  );
  assert.deepEqual(postedBody(acknowledgeNoted.call), { propertyId: 15, expectedVersion: 3, note: "Seen." });

  const resolvedBody = {
    ...mutationResponse,
    status: "IN_PROGRESS",
    responsibilityEvent: { ...mutationResponse.responsibilityEvent, status: "RESOLVED", closingNote: "Authorised the next step." },
  };
  const resolved = await capture(200, resolvedBody, () => resolvePcEscalation({ ...base, note: " Authorised the next step. " }));
  assert.equal(resolved.call.url, `/api/pit-crew/items/EXCEPTION/${SOURCE}/escalation/resolve`);
  assert.deepEqual(postedBody(resolved.call), { propertyId: 15, expectedVersion: 3, note: "Authorised the next step." });
  assert.equal(resolved.result.responsibilityEvent.closingNote, "Authorised the next step.");

  const returned = await capture(200, mutationResponse, () => returnPcEscalation({ ...base, note: "Returned for Pit Crew." }));
  assert.equal(returned.call.url, `/api/pit-crew/items/EXCEPTION/${SOURCE}/escalation/return`);
  assert.deepEqual(postedBody(returned.call), { propertyId: 15, expectedVersion: 3, note: "Returned for Pit Crew." });

  const reclaimed = await capture(200, mutationResponse, () => reclaimPcHandBack(base));
  assert.equal(reclaimed.call.url, `/api/pit-crew/items/EXCEPTION/${SOURCE}/hand-back/reclaim`);
  assert.deepEqual(postedBody(reclaimed.call), { propertyId: 15, expectedVersion: 3 });
});

test("the inbox probe is the feature signal: 404 is off, 200 is on, other failures throw", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "/api/pit-crew/responsibility-inbox");
      return jsonResponse(404, { error: "Not found." });
    };
    assert.equal(await pitCrewResponsibilityActionsVisible(), false);

    globalThis.fetch = async () => jsonResponse(200, { generatedAt: "2026-09-27T00:00:00.000Z", items: [] });
    assert.equal(await pitCrewResponsibilityActionsVisible(), true);

    globalThis.fetch = async () => jsonResponse(500, { error: "boom" });
    await assert.rejects(pitCrewResponsibilityActionsVisible(), (err: unknown) => err instanceof ApiError && err.status === 500);
  } finally {
    globalThis.fetch = original;
  }
});

test("responsibility action errors keep the 409 and 422 sentences and neutralise 404", () => {
  assert.equal(
    pitCrewResponsibilityActionError(new ApiError(409, "This item was changed by someone else. Refresh and try again.")),
    "This item was changed by someone else. Refresh and try again.",
  );
  assert.equal(
    pitCrewResponsibilityActionError(new ApiError(422, "Cannot move a Pit Crew item from DONE to HANDED_BACK.")),
    "Cannot move a Pit Crew item from DONE to HANDED_BACK.",
  );
  assert.equal(
    pitCrewResponsibilityActionError(new ApiError(404, "That couldn't be found — it may have been removed.")),
    PIT_CREW_RESPONSIBILITY_UNAVAILABLE_MESSAGE,
  );
  assert.equal(pitCrewResponsibilityActionError(new Error("socket hang up")), "Something went wrong. Try again.");
});

function escalationItem(overrides: Record<string, unknown> = {}): PcResponsibilityWorkItem {
  return {
    sourceType: "EXCEPTION",
    sourceRecordId: SOURCE,
    propertyId: 15,
    propertyAddress: null,
    brokerageId: 1,
    title: "Escalated item",
    description: "",
    category: "OFFERS",
    severity: "ATTENTION",
    exceptionStatus: "OPEN",
    ownerType: "PIT_CREW",
    ownerUserId: null,
    ownerName: null,
    dueAt: null,
    overdue: false,
    recommendedAction: "",
    deepLink: "/properties/15",
    detectedAt: "2026-09-01T00:00:00.000Z",
    pcStatus: "ESCALATED",
    assignedToUserId: 9,
    assignedToName: "Pat Crew",
    claimedAt: "2026-09-01T00:00:00.000Z",
    waitingOnParty: null,
    waitingOnNote: null,
    waitingOnSince: null,
    waitingOnExpectedAt: null,
    handoffFromUserId: null,
    handoffToUserId: null,
    handoffNote: null,
    handoffAt: null,
    completedAt: null,
    version: 8,
    responsibility: {
      eventId: 5,
      kind: "ESCALATION",
      reasonCategory: "MISSING_AUTHORITY",
      severity: "AT_RISK",
      note: "Outside authority.",
      closingNote: null,
      nextAction: "Decide the next step.",
      originatingUserId: 9,
      recipientUserId: null,
      recipientRole: "Brokerage Administrator",
      expectedResponseAt: "2026-10-03T00:00:00.000Z",
      eventStatus: "OPEN",
    },
    ...overrides,
  } as PcResponsibilityWorkItem;
}

test("escalation responses follow the recipient rule", () => {
  const open = escalationItem();
  const pitCrew = { id: 9, role: "Pit Crew" };
  const admin = { id: 2, role: "Brokerage Administrator" };
  assert.equal(canAcknowledgeEscalation(open, pitCrew), false);
  assert.equal(canResolveOrReturnEscalation(open, pitCrew), false);
  assert.equal(canAcknowledgeEscalation(open, admin), true);
  assert.equal(canResolveOrReturnEscalation(open, admin), true);

  const acknowledged = escalationItem();
  acknowledged.responsibility = { ...acknowledged.responsibility, eventStatus: "ACKNOWLEDGED" };
  assert.equal(canAcknowledgeEscalation(acknowledged, admin), false);
  assert.equal(canResolveOrReturnEscalation(acknowledged, admin), true);

  const named = escalationItem();
  named.responsibility = { ...named.responsibility, recipientUserId: 4, recipientRole: null, originatingUserId: 9 };
  assert.equal(canAcknowledgeEscalation(named, { id: 4, role: "Pit Crew" }), true);
  assert.equal(canAcknowledgeEscalation(named, admin), false);

  assert.equal(isPitCrewActiveActionStatus("CLAIMED"), true);
  assert.equal(isPitCrewActiveActionStatus("IN_PROGRESS"), true);
  assert.equal(isPitCrewActiveActionStatus("WAITING_ON"), true);
  assert.equal(isPitCrewActiveActionStatus("UNCLAIMED"), false);
  assert.equal(isPitCrewActiveActionStatus("DONE"), false);
  assert.equal(isPitCrewActiveActionStatus("HANDED_BACK"), false);
  assert.equal(isPitCrewActiveActionStatus("ESCALATED"), false);
});
