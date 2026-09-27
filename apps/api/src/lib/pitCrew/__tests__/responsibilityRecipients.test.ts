// R-F17 — display-name and list-cap rules for the recipient picker.
// These do not touch the database. The route suite covers brokerage scope,
// the role filter, and the flag gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RESPONSIBILITY_RECIPIENT_LIST_CAP,
  capOrderedResponsibilityRecipients,
  responsibilityUserDisplayName,
} from "../queries.js";
import { explicitResponsibilityRecipientRole } from "../responsibility.js";

test("explicit recipient roles match the resolver", () => {
  assert.equal(explicitResponsibilityRecipientRole("HAND_BACK"), "Agent");
  assert.equal(
    explicitResponsibilityRecipientRole("ESCALATION"),
    "Brokerage Administrator",
  );
  const queries = readFileSync(
    new URL("../queries.ts", import.meta.url),
    "utf8",
  );
  const responsibility = readFileSync(
    new URL("../responsibility.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    queries,
    /explicitResponsibilityRecipientRole\(kind === "HAND_BACK" \? "HAND_BACK" : "ESCALATION"\)/,
  );
  assert.match(
    responsibility,
    /explicitResponsibilityRecipientRole\(input\.kind\)/,
  );
  assert.match(
    responsibility,
    /explicitResponsibilityRecipientRole\("HAND_BACK"\)/,
  );
});

test("display name is First Last, then the email local part, then User id", () => {
  assert.equal(
    responsibilityUserDisplayName({
      id: 1,
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    }),
    "Ada Lovelace",
  );
  assert.equal(
    responsibilityUserDisplayName({
      id: 2,
      firstName: "Ada",
      lastName: "  ",
      email: "ada@example.com",
    }),
    "Ada",
  );
  assert.equal(
    responsibilityUserDisplayName({
      id: 3,
      firstName: "  ",
      lastName: "",
      email: "local.part@example.com",
    }),
    "local.part",
  );
  assert.equal(
    responsibilityUserDisplayName({
      id: 4,
      firstName: "",
      lastName: "",
      email: "@example.com",
    }),
    "User 4",
  );
  assert.equal(
    responsibilityUserDisplayName({
      id: 5,
      firstName: "",
      lastName: "",
      email: "",
    }),
    "User 5",
  );
});

test("recipient list orders by display name and caps at 500", () => {
  assert.equal(RESPONSIBILITY_RECIPIENT_LIST_CAP, 500);
  const tied = capOrderedResponsibilityRecipients([
    { userId: 9, displayName: "Same Name" },
    { userId: 2, displayName: "Same Name" },
    { userId: 4, displayName: "amy agent" },
  ]);
  assert.deepEqual(
    tied.map((row) => row.userId),
    [4, 2, 9],
  );

  const rows = Array.from({ length: 501 }, (_, index) => ({
    userId: index + 1,
    displayName: `User ${String(index + 1).padStart(4, "0")}`,
  }));
  const capped = capOrderedResponsibilityRecipients(rows);
  assert.equal(capped.length, 500);
  assert.equal(capped[0]?.displayName, "User 0001");
  assert.equal(capped[499]?.displayName, "User 0500");
  assert.equal(
    capped.some((row) => row.displayName === "User 0501"),
    false,
  );
});
