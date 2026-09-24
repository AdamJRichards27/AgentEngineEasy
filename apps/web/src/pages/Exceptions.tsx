// Agent Engine 2.0 — Exception & Risk Engine (Priority 4), §18.
//
// Cross-property operational view. Explicitly a foundation for the future
// Agent Daily Command Centre / Brokerage Dashboard, NOT those dashboards
// themselves (Build Instructions §18) — one filtered, paginated list over
// GET /exceptions, plus (Brokerage Administrator only) the engine's own
// health/manual-scan ops surface. An Agent/Pit Crew sees only exceptions
// on properties they're the agent for; the server enforces that
// restriction (restrictedPropertyIdsFor in routes/exceptions.ts) — this
// page never filters client-side for tenant/ownership scoping, only for
// display convenience (severity/status/search).

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, apiErrorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import {
  type CrossPropertyExceptionsResponse,
  OPEN_EXCEPTION_STATUSES,
  severityLabel,
  severityPillClass,
  statusLabel,
  formatDueDate,
  isOverdue,
} from "../lib/riskExceptions";

interface ScanRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  trigger: string;
  brokeragesScanned: number;
  rulesEvaluated: number;
  exceptionsCreated: number;
  exceptionsUpdated: number;
  exceptionsAutoResolved: number;
  errorMessage: string | null;
}

const SEVERITY_OPTIONS = ["CRITICAL", "AT_RISK", "ATTENTION", "INFORMATION"];
const PAGE_SIZE = 25;

export default function Exceptions() {
  const { user } = useSession();
  const isAdmin = user?.role === "Brokerage Administrator";
  const queryClient = useQueryClient();

  const [severity, setSeverity] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const params = new URLSearchParams();
  if (severity) params.set("severity", severity);
  if (openOnly) params.set("status", OPEN_EXCEPTION_STATUSES.join(","));
  if (overdueOnly) params.set("overdueOnly", "true");
  if (search.trim()) params.set("search", search.trim());
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  const queryString = params.toString();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["risk-exceptions", queryString],
    queryFn: () => apiFetch<CrossPropertyExceptionsResponse>(`/exceptions?${queryString}`),
  });

  const opsHealth = useQuery({
    queryKey: ["risk-exceptions-ops-health"],
    queryFn: () => apiFetch<{ recentRuns: ScanRun[] }>("/exceptions/ops/health"),
    enabled: isAdmin,
  });

  const triggerScan = useMutation({
    mutationFn: () => apiFetch<{ summary: unknown }>("/exceptions/ops/scan", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["risk-exceptions-ops-health"] });
      queryClient.invalidateQueries({ queryKey: ["risk-exceptions"] });
    },
  });

  const updateFilter = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  return (
    <div>
      <div className="primary-action">
        <div className="eyebrow">Risk & Compliance</div>
        <h1>Exceptions</h1>
        <p className="muted">
          Compliance and workflow exceptions across every property you can see — a foundation for the Command Centre,
          not the Command Centre itself.
        </p>
      </div>

      <section className="card">
        <h2>Filters</h2>
        <div className="inline-form">
          <label>
            Severity
            <select value={severity} onChange={(e) => updateFilter(() => setSeverity(e.target.value))}>
              <option value="">All</option>
              {SEVERITY_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {severityLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search
            <input
              value={search}
              onChange={(e) => updateFilter(() => setSearch(e.target.value))}
              placeholder="Title or description…"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(e) => updateFilter(() => setOpenOnly(e.target.checked))}
              style={{ display: "inline", width: "auto", marginRight: "0.4rem" }}
            />
            Open only
          </label>
          <label>
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(e) => updateFilter(() => setOverdueOnly(e.target.checked))}
              style={{ display: "inline", width: "auto", marginRight: "0.4rem" }}
            />
            Overdue only
          </label>
        </div>
      </section>

      {isAdmin && (
        <section className="card">
          <h2>Engine Health</h2>
          <button className="btn btn-small" onClick={() => triggerScan.mutate()} disabled={triggerScan.isPending}>
            Run Scan Now
          </button>
          {triggerScan.isError && <p className="error-text">{apiErrorMessage(triggerScan.error, "Couldn't run the scan. Try again.")}</p>}
          {opsHealth.data && opsHealth.data.recentRuns.length > 0 ? (
            <ul className="item-list">
              {opsHealth.data.recentRuns.map((r) => (
                <li key={r.id}>
                  <span className={r.status === "FAILED" ? "pill pill-danger" : r.status === "COMPLETED" ? "pill pill-success" : "pill"}>
                    {r.status}
                  </span>{" "}
                  {r.trigger} scan · started {formatDueDate(r.startedAt)}
                  <div className="muted">
                    {r.brokeragesScanned} brokerage{r.brokeragesScanned === 1 ? "" : "s"}, {r.rulesEvaluated} rule
                    {r.rulesEvaluated === 1 ? "" : "s"} evaluated · {r.exceptionsCreated} created, {r.exceptionsUpdated} updated,{" "}
                    {r.exceptionsAutoResolved} auto-resolved
                    {r.errorMessage && ` · ${r.errorMessage}`}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No scan runs recorded yet.</p>
          )}
        </section>
      )}

      <section className="card">
        <h2>Exceptions{typeof data?.total === "number" ? ` (${data.total})` : ""}</h2>
        {isLoading && <p className="muted">Loading…</p>}
        {isError && <p className="error-text">{apiErrorMessage(error, "Couldn't load exceptions. Try again.")}</p>}
        {!isLoading && !isError && (data?.exceptions.length ?? 0) === 0 && <p className="muted">No exceptions match these filters.</p>}
        {!isLoading && !isError && (data?.exceptions.length ?? 0) > 0 && (
          <>
            <ul className="item-list">
              {data!.exceptions.map((e) => (
                <li key={e.id}>
                  <Link href={`/properties/${e.propertyId}`}>
                    <span className={severityPillClass(e.severity)}>{severityLabel(e.severity)}</span>{" "}
                    <strong>{e.title}</strong> — {e.propertyAddress ?? `Property #${e.propertyId}`}
                  </Link>
                  <div className="muted">
                    {statusLabel(e.status)}
                    {e.ownerName ? ` · ${e.ownerName}` : ""}
                    {e.dueAt && (
                      <>
                        {" · "}
                        {isOverdue(e.dueAt) ? "overdue " : "due "}
                        {formatDueDate(e.dueAt)}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="inline-form" style={{ marginTop: "0.75rem" }}>
              <button className="btn btn-small" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>
                Previous
              </button>
              <span className="muted">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, data!.total)} of {data!.total}
              </span>
              <button
                className="btn btn-small"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= data!.total}
              >
                Next
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
