import type { BackupOperation, CommandRunner, DatabaseInventory } from "./types.js";

const INVENTORY_SQL = String.raw`
WITH table_counts AS (
  SELECT jsonb_object_agg(table_name, row_count) AS counts
  FROM (
    SELECT table_name,
      (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint AS row_count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  ) c
), document_keys AS (
  SELECT coalesce(jsonb_agg(object_storage_key ORDER BY object_storage_key), '[]'::jsonb) AS keys
  FROM documents WHERE object_storage_key IS NOT NULL
)
SELECT jsonb_build_object(
  'tenantCount', (SELECT count(*) FROM brokerages),
  'recordCounts', coalesce((SELECT counts FROM table_counts), '{}'::jsonb),
  'documentKeys', (SELECT keys FROM document_keys)
)::text;
`;

export async function readDatabaseInventory(
  runner: CommandRunner,
  databaseUrl: string,
  operation: BackupOperation = "database",
): Promise<DatabaseInventory> {
  const result = await runner({
    executable: "psql",
    args: ["--no-psqlrc", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--dbname", databaseUrl, "--command", INVENTORY_SQL],
  }, undefined, operation);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Database inventory command did not return valid JSON");
  }
  const value = parsed as Partial<DatabaseInventory>;
  if (
    !Number.isInteger(value.tenantCount) ||
    !value.recordCounts ||
    typeof value.recordCounts !== "object" ||
    !Array.isArray(value.documentKeys)
  ) {
    throw new Error("Database inventory JSON has an invalid shape");
  }
  return value as DatabaseInventory;
}

/** A destructive restore must only start with no user tables in public. */
export async function assertRestoreTargetIsEmpty(runner: CommandRunner, databaseUrl: string, operation: BackupOperation = "database"): Promise<void> {
  const result = await runner({
    executable: "psql",
    args: [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set=ON_ERROR_STOP=1",
      "--dbname",
      databaseUrl,
      "--command",
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';",
    ],
  }, undefined, operation);
  const count = Number(result.stdout.trim());
  if (!Number.isInteger(count) || count < 0) throw new Error("Restore target preflight did not return a table count");
  if (count !== 0) throw new Error(`Restore target preflight refused populated database with ${count} public tables`);
}

export function validateDatabaseInventory(expected: DatabaseInventory, actual: DatabaseInventory): void {
  if (expected.tenantCount !== actual.tenantCount) {
    throw new Error(`Tenant validation failed: expected ${expected.tenantCount}, restored ${actual.tenantCount}`);
  }
  const names = new Set([...Object.keys(expected.recordCounts), ...Object.keys(actual.recordCounts)]);
  const mismatches = [...names]
    .sort()
    .filter((name) => expected.recordCounts[name] !== actual.recordCounts[name])
    .map((name) => `${name}:${expected.recordCounts[name] ?? "missing"}!=${actual.recordCounts[name] ?? "missing"}`);
  if (mismatches.length) throw new Error(`Record-count validation failed: ${mismatches.join(", ")}`);
  const expectedKeys = [...expected.documentKeys].sort();
  const actualKeys = [...actual.documentKeys].sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    throw new Error("Restored document-key records do not match the backup inventory");
  }
}