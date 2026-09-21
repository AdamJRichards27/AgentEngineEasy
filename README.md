# AgentEngineEasy

A simplified, property-led real estate transaction platform for Australian real estate agents.

**Enter information once. AgentEngineEasy determines what happens next.**

This is a new, independent application — not a fork or reproduction of Agent Engine Staging. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) (on the `staging` branch) for the full domain model, folder structure, integration interfaces, and development sequence.

## Branches

- `main` — protected, releases only.
- `staging` — active development happens here. Feature branches fork from `staging`.

See the `staging` branch for the current state of the build.

## Running the API tests

Use the canonical runner rather than invoking the test script directly:

```bash
# Apply the schema to a dedicated, disposable database first.
DATABASE_URL=postgres://user:pass@host:port/aee_test pnpm db:push

# Full suite, exactly as CI runs it.
DATABASE_URL=postgres://user:pass@host:port/aee_test pnpm test:api

# Or just the files you care about (paths relative to apps/api).
DATABASE_URL=... pnpm test:api src/routes/__tests__/growToday.test.ts
```

`scripts/run-api-tests.sh` supplies the three values CI sets at job level and a
fresh worktree does not have, because `apps/api/.env` is gitignored: `NODE_ENV=test`,
`ALLOW_DEV_AUTH=true` and the placeholder `SESSION_SECRET`. Without them you get
spurious HTTP 429s, `dev-login 404`s, and a refusal to start — each of which looks
exactly like a real regression.

Two things that are not optional:

- **Point `DATABASE_URL` at a dedicated, disposable database.** The suite is order-
  and state-sensitive when runs share one database, and produces disjoint,
  non-reproducible failure sets when they do.
- **Run Postgres with `-c timezone=UTC`.** Entitlement columns are `timestamp
  without time zone`, so a non-UTC session clock fails roughly 200 tests for
  reasons unrelated to the code under test.
