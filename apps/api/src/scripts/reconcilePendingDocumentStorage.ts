import {
  reconcilePendingDocumentVersions,
  configuredPendingReconciliation,
} from "../lib/documentStorage.js";

function parseCursor(): number {
  const raw = process.argv
    .slice(2)
    .filter((argument) => argument !== "--")
    .find((argument) => argument.startsWith("--after-id="))
    ?.slice("--after-id=".length);
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--after-id must be a non-negative integer");
  }
  return parsed;
}

async function main(): Promise<void> {
  const configured = configuredPendingReconciliation();
  const result = await reconcilePendingDocumentVersions({
    afterId: parseCursor(),
    limit: configured.batchSize,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `Pending document reconciliation failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});