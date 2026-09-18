import {
  configuredCallTranscriptionReconciliation,
  reconcileAbandonedCallTranscriptions,
} from "../lib/telephony/callTranscriptionReconciliation.js";

function integerArgument(name: string, raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseArguments(): Map<string, string> {
  const allowed = new Set(["--after-id", "--batch-size", "--stale-after-ms"]);
  const parsed = new Map<string, string>();
  for (const value of process.argv.slice(2)) {
    if (value === "--") continue;
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`Unknown or malformed option: ${value}`);
    const name = value.slice(0, separator);
    const argumentValue = value.slice(separator + 1);
    if (!allowed.has(name) || argumentValue === "") {
      throw new Error(`Unknown or malformed option: ${value}`);
    }
    if (parsed.has(name)) throw new Error(`Duplicate option: ${name}`);
    parsed.set(name, argumentValue);
  }
  return parsed;
}

async function main(): Promise<void> {
  const configured = configuredCallTranscriptionReconciliation();
  const argumentsByName = parseArguments();
  const afterId = argumentsByName.get("--after-id");
  const batchSize = argumentsByName.get("--batch-size");
  const staleAfterMs = argumentsByName.get("--stale-after-ms");
  const result = await reconcileAbandonedCallTranscriptions({
    afterId: afterId === undefined ? 0 : integerArgument("--after-id", afterId, 0, Number.MAX_SAFE_INTEGER),
    batchSize: batchSize === undefined
      ? configured.batchSize
      : integerArgument("--batch-size", batchSize, 1, 500),
    staleAfterMs: staleAfterMs === undefined
      ? configured.staleAfterMs
      : integerArgument("--stale-after-ms", staleAfterMs, 120_000, 7 * 24 * 60 * 60 * 1_000),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `Call transcription reconciliation failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
