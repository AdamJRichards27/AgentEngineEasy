/**
 * Test-only companion of perFileDatabase.mjs: drops ONE per-file test database
 * copy. Run synchronously from the test-file process's `exit` handler (an
 * `exit` handler cannot await), so it reads everything from the environment --
 * never argv, which other users can see in `ps`:
 *   AEE_TEST_DB_DROP_ADMIN_URL  connection URL of the server's postgres db
 *   AEE_TEST_DB_DROP_NAME       the copy to drop
 * Uses DROP DATABASE ... WITH (FORCE) (PG13+): the exiting process may still
 * hold pool connections to its own copy. Exit 0 on success, 1 on any error;
 * prints only the error message (pg messages carry no connection string).
 */
import pg from "pg";

const name = process.env.AEE_TEST_DB_DROP_NAME ?? "";
const quote = (value) => `"${value.replace(/"/g, '""')}"`;
const client = new pg.Client({ connectionString: process.env.AEE_TEST_DB_DROP_ADMIN_URL });
try {
  await client.connect();
  await client.query(`drop database if exists ${quote(name)} with (force)`);
  await client.end();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await client.end().catch(() => undefined);
  process.exitCode = 1;
}
