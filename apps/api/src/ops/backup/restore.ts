import { runCli } from "./cli.js";
import { createScopedRunner, runCommand } from "./commands.js";

// Exit codes and output: CLI-SPEC.md (0 ok, 1 failed, 64 usage, 69 preflight, 70 internal, 78 config; 75 reserved).
process.exitCode = await runCli("restore", {
  argv: process.argv.slice(2),
  env: process.env,
  runFor: (config) => (config.envIsolation ? createScopedRunner(config.envIsolation) : runCommand),
  bootstrapRun: runCommand,
});
