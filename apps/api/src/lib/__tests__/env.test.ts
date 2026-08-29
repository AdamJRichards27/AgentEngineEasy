import { test } from "node:test";
import assert from "node:assert/strict";

// Foundation Remediation Stage 1.5: prove the fail-closed gates in lib/env.ts
// actually default to disabled, and that only the exact literal "true" opens
// them - never an omitted variable, an empty string, or NODE_ENV being unset.
// Each test re-imports the module fresh (via a cache-busting query string)
// after mutating process.env, since isDevAuthEnabled() reads live env vars
// on every call rather than caching a value at import time.

async function freshEnvModule() {
  return import(`../env.js?t=${Date.now()}-${Math.random()}`);
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("isDevAuthEnabled is false when ALLOW_DEV_AUTH is unset (the default)", async () => {
  await withEnv({ ALLOW_DEV_AUTH: undefined, NODE_ENV: undefined }, async () => {
    const { isDevAuthEnabled } = await freshEnvModule();
    assert.equal(isDevAuthEnabled(), false);
  });
});

test("isDevAuthEnabled is false for any value other than the literal string 'true'", async () => {
  for (const value of ["1", "yes", "TRUE", "True", " true", "true "]) {
    await withEnv({ ALLOW_DEV_AUTH: value, NODE_ENV: undefined }, async () => {
      const { isDevAuthEnabled } = await freshEnvModule();
      assert.equal(isDevAuthEnabled(), false, `expected disabled for ALLOW_DEV_AUTH=${JSON.stringify(value)}`);
    });
  }
});

test("isDevAuthEnabled is true only with the explicit opt-in outside production", async () => {
  await withEnv({ ALLOW_DEV_AUTH: "true", NODE_ENV: undefined }, async () => {
    const { isDevAuthEnabled } = await freshEnvModule();
    assert.equal(isDevAuthEnabled(), true);
  });
});

test("isDevAuthEnabled is false when NODE_ENV=production, even with the opt-in set", async () => {
  await withEnv({ ALLOW_DEV_AUTH: "true", NODE_ENV: "production" }, async () => {
    const { isDevAuthEnabled } = await freshEnvModule();
    assert.equal(isDevAuthEnabled(), false);
  });
});

test("isProductionEnvironment is false when NODE_ENV is unset", async () => {
  await withEnv({ NODE_ENV: undefined }, async () => {
    const { isProductionEnvironment } = await freshEnvModule();
    assert.equal(isProductionEnvironment(), false);
  });
});

test("isInsecureCookieExplicitlyAllowed defaults to false and cannot be enabled in production", async () => {
  await withEnv({ ALLOW_INSECURE_DEV_COOKIES: undefined, NODE_ENV: undefined }, async () => {
    const { isInsecureCookieExplicitlyAllowed } = await freshEnvModule();
    assert.equal(isInsecureCookieExplicitlyAllowed(), false);
  });
  await withEnv({ ALLOW_INSECURE_DEV_COOKIES: "true", NODE_ENV: "production" }, async () => {
    const { isInsecureCookieExplicitlyAllowed } = await freshEnvModule();
    assert.equal(isInsecureCookieExplicitlyAllowed(), false);
  });
});
