import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLoginDestination } from "../../pages/Login";

const user = {
  id: 7,
  email: "agent@example.test",
  firstName: "Agent",
  lastName: "Example",
  brokerageId: 3,
  brokerageName: "Example Brokerage",
  role: "Agent",
};

test("login destination uses the authoritative session entitlements", () => {
  assert.equal(resolveLoginDestination({ user, entitlements: ["grow.access", "run.access"] }), "/grow");
  assert.equal(resolveLoginDestination({ user, entitlements: ["run.access"] }), "/today");
  assert.equal(resolveLoginDestination({ user: { ...user, role: "Pit Crew" }, entitlements: ["grow.access"] }), "/");
});