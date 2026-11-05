import { test } from "node:test";
import assert from "node:assert/strict";
import { tapToCallPath, tapToCallView } from "../../minimal/tapToCallModel";

test("t239u: a server-issued tel: href renders Call with no warning or restriction text", () => {
  assert.deepEqual(tapToCallView({ available: true, reason: "AVAILABLE", telHref: "tel:+61400222333" }), { kind: "call", href: "tel:+61400222333" });
  assert.equal(tapToCallPath(7), "/parties/7/tap-to-call");
});

test("t239u: never a link for a non-tel href; no phone or no answer (unauthorised) hides it", () => {
  assert.equal(tapToCallView({ available: true, reason: "AVAILABLE", telHref: "javascript:alert(1)" }).kind, "hidden");
  assert.equal(tapToCallView({ available: false, reason: "NO_PHONE" }).kind, "hidden");
  assert.equal(tapToCallView(null).kind, "hidden");
  assert.equal(tapToCallView(undefined).kind, "hidden");
});

test("t239u: the view has no consent/DNC/suppression states at all", async () => {
  const fs = await import("node:fs");
  const url = await import("node:url");
  const src = fs.readFileSync(url.fileURLToPath(new URL("../../minimal/tapToCallModel.ts", import.meta.url)), "utf8")
    + fs.readFileSync(url.fileURLToPath(new URL("../../minimal/TapToCall.tsx", import.meta.url)), "utf8");
  for (const s of ["NO_CONSENT", "CONSENT_WITHDRAWN", "DO_NOT_CALL", "SUPPRESSED", "DNCR_LISTED", "Consent not recorded", "confirm("]) assert.ok(!src.includes(s), s);
});

test("t249u: a masked number is NEVER a Call action, even if a malformed answer also carries a tel:", () => {
  assert.equal(tapToCallView({ available: false, reason: "MASKED", masked: true, display: "***156", telHref: null }).kind, "hidden");
  assert.equal(tapToCallView({ available: true, reason: "AVAILABLE", masked: true, display: "***156", telHref: "tel:0491570156" }).kind, "hidden");
  assert.equal(tapToCallView({ available: true, reason: "MASKED", telHref: "tel:0491570156" }).kind, "hidden");
  assert.equal(tapToCallView({ available: true, reason: "AVAILABLE", telHref: "tel:***156" }).kind, "hidden");
});
