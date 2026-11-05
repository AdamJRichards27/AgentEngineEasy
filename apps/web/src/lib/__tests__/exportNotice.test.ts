import { test } from "node:test";
import assert from "node:assert/strict";
import { exportNoticeText, formatExpiry } from "../exportNotice";

const n = { id: "export:5", kind: "export_ready" as const, exportId: 5, rows: 12, preparedAt: "2026-11-05T00:00:00.000Z", expiresAt: "2026-11-12T00:00:00.000Z", preparedBy: "Pete Crew", downloadPath: "/grow/contacts/exports/5/download" };

test("t277u export notice shows count, preparer and expiry in the given zone, never contact data", () => {
  const t = exportNoticeText(n, "Australia/Brisbane");
  assert.match(t, /12 contacts/);
  assert.match(t, /prepared by Pete Crew/);
  assert.ok(t.includes(formatExpiry(n.expiresAt, "Australia/Brisbane")));
  assert.match(formatExpiry(n.expiresAt, "Australia/Brisbane"), /12 Nov 2026/);
  assert.match(t, /expires and is deleted/);
  assert.equal(exportNoticeText({ ...n, rows: 1, preparedBy: "you" }, "UTC").includes("1 contact,"), true);
});
