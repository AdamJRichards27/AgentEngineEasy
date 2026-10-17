import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BackupOperation, CommandResult, CommandRunner, CommandSpec, EnvIsolationPolicy } from "./types.js";

const execFileAsync = promisify(execFile);

function substitute(value: string, replacements: Record<string, string>): string {
  return value.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, key: string) => {
    const replacement = replacements[key];
    if (replacement === undefined) throw new Error(`Command placeholder {${key}} has no value`);
    return replacement;
  });
}

/**
 * Fixed non-secret variables every isolated child receives (process location, temp dirs, locale, Windows basics).
 * HOME/USERPROFILE are deliberately NOT here: they are the root of credential discovery (~/.aws, ~/.pgpass, ...).
 * A child only gets a home directory when policy.homeDirectory (BACKUP_ENV_HOME) is configured.
 */
const BASE_ALLOW = [
  "PATH", "TMPDIR", "TMP", "TEMP", "TZ", "LANG", "LANGUAGE", "LC_*",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
];

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/** True when two allowlist entries could ever admit the same variable name. */
export function patternsOverlap(a: string, b: string): boolean {
  const aPrefix = a.endsWith("*");
  const bPrefix = b.endsWith("*");
  if (!aPrefix && !bPrefix) return a === b;
  if (aPrefix && !bPrefix) return b.startsWith(a.slice(0, -1));
  if (!aPrefix && bPrefix) return a.startsWith(b.slice(0, -1));
  const pa = a.slice(0, -1);
  const pb = b.slice(0, -1);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** Builds the child environment for one operation. Pure; reads only variable NAMES to filter (values are copied, never logged). */
export function buildChildEnv(
  operation: BackupOperation,
  policy: EnvIsolationPolicy,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allow = [...BASE_ALLOW, ...policy.common, ...(policy.operations[operation] ?? [])];
  const scoped: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value !== undefined && allow.some((pattern) => matches(pattern, name))) scoped[name] = value;
  }
  if (policy.homeDirectory) {
    scoped.HOME = policy.homeDirectory;
    scoped.USERPROFILE = policy.homeDirectory;
  }
  return scoped;
}

/** Creates a runner whose children get only the scoped environment of their operation. */
export function createScopedRunner(policy: EnvIsolationPolicy, baseEnv: NodeJS.ProcessEnv = process.env): CommandRunner {
  return (command, replacements = {}, operation) =>
    execute(command, replacements, operation ? buildChildEnv(operation, policy, baseEnv) : buildChildEnv("archive", policy, baseEnv));
}

/** Legacy runner: the full process.env goes to every child (used only when isolation is not enabled). */
export const runCommand: CommandRunner = (command, replacements = {}) => execute(command, replacements, process.env);

async function execute(
  command: CommandSpec,
  replacements: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const executable = substitute(command.executable, replacements);
  const args = command.args.map((arg) => substitute(arg, replacements));
  try {
    const result = await execFileAsync(executable, args, {
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = String(commandError.stderr ?? "")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[credentials-redacted]@")
      .trim()
      .slice(0, 2_000);
    const code = commandError.code ? ` (${commandError.code})` : "";
    throw new Error(`Command ${executable} failed${code}${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
};

export function databaseCommand(executable: string, databaseUrl: string, args: string[]): CommandSpec {
  return { executable, args: [...args, databaseUrl] };
}