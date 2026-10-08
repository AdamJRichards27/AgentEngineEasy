# Platform Owner access

Platform Owners have a separate, operator-managed permission in `platform_owners`.
It is not a fourth selectable brokerage role. Invitations and ordinary role edits
cannot grant it. An active password-authenticated account is required; development
passwordless login is explicitly prohibited for Owners.

## Tenant isolation

- `/owner` lists, creates and renames brokerages.
- Owners explicitly select a brokerage before accessing operational routes.
- A signed HttpOnly, SameSite=Strict cookie binds the selected brokerage to the
  exact authentication session and expires after eight hours.
- Selection changes the request's effective brokerage and administrator role,
  never the persisted account or its actual identity.
- Existing tenant filters, purchased entitlements, feature flags and legal
  acceptance requirements still apply.
- Every authorized Owner request is durably audited before dispatch. If the
  owner is confirmed and the audit insert fails, that request returns 503.
  A missing `platform_owners` table is not an owner grant: ordinary signed-in
  users continue, and the owner console fails closed. Readiness reports the
  missing tables as a degraded reason. `db:preflight` fails when the journal
  contains `0035_platform_owner_access` and the applied history is already
  past that migration's `when` while either table is absent.
- Cross-brokerage writes, when the selected brokerage is not the owner's
  home brokerage, are limited to user administration and invitation
  administration (`/api/auth/admin/users/:id/disable`, `.../enable`,
  `/api/auth/admin/invitations`, `.../revoke`, and `/api/auth/admin/succession`).
  Every other write returns 403 `OWNER_ACTION_NOT_PERMITTED`. Reads are unchanged.
  Home-brokerage writes keep the owner's real administrator authority.
- Selecting or leaving a brokerage requires the owner's current password.
- Platform Owner sessions expire 12 hours after they were issued. Other
  sessions keep the existing 30-day lifetime.
- One Platform Owner cannot deactivate, change the role of, reset the
  password of, or revoke the sessions of another Platform Owner through
  brokerage administration. Those requests return 403 `OWNER_TARGET_PROTECTED`.
- Brokerage creation/rename and their target-specific audits commit atomically.
- Owner management mutations require the custom `X-AEE-Owner-Action: 1` header.
- Operational mutations require `X-AEE-Owner-Brokerage` to match the signed
  context, protecting against stale-tab writes after another tab switches.
- Context switches reload the page and discard cached tenant data. A session
  refresh detecting a switch in another tab also reloads before allowing writes.
- Account deactivation and session epoch revocation remain authoritative.

## Invitations and revocation

An invitation or administrator account created while a Platform Owner is
acting records that owner as the actor: `audit_logs.user_id` is the owner
user id and `updated_value` is `platform_owner=true`. The same fact is
stored on `platform_owner_audit` as
`invitation_created:id=<id>:role=<role>:platform_owner=1`.

Removing an owner from `platform_owners` does not delete administrator
accounts already created from those invitations. There is no schema column
on which to cascade that, and doing so would need an Owner decision.
Attribution remains on the invitation (`invited_by_user_id`) and on the
audit rows. Pending invitations that carry that owner-audit marker are
revoked when they are listed or presented for acceptance, so they cannot
be used after the owner is removed.

## Development account provisioning

Migration 0035 adds only the Owner permission and audit tables/index.
There are no automatic grants or credential changes at application startup.

PostgreSQL names the foreign keys from the migration SQL
`platform_owners_user_id_fkey`, `platform_owner_audit_owner_user_id_fkey`,
and `platform_owner_audit_brokerage_id_fkey`. Drizzle's snapshot records
the same constraints as `platform_owners_user_id_users_id_fk`,
`platform_owner_audit_owner_user_id_users_id_fk`, and
`platform_owner_audit_brokerage_id_brokerages_id_fk`. Do not rename them
without a migration approved for that purpose.

Brokerage create and rename refuse a name that matches an existing
brokerage case-insensitively. A unique index would close the remaining
race and needs a schema change, which this change does not add. A rename
records the previous and new names in the owner audit action string.

The explicit development-only command is:

```sh
PLATFORM_OWNER_BOOTSTRAP_ALLOWED=true \
  pnpm --filter @aee/api exec tsx src/scripts/bootstrapPlatformOwners.ts \
  --confirm-platform-owner-bootstrap \
  --first-email=<first-owner-email> \
  --second-email=<second-owner-email>
```

It refuses when `NODE_ENV` is `production`, when `REPLIT_DEPLOYMENT` is set
(a deployment signal that does not depend on `NODE_ENV`), or when
`PLATFORM_OWNER_BOOTSTRAP_ALLOWED` is not the literal string `true`.
Before it writes, it prints the target database host, port, and name.

It consumes `OWNER_AGENTENGINE_INITIAL_PASSWORD` and
`OWNER_AJRICHARDS_INITIAL_PASSWORD` through the environment, hashes them using
the existing Argon2id policy, and requires distinct passwords of at least 16
characters. Never place their values on the command line or in a file.

The operation atomically creates two new accounts, the `AgentEngineOwner` home
brokerage if absent, their separate Owner permissions and operator-provisioning
audit records. It refuses existing accounts rather than silently elevating or
overwriting them. It does not claim email verification or accept legal terms
on behalf of anyone. Users complete the existing legal acceptance step at login.
The bootstrap secrets are not used for subsequent authentication or startup.

## Verification

`ownerContextToken.test.ts` checks signatures, tampering, binding and expiry.
`platformOwnerAccess.test.ts` exercises real HTTP middleware when the
database name is `aee_ci` or the server port is 55439. Setting
`AEE_ISOLATED_OWNER_TEST=1` also runs it when `NODE_ENV` is `test`. It does
not run when `NODE_ENV` is `production` or `REPLIT_DEPLOYMENT` is set, and
it must never be pointed at a shared development or production database.
Apply the complete migration chain first.

The integration checks cover anonymous/nonowner denial, target existence,
explicit selection, scoped writes, context reuse and tampering, legal acceptance,
create/rename auditing, logout epoch revocation, deactivation, Owner revocation,
and fail-closed behavior when the audit table is unavailable.

Frontend `ownerContext.test.ts` covers headers, context replacement, navigation,
and avoiding automatic retry of rejected cross-context mutations.
