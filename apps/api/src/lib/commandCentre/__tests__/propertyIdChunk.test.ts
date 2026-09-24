// I-14 — Command Centre property-id fan-out is chunked, and automation_tasks
// is read once per chunk for both ACTIVE and COMPLETED.
//
// Before this lock, getCommandCentre loaded every property in scope and
// passed that whole id list to inArray on each fan-out query. drizzle expands
// inArray to one bind per id, so the list grew with the brokerage. ACTIVE
// and COMPLETED automation tasks were two of those queries.
//
// A normal scope (at or under COMMAND_CENTRE_ID_CHUNK) is still one statement
// per table. The test passes idChunkSize: 1 so three properties have to cross
// a chunk boundary; that override is refused outside NODE_ENV=test and cannot
// raise the cap. The rows that come back are the same rows a single list
// would have returned.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  db,
  brokerages,
  users,
  properties,
  automationTasks,
  transactions,
  transactionConditions,
  workflows,
  workflowSteps,
  setDbQueryObserver,
} from "@aee/db";
import {
  COMMAND_CENTRE_ID_CHUNK,
  chunkIds,
  getCommandCentre,
  resolveCommandCentreIdChunkSize,
} from "../queries.js";
import { cleanupBrokerages } from "../../../routes/__tests__/testSupport.js";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

type Observed = { query: string; params: unknown[] };

const brokerageIds: number[] = [];

function boundLists(query: string, params: unknown[], columnSql: string): number[][] {
  const re = new RegExp(`${columnSql}\\s+in\\s*\\(([^)]*)\\)`, "gi");
  const lists: number[][] = [];
  for (const match of query.matchAll(re)) {
    const ids = [...match[1].matchAll(/\$(\d+)/g)].map((slot) => params[Number(slot[1]) - 1]);
    if (ids.length === 0 || ids.some((id) => typeof id !== "number")) continue;
    lists.push(ids as number[]);
  }
  return lists;
}

function listsFor(statements: Observed[], columnSql: string): number[][] {
  return statements.flatMap((statement) => boundLists(statement.query, statement.params, columnSql));
}

function fromTable(statements: Observed[], table: string): Observed[] {
  return statements.filter((statement) => new RegExp(`from\\s+"${table}"`, "i").test(statement.query));
}

function statusBinds(statement: Observed): string[] {
  const match = statement.query.match(/"automation_tasks"\."status"\s+in\s*\(([^)]*)\)/i);
  if (!match) return [];
  return [...match[1].matchAll(/\$(\d+)/g)].map((slot) => String(statement.params[Number(slot[1]) - 1]));
}

async function capture(run: () => Promise<unknown>): Promise<Observed[]> {
  const statements: Observed[] = [];
  const uninstall = setDbQueryObserver((query, params) => statements.push({ query, params }));
  try {
    await run();
  } finally {
    uninstall();
  }
  return statements;
}

test("chunkIds keeps every id and never builds a list over the chunk size", () => {
  assert.equal(COMMAND_CENTRE_ID_CHUNK, 500);
  assert.deepEqual(chunkIds([], COMMAND_CENTRE_ID_CHUNK), []);
  assert.deepEqual(chunkIds([7], 2), [[7]]);
  assert.deepEqual(chunkIds([1, 2, 3], 2), [
    [1, 2],
    [3],
  ]);
  const ids = Array.from({ length: COMMAND_CENTRE_ID_CHUNK + 1 }, (_, index) => index + 1);
  const chunks = chunkIds(ids, COMMAND_CENTRE_ID_CHUNK);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, COMMAND_CENTRE_ID_CHUNK);
  assert.equal(chunks[1].length, 1);
  assert.equal(chunks.flat().length, ids.length);
  assert.ok(chunks.every((chunk) => chunk.length <= COMMAND_CENTRE_ID_CHUNK));
});

test("resolveCommandCentreIdChunkSize ignores a raise and ignores any override outside tests", () => {
  assert.equal(resolveCommandCentreIdChunkSize(undefined), COMMAND_CENTRE_ID_CHUNK);
  assert.equal(resolveCommandCentreIdChunkSize(1), 1);
  assert.equal(resolveCommandCentreIdChunkSize(COMMAND_CENTRE_ID_CHUNK), COMMAND_CENTRE_ID_CHUNK);
  assert.equal(resolveCommandCentreIdChunkSize(COMMAND_CENTRE_ID_CHUNK + 50), COMMAND_CENTRE_ID_CHUNK);
  assert.equal(resolveCommandCentreIdChunkSize(0), COMMAND_CENTRE_ID_CHUNK);
  assert.equal(resolveCommandCentreIdChunkSize(1.5), COMMAND_CENTRE_ID_CHUNK);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.equal(resolveCommandCentreIdChunkSize(1), COMMAND_CENTRE_ID_CHUNK);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

let brokerageId: number;
let otherBrokerageId: number;
let userId: number;
let propertyA: number;
let propertyB: number;
let propertyC: number;
let otherPropertyId: number;
let dueTodayTaskId: string;
let comingUpTaskId: string;
let completedTodayTaskId: string;
let overdueTaskId: string;
let completedYesterdayTaskId: string;
let supersededTaskId: string;
let foreignTaskId: string;
let conditionId: number;
let secondConditionId: number;
let stepId: number;
let now: Date;

before(async () => {
  now = new Date();
  const suffix = randomUUID();
  const [home] = await db.insert(brokerages).values({ name: `I-14 home ${suffix}` }).returning({ id: brokerages.id });
  const [other] = await db.insert(brokerages).values({ name: `I-14 other ${suffix}` }).returning({ id: brokerages.id });
  brokerageId = home.id;
  otherBrokerageId = other.id;
  brokerageIds.push(home.id, other.id);

  const [user] = await db
    .insert(users)
    .values({
      brokerageId,
      email: `i14-${suffix}@example.test`,
      authProviderId: `i14-${suffix}`,
      firstName: "Ada",
      lastName: "Chunk",
      role: "Brokerage Administrator",
    })
    .returning({ id: users.id });
  userId = user.id;

  const [otherUser] = await db
    .insert(users)
    .values({
      brokerageId: otherBrokerageId,
      email: `i14-other-${suffix}@example.test`,
      authProviderId: `i14-other-${suffix}`,
      firstName: "Other",
      lastName: "Tenant",
      role: "Agent",
    })
    .returning({ id: users.id });

  async function insertProperty(targetBrokerageId: number, agentId: number, address: string): Promise<number> {
    const [row] = await db
      .insert(properties)
      .values({
        brokerageId: targetBrokerageId,
        agentId,
        formattedAddress: address,
        workflowStage: "Listed",
      })
      .returning({ id: properties.id });
    return row.id;
  }

  propertyA = await insertProperty(brokerageId, userId, `1 Chunk St ${suffix}`);
  propertyB = await insertProperty(brokerageId, userId, `2 Chunk St ${suffix}`);
  propertyC = await insertProperty(brokerageId, userId, `3 Chunk St ${suffix}`);
  otherPropertyId = await insertProperty(otherBrokerageId, otherUser.id, `9 Other St ${suffix}`);

  const comingUp = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const overdue = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const yesterday = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

  async function insertTask(
    targetBrokerageId: number,
    propertyId: number,
    status: string,
    dueAt: Date | null,
    completedAt: Date | null,
  ): Promise<string> {
    const [row] = await db
      .insert(automationTasks)
      .values({
        brokerageId: targetBrokerageId,
        propertyId,
        taskKey: "PREPARE_SETTLEMENT_TRACKING",
        kind: "TASK",
        title: `I-14 ${status} ${propertyId}`,
        status,
        dueAt,
        completedAt,
      })
      .returning({ id: automationTasks.id });
    return row.id;
  }

  dueTodayTaskId = await insertTask(brokerageId, propertyA, "ACTIVE", now, null);
  comingUpTaskId = await insertTask(brokerageId, propertyB, "ACTIVE", comingUp, null);
  completedTodayTaskId = await insertTask(brokerageId, propertyC, "COMPLETED", null, now);
  overdueTaskId = await insertTask(brokerageId, propertyA, "ACTIVE", overdue, null);
  completedYesterdayTaskId = await insertTask(brokerageId, propertyB, "COMPLETED", null, yesterday);
  supersededTaskId = await insertTask(brokerageId, propertyC, "SUPERSEDED", now, null);
  foreignTaskId = await insertTask(otherBrokerageId, otherPropertyId, "ACTIVE", now, null);

  async function insertOverdueCondition(propertyId: number): Promise<number> {
    const [txn] = await db
      .insert(transactions)
      .values({
        propertyId,
        sellerPartyIds: [],
        buyerPartyIds: [],
        purchasePriceCents: 100,
        settlementDate: overdue,
      })
      .returning({ id: transactions.id });
    const [cond] = await db
      .insert(transactionConditions)
      .values({
        transactionId: txn.id,
        description: `I-14 condition ${propertyId}`,
        dueDate: overdue,
        status: "Pending",
      })
      .returning({ id: transactionConditions.id });
    return cond.id;
  }

  conditionId = await insertOverdueCondition(propertyA);
  secondConditionId = await insertOverdueCondition(propertyC);

  const [workflow] = await db
    .insert(workflows)
    .values({ propertyId: propertyC, workflowType: "ReadyToList", status: "Active" })
    .returning({ id: workflows.id });
  const [step] = await db
    .insert(workflowSteps)
    .values({
      workflowId: workflow.id,
      stepKey: "VerifySellers",
      label: "Verify sellers",
      sequence: 1,
      status: "Ready",
    })
    .returning({ id: workflowSteps.id });
  stepId = step.id;
});

after(async () => {
  await cleanupBrokerages(brokerageIds);
});

function actor() {
  return { id: userId, role: "Brokerage Administrator", brokerageId, firstName: "Ada" };
}

test("a normal scope reads automation_tasks once and keeps both statuses", async () => {
  const statements = await capture(() =>
    getCommandCentre(actor(), { now, canViewFinancials: true, restrictToPropertyIds: null }),
  );
  const tasks = fromTable(statements, "automation_tasks");
  assert.equal(tasks.length, 1, `expected one automation_tasks read; got ${tasks.length}`);
  assert.deepEqual(statusBinds(tasks[0]).sort(), ["ACTIVE", "COMPLETED"]);

  const propertyLists = boundLists(tasks[0].query, tasks[0].params, '"property_id"');
  assert.equal(propertyLists.length, 1);
  assert.equal(propertyLists[0].length, 3);
  assert.deepEqual([...propertyLists[0]].sort((a, b) => a - b), [propertyA, propertyB, propertyC].sort((a, b) => a - b));
  assert.ok(propertyLists[0].length <= COMMAND_CENTRE_ID_CHUNK);

  const propertyIdLists = listsFor(statements, '"property_id"');
  assert.ok(propertyIdLists.length > 0);
  assert.ok(
    propertyIdLists.every((list) => list.length <= COMMAND_CENTRE_ID_CHUNK),
    `a property-id bind list exceeded the chunk: ${JSON.stringify(propertyIdLists.map((list) => list.length))}`,
  );
  assert.equal(listsFor(statements, '"properties"\\."id"').length, 0, "an administrator scope must not bind every property id on the properties read");
});

test("chunks stay at or under the cap and the tail is not dropped", async () => {
  let result: Awaited<ReturnType<typeof getCommandCentre>> | undefined;
  const statements = await capture(async () => {
    result = await getCommandCentre(actor(), {
      now,
      canViewFinancials: true,
      restrictToPropertyIds: null,
      idChunkSize: 1,
    });
  });
  assert.ok(result);

  const tasks = fromTable(statements, "automation_tasks");
  assert.equal(tasks.length, 3, "one automation_tasks read per property chunk, not a second read per status");
  for (const statement of tasks) {
    assert.deepEqual(statusBinds(statement).sort(), ["ACTIVE", "COMPLETED"]);
  }
  const taskPropertyIds = tasks.flatMap((statement) => boundLists(statement.query, statement.params, '"property_id"').flat());
  assert.deepEqual([...taskPropertyIds].sort((a, b) => a - b), [propertyA, propertyB, propertyC].sort((a, b) => a - b));

  for (const table of ["campaign_items", "launch_plans", "vendor_approvals", "transactions", "offers"]) {
    const reads = fromTable(statements, table);
    const lists = reads.flatMap((statement) => boundLists(statement.query, statement.params, '"property_id"'));
    assert.equal(lists.length, 3, `${table} should be read once per chunk`);
    assert.ok(lists.every((list) => list.length === 1), `${table} bind lists: ${JSON.stringify(lists)}`);
    assert.deepEqual(
      lists.flat().sort((a, b) => a - b),
      [propertyA, propertyB, propertyC].sort((a, b) => a - b),
    );
  }

  const conditionLists = listsFor(fromTable(statements, "transaction_conditions"), '"transaction_id"');
  assert.equal(conditionLists.length, 2, "transaction ids are chunked the same way");
  assert.ok(conditionLists.every((list) => list.length === 1));

  const workflowLists = listsFor(statements, '"workflows"\\."property_id"');
  assert.equal(workflowLists.length, 3);
  assert.ok(workflowLists.every((list) => list.length === 1));

  const propertyIdLists = listsFor(statements, '"property_id"');
  assert.ok(propertyIdLists.every((list) => list.length <= 1));

  const ids = new Set(result.today.concat(result.comingUp, result.overdue, result.completedToday).map((item) => item.id));
  assert.ok(ids.has(`AUTOMATION_TASK:${dueTodayTaskId}`));
  assert.ok(ids.has(`AUTOMATION_TASK:${comingUpTaskId}`));
  assert.ok(ids.has(`AUTOMATION_TASK:${completedTodayTaskId}`));
  assert.equal(ids.has(`AUTOMATION_TASK:${overdueTaskId}`), false);
  assert.equal(ids.has(`AUTOMATION_TASK:${completedYesterdayTaskId}`), false);
  assert.equal(ids.has(`AUTOMATION_TASK:${supersededTaskId}`), false);
  assert.equal(ids.has(`AUTOMATION_TASK:${foreignTaskId}`), false);
  assert.ok(ids.has(`CONTRACT_MILESTONE:${conditionId}`));
  assert.ok(ids.has(`CONTRACT_MILESTONE:${secondConditionId}`));
  assert.ok(ids.has(`WORKFLOW_ACTION:${stepId}`));
  assert.equal(
    result.activeProperties.some((property) => property.propertyId === otherPropertyId),
    false,
  );
  assert.deepEqual(
    result.activeProperties.map((property) => property.propertyId).sort((a, b) => a - b),
    [propertyA, propertyB, propertyC].sort((a, b) => a - b),
  );
});

test("a repeated restrict id does not open an extra chunk or leak another property", async () => {
  let result: Awaited<ReturnType<typeof getCommandCentre>> | undefined;
  const statements = await capture(async () => {
    result = await getCommandCentre(actor(), {
      now,
      canViewFinancials: true,
      restrictToPropertyIds: [propertyA, propertyA, propertyB],
      idChunkSize: 1,
    });
  });
  assert.ok(result);

  const propertyLoads = fromTable(statements, "properties").flatMap((statement) =>
    boundLists(statement.query, statement.params, '"properties"\\."id"'),
  );
  assert.equal(propertyLoads.length, 2, "duplicate ids are one slot, so two distinct ids are two chunks");
  assert.ok(propertyLoads.every((list) => list.length === 1));
  assert.deepEqual(propertyLoads.flat().sort((a, b) => a - b), [propertyA, propertyB].sort((a, b) => a - b));

  const ids = new Set(result.today.concat(result.comingUp, result.completedToday, result.overdue).map((item) => item.sourceRecordId));
  assert.ok(ids.has(dueTodayTaskId));
  assert.ok(ids.has(comingUpTaskId));
  assert.equal(ids.has(completedTodayTaskId), false, "property C is outside the restrict list");
  assert.equal(
    result.activeProperties.some((property) => property.propertyId === propertyC),
    false,
  );
});
