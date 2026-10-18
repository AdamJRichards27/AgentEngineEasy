import type { VerifierResult } from "./classifyVersions.mjs";
export { EXIT_CODES, classify } from "./classifyVersions.mjs";
export const VERIFIER_ID: string;
export const ALLOWED_REGIONS: readonly string[];
export const ALLOWED_SUBCOMMANDS: ReadonlySet<string>;
export interface AwsCallParams { region: string; endpoint: string; bucket: string; owner?: string; extra?: string[] }
export interface VerifyS3Config {
  aws: string; expectedVersion: string; sha256: string; bucket: string; region: string; endpoint: string;
  owner?: string; pageSize: number; maxPages: number; key: string; remote: string;
}
export class UsageError extends Error {}
export class IntegrityError extends Error {}
export function resolveEndpoint(region: string, endpoint: string | undefined): string;
export function parseArgs(argv: string[]): VerifyS3Config;
export function buildAwsArgv(sub: string, params: AwsCallParams): string[];
export function runAws(input: { aws: string; sub: string; params: AwsCallParams }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
export function verifyAwsCli(input: { aws: string; expectedVersion: string; sha256: string }): Promise<string>;
export function verifyWithS3(config: VerifyS3Config & { now?: Date }): Promise<VerifierResult & { pages?: number }>;
