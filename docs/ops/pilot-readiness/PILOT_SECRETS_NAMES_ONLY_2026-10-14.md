# Pilot deployment env/secret set: NAMES ONLY (14 Oct 2026)
This is a draft. No values are recorded here, nothing is set, and nothing was copied from dev.
- **Source:** every `process.env` name used by `apps/api/src` + `packages` at staging **94e6d485** (excluding tests), plus `D4_PILOT_HOST_PLAN_FINAL_2026-10-10.md` §2 PH-4.
- **Rule:** every value is NEW and lives only in the **pilot deployment's Secrets pane**. Nothing comes from the dev Repl.
- **Who sees values:** the Owner, or the named secret holder. Never chat, logs, GitHub or the CC.

## ⚠ Explicit prohibition: no live Google Places
**`PROPERTY_DATA_PROVIDER` must be UNSET on the pilot.** Unset falls back to `mock`; the only other valid value is `mock`. **`GOOGLE_PLACES_API_KEY` must be UNSET.**
- **Why:** the dev Repl currently has `PROPERTY_DATA_PROVIDER=google-places` with a key set (verified read-only 14 Oct). That makes live calls from `GET /api/properties/address-search` and `POST /api/properties` (routes/properties.ts:184/218/233).
- **Code protection:** `packages/integrations/property-data/src/index.ts` forces mock **only when `NODE_ENV=production` and `LIVE_EXTERNAL_TRANSACTIONS_APPROVED !== "true"`**. The pilot relies on both conditions *and* on the variables being unset (defence in depth).
- **Post-provision check:** names-only presence check shows both unset, and the boot log contains no `GooglePlacesProvider`.

## A. Required to boot in production (set at provisioning)
| Name | Notes |
|---|---|
| `NODE_ENV` | `production` (the fail-closed gates depend on it) |
| `DATABASE_URL` | Pilot DB only (Replit production Postgres, AU geography). **SECRET** |
| `SESSION_SECRET` | New, ≥32 chars. **SECRET** |
| `CORS_ALLOWED_ORIGINS`, `FRONTEND_BASE_URL` | Exact pilot URL |
| `METRICS_TOKEN` | New. **SECRET** |
| `TRUST_PROXY` | `1` (never `true`) |
| `PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED` | `true`, with `AUTH_EMAIL_PROVIDER` **unset** (sandbox email) |
| `OPERATIONAL_ALERTS_ENABLED` / `_PROVIDER` / `_WEBHOOK_URL` / `_TOKEN` | `true` / `webhook` / HTTPS relay URL / ≥16 chars **SECRET** (PH-6). Optional: `_COOLDOWN_SECONDS`, `_ALLOW_TEST` (for the monthly TEST) |
| `OBJECT_STORAGE_PROVIDER`, `_BUCKET`, `_REGION`, `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | s3, ap-southeast-2 (PH-5). Keys are **SECRET** |
| `DOCUMENT_STORAGE_SIGNING_SECRET` | ≥32 bytes. **SECRET** |
| `LEGAL_DOCUMENTS_APPROVED`, `APPROVED_TERMS_ARTIFACT_PATH`, `APPROVED_TERMS_SHA256`, `APPROVED_PRIVACY_ARTIFACT_PATH`, `APPROVED_PRIVACY_SHA256` | **Only after legal approval (PH-8)** and the approved-artifact PR. Until then the host will not boot in production |
| `AI_DAILY_LIMIT_PER_USER`, `AI_DAILY_LIMIT_PER_BROKERAGE`, `AI_DAILY_TOKEN_LIMIT_PER_USER`, `AI_DAILY_TOKEN_LIMIT_PER_BROKERAGE` | Conservative values (required by `assertAiUsageLimitsConfigured`; mock AI) |
| `PORT` | Platform default / 8080 |

## B. Backups and monitoring (PH-6/PH-7; set with the backup scheduler)
`BACKUP_*` (full list in `ph67/backup-env.example`), `AWS_REGION=ap-southeast-2`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (**SECRET**, least-privilege IAM), `AE_BACKUP_KMS_KEY_ALIAS`, `AE_BACKUP_S3_BUCKET_PREFIX`, `HEALTHCHECKS_BACKUP_PING_URL` (**SECRET**), `BACKUP_RESTORE_DATABASE_URL` (**SECRET**, the disposable restore DB only).

## C. Must be UNSET (or the stated mock value) on the pilot
| Group | Names |
|---|---|
| **Property data** | **`PROPERTY_DATA_PROVIDER` (unset / `mock`), `GOOGLE_PLACES_API_KEY`** |
| Live approvals | `LIVE_AI_PROVIDER_APPROVED`, `LIVE_CALL_TRANSCRIPTION_APPROVED`, `LIVE_COMMUNICATIONS_APPROVED`, `LIVE_EXTERNAL_TRANSACTIONS_APPROVED`, `LIVE_RECORDING_APPROVED`, `LIVE_TELEPHONY_APPROVED`, `LIVE_VOICE_TRANSCRIPTION_APPROVED` |
| AI | `AI_PROVIDER` (unset → mock, or `mock`), `AI_FALLBACK_PROVIDER`, `AI_TRANSCRIPTION_PROVIDER` (mock), `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`; `AI_BUSINESS_COACH_ENABLED`, `AI_PROACTIVE_INTELLIGENCE_ENABLED`, `AI_WORKFLOW_AI_ENABLED`, `AI_PITCREW_AI_ENABLED`, `AI_GROW_CALL_SUMMARY_ENABLED` all off/unset |
| Comms | `AUTH_EMAIL_PROVIDER`, `COMMUNICATIONS_EMAIL_PROVIDER`, `COMMUNICATIONS_SMS_PROVIDER` (sandbox), `COMMUNICATIONS_WEBHOOK_SECRET` |
| Payments / billing | `BILLING_PROVIDER` (mock), `PAYMENT_PROVIDER`, `MANDATE_PAYMENT_PROVIDER`, `MANDATE_PAYMENT_WEBHOOKS_ENABLED`, `MANDATE_PAYMENT_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_BASE_URL` |
| AML / e-sign | `AML_PROVIDER` (mock), `AML_PROVIDER_API_KEY`, `AML_API_BASE_URL`; `ESIGN_PROVIDER` (mock), `ESIGN_PROVIDER_API_KEY`, `ESIGN_API_BASE_URL`. Mock webhook secrets (`AML_WEBHOOK_SECRET`, `ESIGN_WEBHOOK_SECRET`) follow `MOCK_WEBHOOK_SECRETS_PROPOSAL_2026-10-12.md` |
| Telephony | `GROW_CALLS_WEBHOOK_SECRET` (unset; calling not granted) |
| **Pit Crew (flags OFF)** | `PIT_CREW_WAITING_ON_SWEEP_ENABLED`, `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED`, `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED`; no `PIT_CREW_*` at all |
| Privileged bootstrap | `OWNER_AGENTENGINE_INITIAL_PASSWORD`, `OWNER_AJRICHARDS_INITIAL_PASSWORD`, `PLATFORM_OWNER_BOOTSTRAP_ALLOWED`: **never set** |
| Dev-only | `ALLOW_DEV_AUTH`, `ALLOW_INSECURE_DEV_COOKIES`: **never set** |

## D. Optional tuning (defaults fine)
`LOG_LEVEL`, `PG_POOL_MAX`, `DB_SET_SESSION_TIMEZONE`, `LAUNCH_TIMEZONE` (Australia/Brisbane), `GROW_SIGNAL_SWEEP_*`, `DOCUMENT_STORAGE_*` limits, `AI_MAX_OUTPUT_TOKENS`/`AI_TIMEOUT_MS`/etc., `WEB_DIST_DIR`.

## Post-provision verification (names-only, read-only)
A script prints `NAME=set|unset` (never values) for every row in C and asserts all are unset, except mock values printed as the literal word `mock`. Any C-row set = HOLD before publish.
