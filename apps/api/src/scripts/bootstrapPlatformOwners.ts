/**
 * Explicit, development-only operator action; never imported by startup.
 * Secrets are consumed only to compute Argon2id hashes, never printed.
 * Does not assert email verification or accept legal terms for the user.
 *
 * Refuses unless all of these hold:
 * - PLATFORM_OWNER_BOOTSTRAP_ALLOWED is the literal string "true"
 * - --confirm-platform-owner-bootstrap is present
 * - NODE_ENV is not "production"
 * - REPLIT_DEPLOYMENT is unset (a deployment check that does not trust NODE_ENV)
 */
import { db, pool, users, brokerages, platformOwners, platformOwnerAudit } from "@aee/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hashPassword, passwordPolicyViolation } from "../lib/auth/password.js";

export function databaseTargetLabel(connectionString: string | undefined = process.env.DATABASE_URL): string {
  if (!connectionString) return "DATABASE_URL is not set";
  try {
    const url = new URL(connectionString);
    const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "(none)";
    return `host=${url.hostname || "(none)"} port=${url.port || "5432"} database=${database}`;
  } catch {
    return "DATABASE_URL is not a valid URL";
  }
}

/**
 * Null when the command may run. Otherwise a message safe to print:
 * no passwords, no connection string.
 */
export function platformOwnerBootstrapBlockReason(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string | null {
  const problems: string[] = [];
  if (env.PLATFORM_OWNER_BOOTSTRAP_ALLOWED !== "true") {
    problems.push("PLATFORM_OWNER_BOOTSTRAP_ALLOWED must be the literal string true");
  }
  if (!argv.includes("--confirm-platform-owner-bootstrap")) {
    problems.push("pass --confirm-platform-owner-bootstrap");
  }
  if (env.NODE_ENV === "production") problems.push("NODE_ENV is production");
  if (env.REPLIT_DEPLOYMENT) {
    problems.push("REPLIT_DEPLOYMENT is set; this is a deployment environment, which NODE_ENV alone does not identify");
  }
  if (problems.length === 0) return null;
  return (
    `Refusing platform owner bootstrap: ${problems.join("; ")}. ` +
    "This command runs only in a non-production, non-deployment environment with PLATFORM_OWNER_BOOTSTRAP_ALLOWED=true."
  );
}

function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

async function main() {
  const blocked = platformOwnerBootstrapBlockReason();
  if (blocked) throw new Error(blocked);
  console.log(`Platform owner bootstrap target: ${databaseTargetLabel()}`);
  const accounts = [
    { email: process.argv.find(arg => arg.startsWith("--first-email="))?.slice("--first-email=".length), key: "OWNER_AGENTENGINE_INITIAL_PASSWORD" },
    { email: process.argv.find(arg => arg.startsWith("--second-email="))?.slice("--second-email=".length), key: "OWNER_AJRICHARDS_INITIAL_PASSWORD" },
  ];
  if (accounts.some(account => !account.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)) ||
      accounts[0]!.email!.toLowerCase() === accounts[1]!.email!.toLowerCase()) {
    throw new Error("Two distinct --first-email= and --second-email= arguments are required.");
  }
  const passwords = accounts.map(account => process.env[account.key]);
  if (passwords.some(value => !value || value.length < 16 || passwordPolicyViolation(value))) {
    throw new Error("Both setup passwords must be present, satisfy the password policy, and contain at least 16 characters.");
  }
  if (passwords[0] === passwords[1]) throw new Error("Use distinct passwords for the two Owner accounts.");
  const hashes = await Promise.all(passwords.map(password => hashPassword(password!)));
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(83427019)`);
    const matches = await tx.select().from(brokerages).where(eq(brokerages.name, "AgentEngineOwner"));
    if (matches.length > 1) throw new Error("Ambiguous Owner home brokerage; no changes applied.");
    const home = matches[0] ?? (await tx.insert(brokerages).values({ name: "AgentEngineOwner" }).returning())[0]!;
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i]!;
      const email = account.email!.toLowerCase();
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing) throw new Error("A requested identity already exists; refusing to overwrite its credentials or silently elevate it.");
      const [created] = await tx.insert(users).values({
        email, authProviderId: `owner-bootstrap:${randomUUID()}`,
        firstName: "Adam", lastName: "", role: "Brokerage Administrator",
        brokerageId: home.id, isActive: true, passwordHash: hashes[i],
      }).returning({ id: users.id });
      await tx.insert(platformOwners).values({ userId: created!.id });
      await tx.insert(platformOwnerAudit).values({
        ownerUserId: created!.id, brokerageId: home.id, action: "owner_provisioned_by_operator",
        method: "OPERATOR", surface: "bootstrap",
      });
    }
  });
  console.log("Created two Platform Owner accounts in AgentEngineOwner. Legal acceptance is still required at sign-in.");
}
if (invokedAsScript()) {
  main().catch(error => {
    // Database exceptions can embed row values; never print those.
    console.error(error instanceof Error && !("query" in error) && !("cause" in error) && !("code" in error)
      ? error.message : "Owner setup failed; transaction rolled back. No credentials were printed.");
    process.exitCode = 1;
  }).finally(() => pool.end());
}
