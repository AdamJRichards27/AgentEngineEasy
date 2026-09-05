// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Named proof flow: "Mock Property Launch publication" — one correlationId
// tying together the whole real chain this action drives: the HTTP request
// -> the transactional outbox row it enqueues -> the outbox dispatch
// attempt against the mock portal adapter -> Launch's own service-boundary
// write (recordPortalSubmission) -> the PORTAL_SUBMISSION_RECORDED domain
// event it publishes.
//
// Unlike the "Mock Communications delivery" proof (correlationPropagation
// gap fixed in lib/communications/messages.ts this same hardening pass),
// this flow was ALREADY correct by construction: publishListingToMockPortal
// (lib/integrations/launchProof.ts) is only ever invoked from
// routes/integrations.ts's POST /integrations/connections/:id/actions/
// publish-listing — one HTTP request, wrapped end-to-end in
// middlewares/requestId.ts's runWithCorrelationId — so every step below,
// however many intermediate re-establishments happen (dispatchCommand
// re-establishes the outbox row's OWN stored correlationId around dispatch,
// which purely coincidentally equals the same request's id here since
// enqueueCommand captured it from the very same ambient context), resolves
// back to the one id this test captures from the response header. This
// test makes that a checked fact instead of an inference from reading the
// code, over the real HTTP surface exactly as production calls it — not a
// bare model-function call from test code, which would establish no
// ambient context at all and prove nothing representative.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and, desc } from "drizzle-orm";
import { db, integrationOutbox, domainEvents } from "@aee/db";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { bootstrapIntegrationsForTesting, createActiveMockPortalConnection } from "./testHelpers.js";
import { CORRELATION_ID_HEADER } from "../../../middlewares/requestId.js";
import { getOrCreateLaunchPlan, addPortalDestination } from "../../launch/model.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
// devLogin() below requires ALLOW_DEV_AUTH=true. Most suites in this repo
// set this themselves at module load (see e.g. transactionConditions.test.ts)
// rather than relying on an ambient value that may not be set, and this
// suite should too.
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await bootstrapIntegrationsForTesting();
  A = await createBrokerageWithUsers(baseUrl, `Launch Publication Correlation Proof ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("publishing a listing over real HTTP ties the outbox row and the resulting PORTAL_SUBMISSION_RECORDED domain event to the SAME correlationId as the triggering request", async () => {
  const actor = { id: A.admin.user.id, role: A.admin.user.role };

  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `1 Launch Publication Correlation Rd ${suffix}` });
  const { plan } = await getOrCreateLaunchPlan(propertyId, A.brokerageId, actor);
  const destination = await addPortalDestination(plan.id, A.brokerageId, actor, "Mock Property Portal (Sandbox)");
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor);

  const publishRes = await fetch(`${baseUrl}/api/integrations/connections/${connection.id}/actions/publish-listing`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ portalDestinationId: destination.id }),
  });
  assert.equal(publishRes.status, 200);
  const requestCorrelationId = publishRes.headers.get(CORRELATION_ID_HEADER);
  assert.ok(requestCorrelationId, "the publish-listing request must echo an X-Correlation-Id response header");
  const publishBody = (await publishRes.json()) as { result: { outboxStatus: string } };
  assert.equal(publishBody.result.outboxStatus, "SENT");

  const [outboxRow] = await db
    .select()
    .from(integrationOutbox)
    .where(and(eq(integrationOutbox.connectionId, connection.id), eq(integrationOutbox.sourceRecordId, destination.id)))
    .orderBy(desc(integrationOutbox.dispatchedAt))
    .limit(1);
  assert.ok(outboxRow, "publish-listing should have enqueued an integration_outbox row for this destination");
  assert.equal(
    outboxRow.correlationId,
    requestCorrelationId,
    "the enqueued outbox command must carry the triggering request's own correlationId",
  );

  const [submissionEvent] = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.eventType, "PORTAL_SUBMISSION_RECORDED"), eq(domainEvents.propertyId, propertyId)))
    .orderBy(desc(domainEvents.occurredAt))
    .limit(1);
  assert.ok(submissionEvent, "recordPortalSubmission should have published PORTAL_SUBMISSION_RECORDED");
  assert.equal(
    submissionEvent.correlationId,
    requestCorrelationId,
    "Launch's own service-boundary write (recordPortalSubmission) must publish under the SAME correlationId as the triggering request and the outbox row it followed from",
  );
});
