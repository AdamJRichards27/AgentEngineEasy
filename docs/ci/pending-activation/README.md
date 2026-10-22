# Pending activation

Pending Owner activation; not run in GitHub CI.

`grow-e2e-smoke.yml` is the signed-in Grow E2E smoke workflow (ephemeral
postgres:16 service, synthetic data, dev-login; no secrets, no external
providers). It was verified locally 5/5 via `pnpm --filter @aee/api e2e:grow`.
Activating it means moving it to `.github/workflows/`, which is an Owner action.
