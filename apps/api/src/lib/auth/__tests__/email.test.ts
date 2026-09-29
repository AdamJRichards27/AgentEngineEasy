import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { logger } from "@aee/events";
import {
  SANDBOX_AUTH_EMAIL_PROVIDER_NAME,
  __clearSandboxAuthEmailLog,
  __getSandboxAuthEmailLog,
  assertAuthEmailProviderConfigured,
  getAuthEmailProvider,
  sandboxAuthEmailProvider,
} from "../email.js";

const AUTH_EMAIL_ENV_KEYS = ["NODE_ENV", "AUTH_EMAIL_PROVIDER", "PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED"] as const;

afterEach(() => {
  __clearSandboxAuthEmailLog();
});

async function withAuthEmailEnv(
  values: Record<(typeof AUTH_EMAIL_ENV_KEYS)[number], string | undefined>,
  run: () => void | Promise<void>,
): Promise<void> {
  const original = Object.fromEntries(AUTH_EMAIL_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of AUTH_EMAIL_ENV_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const key of AUTH_EMAIL_ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertUnknownProviderError(run: () => void, value: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`AUTH_EMAIL_PROVIDER="${escapeRegExp(value)}"`));
    assert.match(error.message, /Allowed values: sandbox_auth_email/);
    assert.equal(error.message.includes("is not configured for production"), false);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const invitation = {
  to: "person@example.com",
  brokerageName: "Example Brokerage",
  acceptUrl: "https://example.test/accept?token=secret",
  expiresAt: new Date("2026-01-01T00:00:00.000Z"),
};

async function captureWarnings(run: () => void | Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = logger.warn;
  logger.warn = (message: string) => {
    warnings.push(message);
  };
  try {
    await run();
    return warnings;
  } finally {
    logger.warn = original;
  }
}

test("unset, empty, and the sandbox name select the sandbox provider outside production", async () => {
  const selections = [undefined, "", SANDBOX_AUTH_EMAIL_PROVIDER_NAME] as const;
  for (const selection of selections) {
    await withAuthEmailEnv(
      {
        NODE_ENV: "test",
        AUTH_EMAIL_PROVIDER: selection,
        PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED: undefined,
      },
      () => {
        assert.doesNotThrow(() => assertAuthEmailProviderConfigured());
        assert.equal(getAuthEmailProvider(), sandboxAuthEmailProvider);
        assert.equal(getAuthEmailProvider().name, SANDBOX_AUTH_EMAIL_PROVIDER_NAME);
      },
    );
  }
});

test("an unknown AUTH_EMAIL_PROVIDER throws a startup error that names the variable, the value, and the allowed values", async () => {
  const unknownNames = ["resend", "sandbox", " sandbox_auth_email", "sandbox_auth_email "];
  for (const name of unknownNames) {
    await withAuthEmailEnv(
      {
        NODE_ENV: "development",
        AUTH_EMAIL_PROVIDER: name,
        PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED: "true",
      },
      () => {
        assertUnknownProviderError(() => assertAuthEmailProviderConfigured(), name);
        assertUnknownProviderError(() => getAuthEmailProvider(), name);
        assert.equal(__getSandboxAuthEmailLog().length, 0);
      },
    );
  }
});

test("an unknown provider does not send or log a hand-deliverable link", async () => {
  await withAuthEmailEnv(
    {
      NODE_ENV: "test",
      AUTH_EMAIL_PROVIDER: "postmark",
      PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED: "true",
    },
    async () => {
      const warnings = await captureWarnings(() => {
        assertUnknownProviderError(() => getAuthEmailProvider(), "postmark");
      });
      assert.equal(warnings.includes("pilot_mode_sandbox_email_link"), false);
      assert.equal(__getSandboxAuthEmailLog().length, 0);
    },
  );
});

test("production without the pilot acknowledgement refuses unset, empty, and the sandbox name", async () => {
  for (const acknowledgement of [undefined, "false", "TRUE"] as const) {
    for (const selection of [undefined, "", SANDBOX_AUTH_EMAIL_PROVIDER_NAME] as const) {
      await withAuthEmailEnv(
        {
          NODE_ENV: "production",
          AUTH_EMAIL_PROVIDER: selection,
          PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED: acknowledgement,
        },
        () => {
          assert.throws(() => assertAuthEmailProviderConfigured(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /AUTH_EMAIL_PROVIDER is not configured for production/);
            assert.match(error.message, /PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED=true/);
            return true;
          });
        },
      );
    }
  }
});

test("production with the pilot acknowledgement boots for unset, empty, and the sandbox name", async () => {
  for (const selection of [undefined, "", SANDBOX_AUTH_EMAIL_PROVIDER_NAME] as const) {
    await withAuthEmailEnv(
      {
        NODE_ENV: "production",
        AUTH_EMAIL_PROVIDER: selection,
        PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED: "true",
      },
      async () => {
        const warnings = await captureWarnings(() => {
          assert.doesNotThrow(() => assertAuthEmailProviderConfigured());
        });
        assert.ok(warnings.includes("pilot_mode_sandbox_email_active"));
        assert.equal(getAuthEmailProvider(), sandboxAuthEmailProvider);
      },
    );
  }
});

test("production refuses an unknown provider even when the pilot acknowledgement is set", async () => {
  await withAuthEmailEnv(
    {
      NODE_ENV: "production",
      AUTH_EMAIL_PROVIDER: "resend",
      PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED: "true",
    },
    async () => {
      const warnings = await captureWarnings(() => {
        assertUnknownProviderError(() => assertAuthEmailProviderConfigured(), "resend");
        assertUnknownProviderError(() => getAuthEmailProvider(), "resend");
      });
      assert.equal(warnings.includes("pilot_mode_sandbox_email_active"), false);
      assert.equal(warnings.includes("pilot_mode_sandbox_email_link"), false);
    },
  );
});

test("unset and the sandbox name still log pilot_mode_sandbox_email_link only when the acknowledgement is set", async () => {
  for (const selection of [undefined, SANDBOX_AUTH_EMAIL_PROVIDER_NAME] as const) {
    await withAuthEmailEnv(
      {
        NODE_ENV: "test",
        AUTH_EMAIL_PROVIDER: selection,
        PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED: "true",
      },
      async () => {
        __clearSandboxAuthEmailLog();
        const warnings = await captureWarnings(async () => {
          await getAuthEmailProvider().sendInvitation(invitation);
        });
        assert.ok(warnings.includes("pilot_mode_sandbox_email_link"));
        assert.equal(__getSandboxAuthEmailLog().length, 1);
        assert.equal(__getSandboxAuthEmailLog()[0]?.template, "invitation");
        assert.equal(__getSandboxAuthEmailLog()[0]?.to, invitation.to);
      },
    );

    await withAuthEmailEnv(
      {
        NODE_ENV: "test",
        AUTH_EMAIL_PROVIDER: selection,
        PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED: undefined,
      },
      async () => {
        __clearSandboxAuthEmailLog();
        const warnings = await captureWarnings(async () => {
          await getAuthEmailProvider().sendInvitation(invitation);
        });
        assert.equal(warnings.includes("pilot_mode_sandbox_email_link"), false);
        assert.equal(__getSandboxAuthEmailLog().length, 1);
      },
    );
  }
});
