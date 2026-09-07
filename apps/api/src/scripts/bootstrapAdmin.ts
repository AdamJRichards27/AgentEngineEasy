#!/usr/bin/env node
/**
 * Critical Blocker Remediation, Phase 4 — one-time admin bootstrap.
 *
 * A brand-new pilot database has zero users, so nothing can invite the
 * first admin (invitations are always issued BY an existing admin — see
 * routes/auth.ts POST /admin/invitations). This script is the one
 * deliberate, explicit, human-operated exception to "admin-issued
 * invitations only" — see docs/gate-evidence/PHASE2_AUTHENTICATION_DESIGN.md
 * §7 for the full design this implements.
 *
 * Usage (documented in full in docs/REPLIT_PILOT_DEPLOYMENT_RUNBOOK.md):
 *
 *   pnpm --filter @aee/api run bootstrap-admin -- \
 *     --email admin@youragency.com.au --brokerage "Your Agency"
 *
 * Deliberately NOT run as part of ordinary `npm start`/boot (it lives in
 * scripts/, is not imported by index.ts, and requires explicit flags to do
 * anything). Refuses to run at all with no flags. Prompts for the password
 * via a non-echoing stdin read — the password is NEVER accepted as a CLI
 * argument, so it can never land in shell history, a process list
 * (`ps aux`), or a CI log of the invoking command.
 */
import { createInterface } from "node:readline";
import { db, users, brokerages } from "@aee/db";
import { eq } from "drizzle-orm";
import { hashPassword, passwordPolicyViolation } from "../lib/auth/password.js";
import { logAudit } from "../lib/audit.js";

function parseArgs(argv: string[]): { email?: string; brokerage?: string } {
  const out: { email?: string; brokerage?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--email") out.email = argv[++i];
    else if (argv[i] === "--brokerage") out.brokerage = argv[++i];
  }
  return out;
}

/** Reads a line from stdin without echoing it to the terminal. */
async function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Node has no built-in "hidden input" mode for readline; muting the
    // output stream's write during this one question is the standard
    // workaround (same technique used by, e.g., npm's own CLI prompts).
    const anyRl = rl as unknown as { _writeToOutput?: (s: string) => void };
    let muted = false;
    anyRl._writeToOutput = function (stringToWrite: string) {
      if (!muted) (rl as unknown as { output: NodeJS.WritableStream }).output.write(stringToWrite);
    };
    process.stdout.write(prompt);
    muted = true;
    rl.question("", (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const { email, brokerage } = parseArgs(process.argv.slice(2));
  if (!email || !brokerage) {
    console.error(
      "Usage: pnpm --filter @aee/api run bootstrap-admin -- --email <email> --brokerage <name>\n" +
        "Both flags are required. This command refuses to run without them — it never runs implicitly.",
    );
    process.exitCode = 1;
    return;
  }
  const normalizedEmail = email.toLowerCase();

  const [existingUser] = await db.select().from(users).where(eq(users.email, normalizedEmail));
  if (existingUser) {
    console.error(`Refusing: a user with email ${normalizedEmail} already exists (id ${existingUser.id}). This command cannot overwrite an existing account.`);
    process.exitCode = 1;
    return;
  }

  let [brokerageRow] = await db.select().from(brokerages).where(eq(brokerages.name, brokerage));
  if (brokerageRow) {
    const [existingAdmin] = await db
      .select()
      .from(users)
      .where(eq(users.brokerageId, brokerageRow.id));
    if (existingAdmin) {
      console.error(
        `Refusing: brokerage "${brokerage}" already has at least one user (id ${existingAdmin.id}). ` +
          "This command only bootstraps the FIRST admin for a brand-new brokerage — use an in-app " +
          "invitation (POST /auth/admin/invitations) to add anyone after that.",
      );
      process.exitCode = 1;
      return;
    }
  }

  const password = await readSecret(`Set a password for ${normalizedEmail}: `);
  const confirm = await readSecret("Confirm password: ");
  if (password !== confirm) {
    console.error("Passwords did not match. No account was created.");
    process.exitCode = 1;
    return;
  }
  const policyViolation = passwordPolicyViolation(password);
  if (policyViolation) {
    console.error(`Refusing: ${policyViolation}`);
    process.exitCode = 1;
    return;
  }

  if (!brokerageRow) {
    [brokerageRow] = await db.insert(brokerages).values({ name: brokerage }).returning();
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();
  const [created] = await db
    .insert(users)
    .values({
      authProviderId: `bootstrap:${normalizedEmail}`,
      email: normalizedEmail,
      firstName: "",
      lastName: "",
      role: "Brokerage Administrator",
      brokerageId: brokerageRow.id,
      passwordHash,
      // A deliberate CLI command run by an operator on a trusted machine is
      // a different trust boundary than an unverified public signup —
      // treated as verified immediately (Phase 2 design §7).
      emailVerifiedAt: now,
    })
    .returning();

  await logAudit({
    userId: created.id,
    userEmail: created.email,
    action: "admin_bootstrapped",
    recordType: "user",
    recordId: String(created.id),
  });

  console.log(`Created Brokerage Administrator ${normalizedEmail} for brokerage "${brokerageRow.name}" (user id ${created.id}).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("bootstrap-admin failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
