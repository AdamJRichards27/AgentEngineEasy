#!/usr/bin/env node
/**
 * AE 2.0 Integrated Testing Release 1 (Owner t246u) — synthetic seed for the
 * DEDICATED TESTING DATABASE ONLY. Never imported by the app, never run at boot.
 *
 * Refuses to run unless ALL of these hold:
 *   1. The database carries the testing marker created by the admin:
 *        CREATE SCHEMA IF NOT EXISTS ae_env;
 *        CREATE TABLE IF NOT EXISTS ae_env.marker (env text PRIMARY KEY CHECK (env = 'testing'),
 *          db_name text NOT NULL, marked_at timestamptz NOT NULL DEFAULT now());
 *        INSERT INTO ae_env.marker (env, db_name) VALUES ('testing', current_database());
 *      and marker.db_name = current_database().
 *   2. SEED_TESTING_ENV_CONFIRM equals current_database().
 *   3. No non-synthetic data: every existing user's email ends with the synthetic
 *      domain and every existing brokerage name starts with "SYNTH ".
 *   4. No SYNTH brokerage exists yet (re-seed = reset first; see TESTING-DB-RUNBOOK).
 *
 * Passwords are generated here and written ONLY to SEED_CREDENTIALS_FILE (created
 * with O_EXCL, mode 0600). Nothing secret is printed. All people, phones (ACMA
 * fictitious 0491 57x xxx mobiles, then (07) 5550 xxxx), emails and addresses are fictional.
 *
 * Entitlements are SIMULATED via entitlement_grants (sourceType admin_override /
 * migration), never via billing or mock checkout:
 *   - SYNTH Realty Brisbane: user-level grants (so one brokerage can hold Grow,
 *     Run, read-only and unsubscribed users side by side).
 *   - SYNTH Coastal Property (second brokerage): brokerage-level Grow only.
 *   - SYNTH Legacy Run Agency: brokerage-level run.access, sourceType "migration"
 *     (the exact shape the boot-time run.access backfill writes) and NO grow.* keys.
 * Brokerages that must NOT have Run get a Revoked brokerage-level run.access row,
 * because ensureRunAccessBackfilled() grants run.access at boot to any brokerage
 * with no run.access row at all.
 *
 * Usage (from the testing Repl shell only):
 *   SEED_TESTING_ENV_CONFIRM=<db name> SEED_CREDENTIALS_FILE=$HOME/.ae-testing-credentials \
 *     pnpm --filter @aee/api exec tsx src/scripts/seedTestingEnv.ts
 */
import { randomBytes } from "node:crypto";
import { openSync, writeSync, closeSync, fchmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sql, like, notLike } from "drizzle-orm";
import { db, users, brokerages, entitlementGrants, properties, parties, propertyParties, growContactChannelConsents, growContactChannelSuppressions, growContactDncrStatuses, ENTITLEMENT_KEYS } from "@aee/db";
import { hashPassword, passwordPolicyViolation } from "../lib/auth/password.js";

export const SYNTH_PREFIX = "SYNTH ";
export const EMAIL_DOMAIN = (process.env.SEED_EMAIL_DOMAIN ?? "agentengine-testing.invalid").toLowerCase();

// ACMA-published fictitious mobile numbers (for drama/testing). Verify against the current ACMA list.
export const FICTIONAL_MOBILES = [
  "0491 570 006", "0491 570 156", "0491 570 157", "0491 570 158", "0491 570 159", "0491 570 110",
  "0491 570 313", "0491 570 737", "0491 571 266", "0491 571 491", "0491 571 804", "0491 572 549",
  "0491 572 665", "0491 572 983", "0491 573 770", "0491 573 087", "0491 574 118", "0491 574 632",
  "0491 575 254", "0491 575 789", "0491 576 398", "0491 576 801", "0491 577 426", "0491 577 644",
  "0491 578 957", "0491 578 148", "0491 578 888", "0491 579 212", "0491 579 760", "0491 579 455",
];
const FIRST = ["Maya", "Liam", "Aisha", "Noah", "Priya", "Oscar", "Mei", "Jack", "Zara", "Tom", "Ivy", "Ravi", "Chloe", "Sam", "Nina", "Ethan", "Lena", "Kai", "Ruby", "Finn"];
const LAST = ["Okafor", "Nguyen", "Brennan", "Patel", "Kowalski", "Haddad", "Fraser", "Lindqvist", "Moreau", "Tanaka", "Walsh", "Costa", "Ibrahim", "Reyes", "Sutherland"];
const STREETS = ["Synthetic St", "Example Ave", "Testing Rd", "Fictional Pde", "Sample Cres", "Mockingbird Ln"];
const SUBURBS = [["Paddington", "4064"], ["New Farm", "4005"], ["Bulimba", "4171"], ["Ashgrove", "4060"], ["Coorparoo", "4151"], ["Mermaid Beach", "4218"], ["Noosa Heads", "4567"]] as const;
const ROLES = ["Owner", "Seller", "Buyer", "Tenant", "Landlord", "Solicitor", "PowerOfAttorney", "Other"] as const;

const GROW_KEYS = ENTITLEMENT_KEYS.filter((k) => k.startsWith("grow.") && k !== "grow.calling.recording" && k !== "grow.calling.transcription");
const READ_ONLY_KEYS = ["grow.access", "grow.contacts.read", "grow.propertyIntelligence.read"];

type Profile = "admin" | "grow" | "run" | "runonly" | "readonly" | "unsubscribed";
interface Account { handle: string; first: string; last: string; role: "Agent" | "Brokerage Administrator" | "Pit Crew"; profile: Profile }
interface Plan { name: string; mode: "user" | "brokerage-grow" | "legacy-run"; accounts: Account[]; properties: number; contacts: number }

export const PLAN: Plan[] = [
  {
    name: `${SYNTH_PREFIX}Realty Brisbane`, mode: "user", properties: 30, contacts: 90,
    accounts: [
      { handle: "admin.a", first: "Ada", last: "Admin", role: "Brokerage Administrator", profile: "admin" },
      { handle: "grow1.a", first: "Gina", last: "Grow", role: "Agent", profile: "grow" },
      { handle: "grow2.a", first: "Gus", last: "Grow", role: "Agent", profile: "grow" },
      { handle: "run1.a", first: "Rhea", last: "Run", role: "Agent", profile: "run" },
      { handle: "run2.a", first: "Rory", last: "Run", role: "Agent", profile: "run" },
      { handle: "readonly.a", first: "Rita", last: "Readonly", role: "Agent", profile: "readonly" },
      { handle: "unsub.a", first: "Ulla", last: "Unsubscribed", role: "Agent", profile: "unsubscribed" },
      // t257u: Pit Crew without contact-read (Tap-to-Call MASKED case).
      { handle: "pitcrew.a", first: "Pia", last: "Crew", role: "Pit Crew", profile: "runonly" },
    ],
  },
  {
    name: `${SYNTH_PREFIX}Coastal Property`, mode: "brokerage-grow", properties: 10, contacts: 30,
    accounts: [
      { handle: "admin.b", first: "Bea", last: "Coastal", role: "Brokerage Administrator", profile: "grow" },
      { handle: "grow1.b", first: "Ben", last: "Coastal", role: "Agent", profile: "grow" },
    ],
  },
  {
    name: `${SYNTH_PREFIX}Legacy Run Agency`, mode: "legacy-run", properties: 8, contacts: 24,
    accounts: [
      { handle: "legacy.admin.c", first: "Leo", last: "Legacy", role: "Brokerage Administrator", profile: "run" },
      { handle: "legacy.agent.c", first: "Lara", last: "Legacy", role: "Agent", profile: "run" },
    ],
  },
];

/** t257u: named scenario contacts (fictional ACMA (07) 5550 9xxx range, outside the generated 5550 0xxx numbers). */
export const SCENARIOS: { last: string; mobile: string | null; state?: "withdrawn" | "noconsent" | "suppressed" | "register" }[] = [
  { last: "Extension", mobile: "(07) 5550 9001 ext 12" },
  { last: "HashNote", mobile: "(07) 5550 9002 #4" },
  { last: "NoPhone", mobile: null },
  { last: "NotApplicable", mobile: "n/a" },
  { last: "TooShort", mobile: "12345" },
  { last: "PartialMask", mobile: "(07) 5550 9***" },
  { last: "International", mobile: "+61 7 5550 9007" },
  { last: "Withdrawn", mobile: "(07) 5550 9008", state: "withdrawn" },
  { last: "NoConsent", mobile: "(07) 5550 9009", state: "noconsent" },
  { last: "Suppressed", mobile: "(07) 5550 9010", state: "suppressed" },
  { last: "OnRegister", mobile: "(07) 5550 9011", state: "register" },
];

export function generatePassword(): string {
  for (;;) {
    const p = randomBytes(18).toString("base64url");
    if (!passwordPolicyViolation(p)) return p;
  }
}

export function keysFor(profile: Profile): string[] {
  switch (profile) {
    case "admin": return ["run.access", ...GROW_KEYS];
    case "run": return ["run.access", ...GROW_KEYS]; // Pro + Grow bundle shape, simulated (no billing)
    case "grow": return [...GROW_KEYS];
    case "runonly": return ["run.access"];
    case "readonly": return [...READ_ONLY_KEYS];
    case "unsubscribed": return [];
  }
}

async function guard(): Promise<string> {
  const [{ name }] = (await db.execute(sql`select current_database() as name`)).rows as { name: string }[];
  const confirm = process.env.SEED_TESTING_ENV_CONFIRM;
  if (!confirm || confirm !== name) throw new Error("Refusing: SEED_TESTING_ENV_CONFIRM must equal the current database name.");
  let marker: { env: string; db_name: string } | undefined;
  try {
    marker = ((await db.execute(sql`select env, db_name from ae_env.marker where env = 'testing'`)).rows as { env: string; db_name: string }[])[0];
  } catch {
    marker = undefined;
  }
  if (!marker || marker.db_name !== name) throw new Error("Refusing: database is not flagged as the testing database (ae_env.marker).");
  const foreignUsers = await db.select({ id: users.id }).from(users).where(notLike(users.email, `%@${EMAIL_DOMAIN}`)).limit(1);
  const foreignBrokerages = await db.select({ id: brokerages.id }).from(brokerages).where(notLike(brokerages.name, `${SYNTH_PREFIX}%`)).limit(1);
  if (foreignUsers.length || foreignBrokerages.length) throw new Error("Refusing: database contains non-synthetic users or brokerages.");
  const already = await db.select({ id: brokerages.id }).from(brokerages).where(like(brokerages.name, `${SYNTH_PREFIX}%`)).limit(1);
  if (already.length) throw new Error("Refusing: synthetic data already present. Reset the testing database first.");
  return name;
}

export function fictionalPhone(n: number): string {
  if (n < FICTIONAL_MOBILES.length) return FICTIONAL_MOBILES[n];
  return `(07) 5550 ${String(n - FICTIONAL_MOBILES.length).padStart(4, "0")}`;
}

function pick<T>(xs: readonly T[], i: number): T { return xs[i % xs.length]; }

async function main() {
  const dbName = await guard();
  const credPath = process.env.SEED_CREDENTIALS_FILE ?? path.join(homedir(), ".ae-testing-credentials");
  const fd = openSync(credPath, "wx", 0o600); // fails if it exists: never overwrite or widen an old file
  fchmodSync(fd, 0o600);
  writeSync(fd, `# AE testing credentials (synthetic accounts) for database ${dbName}. Keep private; delete after distribution.\n`);
  let phone = 0;
  const counts = { brokerages: 0, users: 0, grants: 0, properties: 0, contacts: 0, scenarios: 0, links: 0 };
  try {
    for (const plan of PLAN) {
      const [b] = await db.insert(brokerages).values({ name: plan.name }).returning();
      counts.brokerages++;
      const grant = async (key: string, granteeType: "brokerage" | "user", granteeId: number, status = "Active", sourceType = "admin_override") => {
        await db.insert(entitlementGrants).values({ brokerageId: b.id, entitlementKey: key, granteeType, granteeId, sourceType, status, configuration: { syntheticTesting: true } });
        counts.grants++;
      };
      if (plan.mode === "legacy-run") await grant("run.access", "brokerage", b.id, "Active", "migration");
      else await grant("run.access", "brokerage", b.id, "Revoked"); // blocks the boot-time run.access backfill
      if (plan.mode === "brokerage-grow") for (const k of GROW_KEYS) await grant(k, "brokerage", b.id);
      const agentIds: number[] = [];
      let readonlyId: number | null = null;
      for (const a of plan.accounts) {
        const email = `${a.handle}@${EMAIL_DOMAIN}`;
        const password = generatePassword();
        const [u] = await db.insert(users).values({
          authProviderId: `synthetic-seed:${email}`, email, firstName: a.first, lastName: a.last, role: a.role,
          brokerageId: b.id, passwordHash: await hashPassword(password), emailVerifiedAt: new Date(),
        }).returning();
        counts.users++;
        if (plan.mode === "user") for (const k of keysFor(a.profile)) await grant(k, "user", u.id);
        if (a.profile === "readonly" && readonlyId === null) readonlyId = u.id;
        if (a.profile !== "readonly" && a.profile !== "unsubscribed" && a.role !== "Pit Crew") agentIds.push(u.id);
        writeSync(fd, `${plan.name}\t${a.profile}\t${a.role}\t${email}\t${password}\n`);
      }
      const propIds: { id: number; agentId: number }[] = [];
      for (let i = 0; i < plan.properties; i++) {
        const [sub, pc] = pick(SUBURBS, i + counts.properties);
        const agentId = pick(agentIds, i);
        const [p] = await db.insert(properties).values({
          brokerageId: b.id, agentId, formattedAddress: `${10 + i} ${pick(STREETS, i)}, ${sub} QLD ${pc}`,
          suburb: sub, state: "QLD", postcode: pc, isManualAddress: true,
        }).returning();
        propIds.push({ id: p.id, agentId });
        counts.properties++;
      }
      const partyIds: number[] = [];
      let prev: { mobile: string; email: string } | null = null;
      for (let i = 0; i < plan.contacts; i++) {
        const first = pick(FIRST, i + counts.contacts); const last = pick(LAST, i * 7 + counts.contacts);
        // Fictional numbers only: ACMA drama mobiles first, then the ACMA fictitious (07) 5550 xxxx range.
        const fresh = { mobile: fictionalPhone(phone++), email: `${first.toLowerCase()}.${last.toLowerCase()}.${counts.contacts}@${EMAIL_DOMAIN}` };
        // every 15th contact deliberately reuses the previous contact's phone and email (duplicate-warning tests)
        const contact = i % 15 === 14 && prev ? prev : fresh;
        const [c] = await db.insert(parties).values({ brokerageId: b.id, partyType: "Person", firstName: first, lastName: last, mobile: contact.mobile, email: contact.email }).returning();
        prev = fresh;
        partyIds.push(c.id);
        counts.contacts++;
      }
      // 2–3 links per property, at most one primary per (property, role), no duplicate (property, party, role).
      for (let i = 0; i < propIds.length; i++) {
        const used = new Set<string>();
        const n = 2 + (i % 2);
        for (let j = 0; j < n; j++) {
          const role = pick(ROLES, i + j);
          const partyId = pick(partyIds, i * 3 + j);
          const key = `${partyId}:${role}`;
          if (used.has(key)) continue;
          used.add(key);
          await db.insert(propertyParties).values({ propertyId: propIds[i].id, partyId, role, isPrimary: j === 0 && role !== "Other" });
          counts.links++;
        }
      }
      // A contact linked to two properties (two-way relationship checks).
      if (propIds.length > 1) {
        await db.insert(propertyParties).values({ propertyId: propIds[1].id, partyId: partyIds[0], role: "Buyer", isPrimary: false }).onConflictDoNothing();
        counts.links++;
      }
      // t257u (review 8 section 5): named scenario contacts, per brokerage, for Tap-to-Call and consent cases.
      const recorder = agentIds[0];
      const scenarioIds: number[] = [];
      for (const sc of SCENARIOS) {
        const [c] = await db.insert(parties).values({ brokerageId: b.id, partyType: "Person", firstName: "Scenario", lastName: sc.last, mobile: sc.mobile, email: null }).returning();
        scenarioIds.push(c.id);
        counts.contacts++;
        counts.scenarios++;
        const common = { brokerageId: b.id, partyId: c.id, channel: "PHONE_CALL", recordedByUserId: recorder };
        if (sc.state === "withdrawn") await db.insert(growContactChannelConsents).values({ ...common, state: "WITHDRAWN", source: "SYNTHETIC_SEED", captureMethod: "SYNTHETIC_SEED", purpose: "TAP_TO_CALL", scope: "PHONE_CALL", withdrawnAt: new Date(), withdrawnByUserId: recorder, withdrawalReason: "Synthetic: contact withdrew consent" });
        if (sc.state === "noconsent") await db.insert(growContactChannelConsents).values({ ...common, state: "NONE", source: "SYNTHETIC_SEED", captureMethod: "SYNTHETIC_SEED", purpose: "TAP_TO_CALL", scope: "PHONE_CALL" });
        if (sc.state === "suppressed") await db.insert(growContactChannelSuppressions).values({ ...common, state: "SUPPRESSED", reason: "Synthetic: do not call" });
        if (sc.state === "register") await db.insert(growContactDncrStatuses).values({ ...common, status: "LISTED", source: "SYNTHETIC_SEED" });
      }
      // t257u: the read-only agent owns one property with a linked scenario contact (can open a property page).
      if (readonlyId !== null) {
        const [p] = await db.insert(properties).values({ brokerageId: b.id, agentId: readonlyId, formattedAddress: `1 Readonly Lane, ${SUBURBS[0][0]} QLD ${SUBURBS[0][1]}`, suburb: SUBURBS[0][0], state: "QLD", postcode: SUBURBS[0][1], isManualAddress: true }).returning();
        counts.properties++;
        await db.insert(propertyParties).values({ propertyId: p.id, partyId: scenarioIds[0], role: "Owner", isPrimary: true });
        counts.links++;
      }
    }
  } finally {
    closeSync(fd);
  }
  process.stdout.write(`${JSON.stringify({ event: "synthetic_seed_complete", database: dbName, ...counts, credentialsFile: credPath, credentialsMode: "0600" })}\n`);
  process.exit(0);
}

if (process.argv[1] && /seedTestingEnv\.(ts|js|mjs)$/.test(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`seed-testing-env refused or failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
