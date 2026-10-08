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
- Every authorized Owner request is durably audited before dispatch. Database
  or audit failure returns 503, never a fallback permission.
- Brokerage creation/rename and their target-specific audits commit atomically.
- Owner management mutations require the custom `X-AEE-Owner-Action: 1` header.
- Operational mutations require `X-AEE-Owner-Brokerage` to match the signed
  context, protecting against stale-tab writes after another tab switches.
- Context switches reload the page and discard cached tenant data. A session
  refresh detecting a switch in another tab also reloads before allowing writes.
- Account deactivation and session epoch revocation remain authoritative.

## Development account provisioning

Migration 0034 adds only the Owner permission and audit tables/index.
There are no automatic grants or credential changes at application startup.

The explicit development-only command is:

```sh
pnpm --filter @aee/api exec tsx src/scripts/bootstrapPlatformOwners.ts \
  --confirm-platform-owner-bootstrap \
  --first-email=<first-owner-email> \
  --second-email=<second-owner-email>
```

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
`platformOwnerAccess.test.ts` exercises real HTTP middleware against a disposable
PostgreSQL database on localhost port 55439. It deliberately skips other database
targets and must never be redirected to a shared development/production database.
Apply the complete migration chain to the disposable database first.

The integration checks cover anonymous/nonowner denial, target existence,
explicit selection, scoped writes, context reuse and tampering, legal acceptance,
create/rename auditing, logout epoch revocation, deactivation, Owner revocation,
and fail-closed behavior when the audit table is unavailable.

Frontend `ownerContext.test.ts` covers headers, context replacement, navigation,
and avoiding automatic retry of rejected cross-context mutations.
