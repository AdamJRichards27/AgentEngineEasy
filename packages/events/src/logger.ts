// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Structured (single-line JSON) logging, replacing the ad hoc
// console.log/console.error calls scattered across apps/api. Every log
// line is redacted centrally (redaction.ts) before it's serialised, and
// automatically carries the ambient correlationId (context.ts) when one
// is active — a request handler, a scheduler tick, or a retry/replay
// attempt never has to pass its own id into every log call.
//
// No new dependency (no pino/winston) — deliberately, so this lands
// without touching package.json/pnpm-lock.yaml again. process.stdout /
// process.stderr, one JSON object per line, is exactly what every log
// aggregator (CloudWatch, Datadog, a plain `docker logs | jq`) expects.

import { getActiveCorrelationId, getActiveCausationId } from "./context.js";
import { redactForLog } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredMinLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

export interface LogFields {
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlationId?: string;
  causationId?: string | null;
  [key: string]: unknown;
}

/**
 * Builds the exact JSON object that will be written for a log call —
 * exported (not just used internally) so tests can assert on structure
 * and redaction without parsing stdout.
 */
export function buildLogEntry(level: LogLevel, message: string, fields?: LogFields): LogEntry {
  const correlationId = getActiveCorrelationId();
  const causationId = getActiveCausationId();
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(correlationId ? { correlationId } : {}),
    ...(causationId ? { causationId } : {}),
    ...(fields ? (redactForLog(fields) as object) : {}),
  };
  return entry;
}

function write(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredMinLevel()]) return;
  const entry = buildLogEntry(level, message, fields);
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields): void => write("debug", message, fields),
  info: (message: string, fields?: LogFields): void => write("info", message, fields),
  warn: (message: string, fields?: LogFields): void => write("warn", message, fields),
  error: (message: string, fields?: LogFields): void => write("error", message, fields),
};
