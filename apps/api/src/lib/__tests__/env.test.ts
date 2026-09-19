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

// AE GROW Pilot Readiness WP2a — live-provider locks apply in EVERY
// environment (previously LIVE_VOICE_TRANSCRIPTION and LIVE_TELEPHONY were
// production-only), and the new LIVE_AI_PROVIDER_APPROVED gate behaves the
// same way. Only the literal "true" opens any of them.
const LIVE_LOCKS = [
  { flag: "LIVE_VOICE_TRANSCRIPTION_APPROVED", fn: "mustForceMockVoiceTranscriptionProvider" },
  { flag: "LIVE_TELEPHONY_APPROVED", fn: "mustForceMockTelephonyProvider" },
  { flag: "LIVE_CALL_TRANSCRIPTION_APPROVED", fn: "mustForceMockCallTranscriptionProvider" },
  { flag: "LIVE_AI_PROVIDER_APPROVED", fn: "mustForceMockAiProvider" },
] as const;

for (const { flag, fn } of LIVE_LOCKS) {
  test(`${fn} stays locked in every environment unless ${flag} is exactly 'true'`, async () => {
    for (const nodeEnv of [undefined, "development", "test", "staging", "production"]) {
      for (const value of [undefined, "", "1", "yes", "TRUE", " true", "false"]) {
        await withEnv({ NODE_ENV: nodeEnv, [flag]: value }, async () => {
          const mod = await freshEnvModule();
          assert.equal(mod[fn](), true, `${fn} must be locked for NODE_ENV=${nodeEnv ?? "(unset)"} ${flag}=${JSON.stringify(value)}`);
        });
      }
      await withEnv({ NODE_ENV: nodeEnv, [flag]: "true" }, async () => {
        const mod = await freshEnvModule();
        assert.equal(mod[fn](), false, `${fn} opens with ${flag}=true for NODE_ENV=${nodeEnv ?? "(unset)"}`);
      });
    }
  });
}

test("each live-provider approval flag unlocks only its own lock", async () => {
  for (const { flag } of LIVE_LOCKS) {
    const vars: Record<string, string | undefined> = { NODE_ENV: "production" };
    for (const other of LIVE_LOCKS) vars[other.flag] = other.flag === flag ? "true" : undefined;
    await withEnv(vars, async () => {
      const mod = await freshEnvModule();
      for (const other of LIVE_LOCKS) {
        assert.equal(mod[other.fn](), other.flag !== flag, `${flag}=true must not change ${other.fn}`);
      }
    });
  }
});
