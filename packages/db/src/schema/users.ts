import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// AgentEngineEasy's role model is deliberately small (Build Brief §22) —
// grown later by deliberate decision, not accretion.
export const USER_ROLES = ["Agent", "Brokerage Administrator", "Pit Crew"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const brokerages = pgTable("brokerages", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Real first-class tenancy entity from day one — the prior Agent Engine
  // audit flagged "office = tenant by convention only" as a gap; not repeated here.
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  authProviderId: text("auth_provider_id").notNull().unique(),
  // Critical Blocker Remediation, Phase 4: email is now the account
  // identity for real (invitation/password) sign-in, so it must be unique
  // at the database level, not just "usually unique by dev-login's own
  // lookup-before-insert logic." See the Phase 4 migration's own comment
  // for the precondition this places on any environment with pre-existing
  // rows (none exist in any real environment as of this remediation).
  email: text("email").notNull().unique(),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  role: text("role").notNull().default("Agent"),
  brokerageId: integer("brokerage_id").references(() => brokerages.id),
  isActive: boolean("is_active").notNull().default(true),
  // Critical Blocker Remediation, Phase 4: Argon2id hash of the account's
  // password (see apps/api/src/lib/auth/password.ts). Null until an
  // invitation is accepted — a user with no passwordHash cannot log in via
  // POST /auth/login (see routes/auth.ts), only via dev-login while that
  // remains gated to non-production per lib/env.ts::isDevAuthEnabled.
  // Never queried in a SELECT that leaves this module, never logged.
  passwordHash: text("password_hash"),
  // Set the moment an invitation is accepted (proof of mailbox possession).
  // Not currently used to gate login on its own — recorded as a pre-GA
  // hardening item (docs/gate-evidence/PHASE2_AUTHENTICATION_DESIGN.md §2)
  // to also require it once a real email provider makes re-verification
  // practical for a user created before this remediation shipped.
  emailVerifiedAt: timestamp("email_verified_at"),
  // Per-account brute-force lockout (docs/gate-evidence/
  // PHASE2_AUTHENTICATION_DESIGN.md §4.3) — independent of, and in
  // addition to, the existing per-IP authRateLimiter.
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until"),
  // Foundation Remediation — server-side session revocation: bumped on
  // every logout (routes/auth.ts). The session token (lib/session.ts)
  // embeds the epoch that was current when it was signed; loadSession
  // (middlewares/auth.ts) rejects a token whose embedded epoch no longer
  // matches this column, so a captured/replayed token issued before the
  // user's last logout stops authenticating on the very next request even
  // though the HMAC signature itself is still cryptographically valid.
  // Critical Blocker Remediation, Phase 4: also bumped on password
  // reset/change and on account disable, for the same reason.
  sessionEpoch: integer("session_epoch").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertBrokerageSchema = createInsertSchema(brokerages).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBrokerage = z.infer<typeof insertBrokerageSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Brokerage = typeof brokerages.$inferSelect;
export type User = typeof users.$inferSelect;
