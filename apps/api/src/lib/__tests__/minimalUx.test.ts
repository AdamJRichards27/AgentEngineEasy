import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMinimalUxAllowlisted,
  isMinimalUxFlagEnabled,
  minimalUxClientPayload,
  parseMinimalUxAllowlist,
  parseMinimalUxViewCookie,
  resolveMinimalUx,
} from "../minimalUx.js";

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(previous)) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const off = { AE_MINIMAL_UX_ENABLED: undefined, AE_MINIMAL_UX_ALLOWLIST: undefined };

test("the flag defaults off and only the exact word true enables it", () => {
  for (const value of [undefined, "", "false", "1", "yes", " true "]) {
    withEnv({ AE_MINIMAL_UX_ENABLED: value }, () => {
      assert.equal(isMinimalUxFlagEnabled(), false);
    });
  }
  for (const value of ["true", "TRUE", "True"]) {
    withEnv({ AE_MINIMAL_UX_ENABLED: value }, () => {
      assert.equal(isMinimalUxFlagEnabled(), true);
    });
  }
});

test("the allowlist accepts emails and user ids and ignores everything else", () => {
  const list = parseMinimalUxAllowlist(" Ada@Example.com , 42, *, brokerage, 0, -3, 7 ");
  assert.equal(isMinimalUxAllowlisted({ id: 1, email: "ada@example.com" }, list), true);
  assert.equal(isMinimalUxAllowlisted({ id: 42, email: "other@example.com" }, list), true);
  assert.equal(isMinimalUxAllowlisted({ id: 7, email: "seven@example.com" }, list), true);
  assert.equal(isMinimalUxAllowlisted({ id: 9, email: "nobody@example.com" }, list), false);
  assert.equal(isMinimalUxAllowlisted({ id: 0, email: "" }, list), false);
  assert.equal(parseMinimalUxAllowlist(undefined).emails.size, 0);
  assert.equal(parseMinimalUxAllowlist("").userIds.size, 0);
});

test("flag off is classic for an allowlisted user and for everyone else", () => {
  withEnv({ ...off, AE_MINIMAL_UX_ALLOWLIST: "ada@example.com" }, () => {
    const named = resolveMinimalUx({ userId: 1, email: "ada@example.com" });
    const other = resolveMinimalUx({ userId: 2, email: "bee@example.com" });
    assert.equal(named.flagEnabled, false);
    assert.equal(named.allowlisted, true);
    assert.equal(named.eligible, false);
    assert.equal(named.variant, "classic");
    assert.equal(other.variant, "classic");
    assert.equal(other.eligible, false);
    assert.deepEqual(minimalUxClientPayload(named), { eligible: false, variant: "classic" });
    assert.equal("flagEnabled" in minimalUxClientPayload(named), false);
  });
});

test("flag on without this user on the allowlist stays classic", () => {
  withEnv({ AE_MINIMAL_UX_ENABLED: "true", AE_MINIMAL_UX_ALLOWLIST: "ada@example.com" }, () => {
    const other = resolveMinimalUx({ userId: 2, email: "bee@example.com" });
    assert.equal(other.flagEnabled, true);
    assert.equal(other.allowlisted, false);
    assert.equal(other.eligible, false);
    assert.equal(other.variant, "classic");
    assert.equal(resolveMinimalUx({ userId: 3, email: "bee@example.com", viewCookie: "3.minimal" }).variant, "classic");
  });
});

test("an allowlisted user gets the minimal shell unless they chose classic", () => {
  withEnv({ AE_MINIMAL_UX_ENABLED: "true", AE_MINIMAL_UX_ALLOWLIST: "ada@example.com, 8" }, () => {
    const byEmail = resolveMinimalUx({ userId: 1, email: "Ada@Example.com" });
    assert.equal(byEmail.eligible, true);
    assert.equal(byEmail.variant, "minimal");
    const byId = resolveMinimalUx({ userId: 8, email: "other@example.com" });
    assert.equal(byId.variant, "minimal");
    const classic = resolveMinimalUx({ userId: 1, email: "ada@example.com", viewCookie: "1.classic" });
    assert.equal(classic.eligible, true);
    assert.equal(classic.variant, "classic");
    const back = resolveMinimalUx({ userId: 1, email: "ada@example.com", viewCookie: "1.minimal" });
    assert.equal(back.variant, "minimal");
  });
});

test("another user's view cookie cannot change this user's shell", () => {
  withEnv({ AE_MINIMAL_UX_ENABLED: "true", AE_MINIMAL_UX_ALLOWLIST: "ada@example.com,bee@example.com" }, () => {
    const bee = resolveMinimalUx({ userId: 2, email: "bee@example.com", viewCookie: "1.classic" });
    assert.equal(bee.variant, "minimal");
    assert.equal(parseMinimalUxViewCookie("1.classic", 2), null);
    assert.equal(parseMinimalUxViewCookie("nope", 2), null);
    assert.equal(parseMinimalUxViewCookie("2.classic", 2), "classic");
  });
});
