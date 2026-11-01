import { test } from "node:test";
import assert from "node:assert/strict";
import { tapToCallPath, tapToCallView } from "../../minimal/tapToCallModel";

test("t236u: tel: link only for an available, server-issued tel: href", () => {
  assert.deepEqual(tapToCallView({ available: true, reason: "AVAILABLE", telHref: "tel:+61400222333", restrictions: "After 5pm" }), { kind: "call", href: "tel:+61400222333", restrictions: "After 5pm" });
  assert.equal(tapToCallView({ available: true, reason: "AVAILABLE", telHref: "javascript:alert(1)" }).kind, "unavailable");
  assert.equal(tapToCallPath(7), "/parties/7/tap-to-call");
});

test("t236u: withdrawn, do-not-call, suppressed, DNCR and no consent never render a link; no phone hides entirely", () => {
  for (const reason of ["CONSENT_WITHDRAWN", "DO_NOT_CALL", "SUPPRESSED", "DNCR_LISTED", "NO_CONSENT"] as const) {
    const v = tapToCallView({ available: false, reason, telHref: "tel:0400000111" });
    assert.equal(v.kind, "unavailable", reason);
  }
  assert.equal(tapToCallView({ available: false, reason: "NO_PHONE" }).kind, "hidden");
  assert.equal(tapToCallView(null).kind, "hidden");
});
