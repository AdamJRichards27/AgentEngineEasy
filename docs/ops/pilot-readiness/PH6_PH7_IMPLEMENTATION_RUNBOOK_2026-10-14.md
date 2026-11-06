# PH-6 / PH-7 implementation runbook (14 Oct 2026). DRAFT, nothing activated
- **Companion to:** `PH6_PH7_MONITORING_BACKUP_PROPOSAL_2026-10-14.md` (costs, recommendation M1).
- **Draft files** in `ph67/` (syntax-checked only: `node --check`, `bash -n`; **never run**):

| File | Purpose |
|---|---|
| `backup-env.example` | Names + non-secret shapes for every `BACKUP_*` var `ops/backup/config.ts` requires, plus the command templates |
| `kms-envelope.mjs` | Authenticated encryption for the `{input}/{output}/{kmsProfile}` encrypt/decrypt hooks: AWS KMS data key + AES-256-GCM |
| `s3-delete.sh` | Retention delete hook; refuses anything but a bare object name |
| `backup-alert.sh` | Engine failure hook → Healthchecks.io `/fail` |
| `backup-cron.sh` | Daily entry point (`0 2 * * *` UTC = 12:00 AEST): start ping → `backup:run` → independent verify → success ping |
| `verify-latest-backup.sh` | Newest `aee-protected-*.tar.enc` is <26 h old; manifest sha256 matches; decrypts (GCM tag); `database.dump` TOC ≥ 1000 |
| `restore-drill.sh` | Runs the app's `backup:restore --confirm-disposable` into the `restore-*` env only; refuses if the restore URL equals `DATABASE_URL`; records RTO, row counts and the newest audit timestamp (RPO). Verify column names at drill time |
| `alert-relay.mjs` | Receiver for the app's alert envelope (Bearer token, constant-time compare), forwarding short text to an email/push API |
| `probes.yaml` | UptimeRobot monitors (pilot ready + live, dev Repl ready) and Healthchecks.io checks |

## Steps (each gated)
| # | Step | Who | Approval |
|---|---|---|---|
| 1 | AWS account; S3 bucket in **ap-southeast-2** (block public access, versioning, default SSE-KMS); KMS key alias `alias/ae-pilot-backup`; IAM user limited to Put/Get/List/Delete on `heliumdb/` + `kms:GenerateDataKey`/`Decrypt` on that key | Owner | spend + account |
| 2 | UptimeRobot Solo + Healthchecks.io accounts; contacts = Owner email + SMS; on-call person named (also feeds legal #10) | Owner | spend |
| 3 | Relay host chosen; deploy `alert-relay.mjs` with `RELAY_TOKEN` and `RELAY_FORWARD_URL` | Owner + Eng | host choice |
| 4 | Staging PR: add `scripts/ph67/*` (from `ph67/`), plus `.replit` nix `postgresql` + `awscli2` | Eng drafts | **MERGE** |
| 5 | Pilot Secrets: the `BACKUP_*`/`AWS_*`/`OPERATIONAL_ALERTS_*`/`HEALTHCHECKS_*` names | Owner | secrets change |
| 6 | Replit Scheduled deployment running `bash scripts/ph67/backup-cron.sh` daily at 02:00 UTC | Owner | deployment |
| 7 | Configure the monitors from `probes.yaml` | Owner | — |
| 8 | **Acceptance:** (a) one manual backup run → `VERIFY_OK`; (b) restore drill → migrations 37, row counts match the source, RTO recorded; (c) `TEST` alert received on phone + email; (d) stop the pilot app briefly in an agreed window → probe alert within 3 min; (e) a forced backup failure (wrong bucket in a test run) → Healthchecks `/fail` alert | Eng + Owner | drill approval |
| 9 | **Operate:** daily heartbeat; monthly restore drill + TEST alert (ping the monthly check); quarterly key/credential review | Ops owner | — |

## Recovery procedure (pilot DB loss)
1. Freeze: unpublish or put the pilot in maintenance (Owner).
2. Choose the artifact: newest `VERIFY_OK`.
3. Create a new production DB (AU), with timezone UTC.
4. Restore with `pg_restore` from the decrypted `database.dump` via the engine restore path, pointed at the **new** DB (a one-off env with `BACKUP_RESTORE_*` = the new DB; the engine only accepts `restore-*` ids, so name it `restore-pilot-recovery`).
5. Verify migrations 37 + row counts.
6. Repoint `DATABASE_URL` (Owner) and redeploy the same pinned SHA.
7. Check readiness + smoke.
8. Record RPO/RTO.

**Target RTO 4 h / RPO 24 h.**

## What this does NOT cover
- The document-storage bucket's own versioning or replication (PH-5).
- Replit PITR (secondary).
- Cross-account immutability (optional S3 Object Lock, extra cost [UNVERIFIED]).
