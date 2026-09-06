import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { brokerages, users } from "./users";

// Critical Blocker Remediation, Phase 4 — invitation-only authentication.
// See docs/gate-evidence/PHASE2_AUTHENTICATION_DESIGN.md §3 for the full
// design. Both tables here store only a SHA-256 hash of a random,
// CSPRNG-generated token (apps/api/src/lib/auth/tokens.ts) — the plaintext
// token exists only in the invitation/reset email and the URL the
// recipient clicks, never in this database, never in a log line, and never
// in an audit_logs row.

export const invitations = pgTable("invitations", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id")
    .notNull()
    .references(() => brokerages.id),
  email: text("email").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedByUserId: integer("invited_by_user_id").references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Invitation = typeof invitations.$inferSelect;

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
