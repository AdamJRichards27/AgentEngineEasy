import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandResult, CommandRunner, CommandSpec } from "./types.js";

const execFileAsync = promisify(execFile);

function substitute(value: string, replacements: Record<string, string>): string {
  return value.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, key: string) => {
    const replacement = replacements[key];
    if (replacement === undefined) throw new Error(`Command placeholder {${key}} has no value`);
    return replacement;
  });
}

export const runCommand: CommandRunner = async (
  command: CommandSpec,
  replacements: Record<string, string> = {},
): Promise<CommandResult> => {
  const executable = substitute(command.executable, replacements);
  const args = command.args.map((arg) => substitute(arg, replacements));
  try {
    const result = await execFileAsync(executable, args, {
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
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