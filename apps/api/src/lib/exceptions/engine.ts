// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
//
// The engine: dispatches every rule in the registry (registry.ts) against
// live domain state, on two schedules (Build Instructions §9):
//   - event-driven: a canonical domain event fires -> every rule that
//     declares it in triggerEventTypes re-scans the event's brokerage
//     immediately (handleExceptionDomainEvent, registered by bootstrap.ts).
//   - time-driven: a periodic sweep (runScheduledScan, invoked by
//     bootstrap.ts's scheduler) walks every brokerage in bounded pages and
//     runs every rule's scanBrokerage — this is also what performs
//     auto-resolution (see below) and is the only path that catches a
//     condition whose clearing produced no canonical event.
//
// Both paths funnel through the exact same per-brokerage evaluation
// (scanBrokerageForExceptions) and the exact same persistence entry point
// (model.ts's createOrUpdateException) — one detection function per rule,
// one write path, so the two triggers can never silently drift apart from
// each other (registry.ts's own module comment makes the same point about
// scanBrokerage itself).
//
// Auto-resolution and the "never treat absence of evidence as proof of
// completion" rule (Build Instructions §3, §19): a rule's scanBrokerage
// result for one brokerage is the complete, authoritative set of every
// CURRENTLY true occurrence of that rule's condition. So after a
// SUCCESSFUL scan, any exception this rule has open for that brokerage
// whose dedup key is NOT in that result set has had its condition verified
// cleared — that is genuine authoritative evidence, not an inference from
// silence. The critical safeguard is the word SUCCESSFUL: if scanBrokerage
// throws, this file records an EVALUATION_FAILED transition against every
// exception that rule currently has open and does NOT touch their status —
// a failed evaluation proves nothing about whether the condition cleared.

import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db, riskExceptions, riskExceptionScanRuns, brokerages, type RiskException } from "@aee/db";
import { registerHandler, runWithCorrelationId, logger, incrementCounter, type DomainEvent, type AgentEngineEasyEventType } from "@aee/events";
import { RISK_RULES, getRulesForEventType, type RiskRule } from "./registry.js";
import { createOrUpdateException, autoResolveException, recordEvaluationFailure, currentCorrelationId } from "./model.js";
import { OPEN_RISK_EXCEPTION_STATUSES, type RiskFinding } from "./types.js";

// ---------------------------------------------------------------------
// Event-driven dispatch.
// ---------------------------------------------------------------------

/**
 * Registered once per canonical event type that at least one rule actually
 * listens for (bootstrap.ts). Unlike the automation engine's blanket
 * registration for every event type (justified there because its rules are
 * tenant-authored and can reference any type without a code change), this
 * catalogue is entirely code-defined — a rule referencing a new trigger
 * type is itself a code change, so registering only for the types
 * getRulesForEventType actually resolves is a real, safe narrowing rather
 * than a guess.
 */
export async function handleExceptionDomainEvent(event: DomainEvent): Promise<void> {
  if (!event.brokerageId) return; // no canonical event today omits it, but nothing enforces that at the type level — fail closed rather than guess
  const rules = getRulesForEventType(event.eventType);
  if (rules.length === 0) return;
  incrementCounter("exceptions_scan_total", { trigger: "EVENT_DRIVEN" });

  const now = new Date();
  for (const rule of rules) {
    try {
      await evaluateRuleForBrokerage(rule, event.brokerageId, now, event.correlationId, event.id);
    } catch (err) {
      // Isolation: one rule throwing must never stop a sibling rule
      // matching the same event from being evaluated — same principle
      // packages/events/src/registry.ts's dispatchToHandlers already
      // applies between handlers, reproduced here between rules within
      // this one handler (mirrors automation/engine.ts's own per-rule
      // try/catch for the identical reason).
      logger.error("exceptions_rule_threw_event_driven", { ruleId: rule.ruleId, eventId: event.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Persists every current finding for one rule/brokerage. Deliberately does
 * NOT auto-resolve on the event-driven path — a single rule's fresh finding
 * set is only complete evidence for THAT rule, and auto-resolution here
 * would be correct in principle but is intentionally left to the scheduled
 * sweep (scanBrokerageForExceptions) so that every rule's auto-resolution
 * check happens against a full pass, in one place, with one consistent
 * "did this rule itself just run cleanly" guard — avoiding two independent
 * auto-resolution code paths that could diverge.
 */
async function evaluateRuleForBrokerage(rule: RiskRule, brokerageId: number, now: Date, correlationId: string, causationId: string | null): Promise<void> {
  const findings = await rule.scanBrokerage(brokerageId, now);
  for (const finding of findings) {
    await createOrUpdateException(finding, brokerageId, finding.propertyId, finding.transactionId, correlationId, causationId);
  }
}

// ---------------------------------------------------------------------
// Time-driven scan orchestrator.
// ---------------------------------------------------------------------

const BROKERAGE_BATCH_SIZE = 50;

// Single-flight guard for the time-driven sweep. A session-level Postgres
// advisory lock, held on ONE dedicated pooled connection for the entire
// scan and released in `finally`, makes overlapping sweeps impossible — the
// manual POST /exceptions/ops/scan trigger, bootstrap.ts's interval timer,
// and any other API instance sharing the database all contend for the same
// lock, and pg_try_advisory_lock is atomic, so exactly one caller wins and
// every other caller is refused immediately (no check-then-insert race, the
// defect the previous "is there a RUNNING scan_runs row?" guard had).
//
// Crash safety needs no wall-clock arithmetic: Postgres releases a session
// advisory lock the moment its connection closes, so a crashed or killed
// process can never wedge the lock. Any scan_runs row still marked RUNNING
// when a new sweep successfully takes the lock is, by construction, not
// running (its holder no longer holds the lock), so it is closed out as
// FAILED/abandoned — purely lock-based, independent of the process or
// database time zone. The two-int4 form of the lock lives in a different
// advisory keyspace from model.ts's single-bigint hashtext() dedup locks,
// so the two can never collide.
const SCAN_LOCK_NAMESPACE = 0x41455245; // "AERE" — Agent Engine Risk Exceptions
const SCAN_LOCK_KEY = 1;

export interface ScanSummary {
  scanRunId: string;
  brokeragesScanned: number;
  rulesEvaluated: number;
  exceptionsCreated: number;
  exceptionsUpdated: number;
  exceptionsAutoResolved: number;
  errors: number;
}

export type RunScanResult = { ok: true; summary: ScanSummary } | { ok: false; skippedReason: string };

export interface RunScheduledScanOptions {
  /**
   * Restrict the sweep to these brokerages only. Omitted (the production
   * default — bootstrap.ts's scheduler and the manual ops route never pass
   * it) means every brokerage, exactly as before. Exists so test files that
   * share one database can scan only their own tenants and never create,
   * update or auto-resolve another concurrently-running file's exceptions.
   * The single-flight lock is still global either way.
   */
  brokerageIds?: number[];
}

export async function runScheduledScan(trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED", options: RunScheduledScanOptions = {}): Promise<RunScanResult> {
  const lockClient = await db.$client.connect();
  let lockHeld = false;
  let releaseError: Error | undefined;
  try {
    const lockResult = await lockClient.query<{ locked: boolean }>("select pg_try_advisory_lock($1::int4, $2::int4) as locked", [SCAN_LOCK_NAMESPACE, SCAN_LOCK_KEY]);
    lockHeld = lockResult.rows[0]?.locked === true;
    if (!lockHeld) {
      const [running] = await db
        .select({ id: riskExceptionScanRuns.id })
        .from(riskExceptionScanRuns)
        .where(eq(riskExceptionScanRuns.status, "RUNNING"))
        .orderBy(desc(riskExceptionScanRuns.startedAt))
        .limit(1);
      return { ok: false, skippedReason: running ? `A scan (${running.id}) is already running.` : "A scan is already running." };
    }
    return await runScanWhileLocked(trigger, options);
  } finally {
    if (lockHeld) {
      try {
        await lockClient.query("select pg_advisory_unlock($1::int4, $2::int4)", [SCAN_LOCK_NAMESPACE, SCAN_LOCK_KEY]);
      } catch (err) {
        // Could not unlock cleanly — destroy the connection instead of
        // returning it to the pool, which releases the session lock
        // server-side and guarantees it can never leak to a later borrower.
        releaseError = err instanceof Error ? err : new Error(String(err));
        logger.error("exceptions_scan_lock_unlock_failed", { error: releaseError.message });
      }
    }
    lockClient.release(releaseError);
  }
}

/**
 * Test-only: takes the global scan lock on its own dedicated connection, as
 * a running sweep would, WITHOUT scanning anything. Returns a release
 * function, or null if another scan currently holds the lock. Lets a test
 * exercise the "scan already running" path deterministically — and
 * exercise the manual-scan route without sweeping every tenant in a shared
 * test database.
 */
export async function tryHoldExceptionScanLockForTests(): Promise<(() => Promise<void>) | null> {
  const client = await db.$client.connect();
  try {
    const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1::int4, $2::int4) as locked", [SCAN_LOCK_NAMESPACE, SCAN_LOCK_KEY]);
    if (result.rows[0]?.locked !== true) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query("select pg_advisory_unlock($1::int4, $2::int4)", [SCAN_LOCK_NAMESPACE, SCAN_LOCK_KEY]);
      client.release();
    } catch (err) {
      client.release(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

async function runScanWhileLocked(trigger: "SCHEDULED" | "MANUAL", options: RunScheduledScanOptions): Promise<RunScanResult> {
  // We hold the global scan lock, so no other sweep is running: any row
  // still RUNNING belongs to a process that died mid-scan.
  await db
    .update(riskExceptionScanRuns)
    .set({ status: "FAILED", completedAt: new Date(), errorMessage: "Abandoned: the scan did not complete (its process stopped while running)." })
    .where(eq(riskExceptionScanRuns.status, "RUNNING"));

  const scopedBrokerageIds = options.brokerageIds ? [...new Set(options.brokerageIds)] : null;

  const [scanRun] = await db.insert(riskExceptionScanRuns).values({ status: "RUNNING", trigger }).returning();
  const summary: ScanSummary = {
    scanRunId: scanRun.id,
    brokeragesScanned: 0,
    rulesEvaluated: 0,
    exceptionsCreated: 0,
    exceptionsUpdated: 0,
    exceptionsAutoResolved: 0,
    errors: 0,
  };

  try {
    let lastId = 0;
    for (;;) {
      if (scopedBrokerageIds && scopedBrokerageIds.length === 0) break;
      const page = await db
        .select({ id: brokerages.id })
        .from(brokerages)
        .where(scopedBrokerageIds ? and(gt(brokerages.id, lastId), inArray(brokerages.id, scopedBrokerageIds)) : gt(brokerages.id, lastId))
        .orderBy(brokerages.id)
        .limit(BROKERAGE_BATCH_SIZE);
      if (page.length === 0) break;
      for (const { id: brokerageId } of page) {
        await scanBrokerageForExceptions(brokerageId, summary);
        summary.brokeragesScanned += 1;
      }
      lastId = page[page.length - 1].id;
    }

    await db
      .update(riskExceptionScanRuns)
      .set({
        status: "COMPLETED",
        completedAt: new Date(),
        brokeragesScanned: summary.brokeragesScanned,
        rulesEvaluated: summary.rulesEvaluated,
        exceptionsCreated: summary.exceptionsCreated,
        exceptionsUpdated: summary.exceptionsUpdated,
        exceptionsAutoResolved: summary.exceptionsAutoResolved,
      })
      .where(eq(riskExceptionScanRuns.id, scanRun.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(riskExceptionScanRuns)
      .set({
        status: "FAILED",
        completedAt: new Date(),
        errorMessage: message,
        brokeragesScanned: summary.brokeragesScanned,
        rulesEvaluated: summary.rulesEvaluated,
        exceptionsCreated: summary.exceptionsCreated,
        exceptionsUpdated: summary.exceptionsUpdated,
        exceptionsAutoResolved: summary.exceptionsAutoResolved,
      })
      .where(eq(riskExceptionScanRuns.id, scanRun.id));
    throw err;
  }

  return { ok: true, summary };
}

/** One brokerage, every rule, plus auto-resolution — see the module comment for the full contract. Runs under its own fresh ambient correlation context (Step 2 hardening) — this is a time-driven sweep with no originating HTTP request, so every finding/event this brokerage's pass produces gets ONE consistent id, and any log lines emitted underneath (including by rule.scanBrokerage implementations) automatically carry it via @aee/events's currentCorrelationId()/logger, without this function needing to pass it down explicitly. */
async function scanBrokerageForExceptions(brokerageId: number, summary: ScanSummary): Promise<void> {
  return runWithCorrelationId(currentCorrelationId(), () => scanBrokerageForExceptionsInner(brokerageId, summary));
}

async function scanBrokerageForExceptionsInner(brokerageId: number, summary: ScanSummary): Promise<void> {
  const now = new Date();
  const correlationId = currentCorrelationId();
  logger.debug("exceptions_scan_brokerage_started", { brokerageId });
  incrementCounter("exceptions_scan_total", { trigger: "SCHEDULED" });

  const openRows = await db
    .select()
    .from(riskExceptions)
    .where(and(eq(riskExceptions.brokerageId, brokerageId), inArray(riskExceptions.status, [...OPEN_RISK_EXCEPTION_STATUSES])));
  const openByRule = new Map<string, RiskException[]>();
  for (const row of openRows) {
    const list = openByRule.get(row.ruleId) ?? [];
    list.push(row);
    openByRule.set(row.ruleId, list);
  }

  for (const rule of RISK_RULES) {
    summary.rulesEvaluated += 1;
    const openForRule = openByRule.get(rule.ruleId) ?? [];

    let findings: RiskFinding[];
    try {
      findings = await rule.scanBrokerage(brokerageId, now);
    } catch (err) {
      summary.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error("exceptions_rule_threw_scheduled_scan", { ruleId: rule.ruleId, brokerageId, error: message });
      for (const exception of openForRule) {
        await recordEvaluationFailure(exception.id, brokerageId, message).catch((e) => logger.error("exceptions_record_evaluation_failure_failed", { exceptionId: exception.id, brokerageId, error: e instanceof Error ? e.message : String(e) }));
      }
      continue; // absence of evidence from a failed evaluation is never treated as proof the condition cleared
    }

    const matchedDedupKeys = new Set(findings.map((f) => f.dedupKey));
    for (const finding of findings) {
      const result = await createOrUpdateException(finding, brokerageId, finding.propertyId, finding.transactionId, correlationId, null);
      if (result.outcome === "CREATED" || result.outcome === "NEW_OCCURRENCE" || result.outcome === "REOPENED") {
        summary.exceptionsCreated += 1;
      } else if (result.outcome === "UPDATED_STILL_OPEN") {
        summary.exceptionsUpdated += 1;
      }
    }

    for (const exception of openForRule) {
      if (matchedDedupKeys.has(exception.dedupKey)) continue; // still true this pass — createOrUpdateException already refreshed it above
      await autoResolveException(exception.id, brokerageId, {
        kind: "RULE_CONDITION_CLEARED",
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
      });
      summary.exceptionsAutoResolved += 1;
    }
  }
}

// ---------------------------------------------------------------------
// Handler registration — called by bootstrap.ts's registerExceptionEngine().
// ---------------------------------------------------------------------

const registeredEventTypes = new Set<AgentEngineEasyEventType>();

/** Registers handleExceptionDomainEvent for every event type at least one rule declares — idempotent, safe to call more than once (e.g. in tests). */
export function registerExceptionEventHandlers(): void {
  const seen = new Set<AgentEngineEasyEventType>();
  for (const rule of RISK_RULES) {
    for (const eventType of rule.triggerEventTypes) seen.add(eventType);
  }
  for (const eventType of seen) {
    if (registeredEventTypes.has(eventType)) continue;
    registerHandler(eventType, handleExceptionDomainEvent);
    registeredEventTypes.add(eventType);
  }
}
