// AE GROW Priority 6 Stage F1 — §10, §22 sandbox provider tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SandboxTelephonyProvider, sandboxProviderCallId } from "../sandboxProvider.js";

test("dial() never throws and returns a deterministic providerCallId derived from the call session id", async () => {
  const provider = new SandboxTelephonyProvider();
  const result = await provider.dial({ callSessionId: 42, brokerageId: 1, destinationE164: "+61412345678" });
  assert.equal(result.providerCallId, sandboxProviderCallId(42));
  assert.equal(result.providerCallId, "sandbox_call_42");
});

test("dial() is deterministic — the same call session id always produces the same providerCallId", async () => {
  const provider = new SandboxTelephonyProvider();
  const first = await provider.dial({ callSessionId: 7, brokerageId: 1, destinationE164: "+61412345678" });
  const second = await provider.dial({ callSessionId: 7, brokerageId: 1, destinationE164: "+61412345678" });
  assert.equal(first.providerCallId, second.providerCallId);
});

test("different call session ids never collide", async () => {
  const provider = new SandboxTelephonyProvider();
  const a = await provider.dial({ callSessionId: 1, brokerageId: 1, destinationE164: "+61412345678" });
  const b = await provider.dial({ callSessionId: 2, brokerageId: 1, destinationE164: "+61412345678" });
  assert.notEqual(a.providerCallId, b.providerCallId);
});
