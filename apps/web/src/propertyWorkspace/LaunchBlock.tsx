// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { formatDueDate, isOverdue, EXCEPTION_OWNER_TYPES, ownerTypeLabel } from "../lib/riskExceptions";
// Agent Engine 2.0 — Property Launch & Campaign Coordination. Mirrors
// riskExceptions.ts's own "shared types + display helpers" module
// immediately above — see lib/launchPlan.ts's own header comment for why
// LAUNCH_OWNER_TYPES isn't re-imported from there too (it's
// EXCEPTION_OWNER_TYPES verbatim, reused from the import above instead).
import {
  type LaunchPlanDetail,
  LAUNCH_TEMPLATE_TYPES,
  CAMPAIGN_ITEM_TYPES,
  CAMPAIGN_ITEM_STATUSES,
  VENDOR_APPROVAL_TYPES,
  launchStatusLabel,
  launchStatusPillClass,
  templateTypeLabel,
  campaignItemTypeLabel,
  campaignItemStatusLabel,
  campaignItemStatusPillClass,
  portalStatusLabel,
  portalStatusPillClass,
  vendorApprovalTypeLabel,
  vendorApprovalStatusLabel,
  vendorApprovalStatusPillClass,
} from "../lib/launchPlan";
import { formatCents } from "./types";

// Agent Engine 2.0 — Property Launch & Campaign Coordination. The full
// operational surface behind the "Launch — Campaign & Portals" details
// section: template + target date, campaign items (status/responsibility/
// vendor+cost/evidence), budget, vendor approvals, portal destinations,
// Market Ready, Listing Live, and pause/resume/cancel. `onAction` is a
// single path-plus-body dispatcher (mirrors TransactionBlockView's own
// `onAction` prop below) rather than one callback per endpoint — Launch's
// HTTP surface is too wide (~20 routes) for that to stay readable.
// `errorFor`/`pendingPath` let each individual control show only its own
// in-flight/error state, the same scoping transactionAction's own
// `variables?.action === "unconditional"` check already does for a single
// control further down this file.
export function LaunchBlock({
  detail,
  onAction,
  pendingPath,
  errorFor,
}: {
  detail: LaunchPlanDetail;
  onAction: (path: string, body?: Record<string, unknown>) => void;
  pendingPath: string | null;
  errorFor: (path: string) => string | null;
}) {
  const { plan, items, destinations, approvals } = detail;

  const [targetDate, setTargetDate] = useState("");
  const [newItemType, setNewItemType] = useState<(typeof CAMPAIGN_ITEM_TYPES)[number]>("PHOTOGRAPHY");
  const [newItemTitle, setNewItemTitle] = useState("");
  const [itemStatusChoice, setItemStatusChoice] = useState<Record<string, string>>({});
  const [itemBlockedReason, setItemBlockedReason] = useState<Record<string, string>>({});
  const [itemVendorName, setItemVendorName] = useState<Record<string, string>>({});
  const [itemCostDollars, setItemCostDollars] = useState<Record<string, string>>({});
  const [itemOwnerType, setItemOwnerType] = useState<Record<string, string>>({});
  const [itemEvidenceLabel, setItemEvidenceLabel] = useState<Record<string, string>>({});
  const [itemEvidenceUrl, setItemEvidenceUrl] = useState<Record<string, string>>({});
  const [budgetDollars, setBudgetDollars] = useState("");
  const [approvalDecisionAmount, setApprovalDecisionAmount] = useState<Record<string, string>>({});
  const [approvalDecisionNotes, setApprovalDecisionNotes] = useState<Record<string, string>>({});
  const [approvalRequestType, setApprovalRequestType] = useState<(typeof VENDOR_APPROVAL_TYPES)[number]>("BUDGET");
  const [approvalRequestItem, setApprovalRequestItem] = useState("");
  const [approvalRequestAmount, setApprovalRequestAmount] = useState("");
  const [newPortalName, setNewPortalName] = useState("");
  const [portalUrlInput, setPortalUrlInput] = useState<Record<string, string>>({});
  const [portalFailReason, setPortalFailReason] = useState<Record<string, string>>({});
  const [overrideReason, setOverrideReason] = useState("");
  const [pauseReason, setPauseReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  const marketReady = plan.marketReadyEvaluatedAt !== null && plan.marketReadyBlockers.length === 0;
  const canPauseOrCancel = plan.status !== "CANCELLED" && plan.status !== "LISTING_LIVE" && plan.status !== "PAUSED";

  return (
    <div className="stack">
      <div>
        <span className={launchStatusPillClass(plan.status)}>{launchStatusLabel(plan.status)}</span>{" "}
        {plan.status === "PAUSED" && plan.pauseReason && <span className="muted">— {plan.pauseReason}</span>}
        {plan.status === "CANCELLED" && plan.cancelReason && <span className="muted">— {plan.cancelReason}</span>}
        {plan.status === "LISTING_LIVE" && plan.actualLaunchDate && <span className="muted"> — went live {formatDueDate(plan.actualLaunchDate)}</span>}
      </div>

      {plan.status === "PAUSED" && (
        <div>
          <button className="btn btn-small" onClick={() => onAction(`/launch/${plan.id}/resume`)} disabled={pendingPath === `/launch/${plan.id}/resume`}>
            Resume Launch
          </button>
          {errorFor(`/launch/${plan.id}/resume`) && <p className="error-text">{errorFor(`/launch/${plan.id}/resume`)}</p>}
        </div>
      )}

      {canPauseOrCancel && (
        <details>
          <summary className="muted">Pause or cancel this launch</summary>
          <div className="inline-form" style={{ marginTop: "0.5rem" }}>
            <input value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} placeholder="Reason to pause (required)" />
            <button
              className="btn btn-small"
              onClick={() => {
                onAction(`/launch/${plan.id}/pause`, { reason: pauseReason.trim() });
                setPauseReason("");
              }}
              disabled={!pauseReason.trim() || pendingPath === `/launch/${plan.id}/pause`}
            >
              Pause
            </button>
          </div>
          {errorFor(`/launch/${plan.id}/pause`) && <p className="error-text">{errorFor(`/launch/${plan.id}/pause`)}</p>}
          <div className="inline-form" style={{ marginTop: "0.5rem" }}>
            <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Reason to cancel (required)" />
            <button
              className="btn btn-small btn-danger"
              onClick={() => {
                onAction(`/launch/${plan.id}/cancel`, { reason: cancelReason.trim() });
                setCancelReason("");
              }}
              disabled={!cancelReason.trim() || pendingPath === `/launch/${plan.id}/cancel`}
            >
              Cancel Launch
            </button>
          </div>
          {errorFor(`/launch/${plan.id}/cancel`) && <p className="error-text">{errorFor(`/launch/${plan.id}/cancel`)}</p>}
        </details>
      )}

      <div>
        <h3>Campaign template</h3>
        <p className="muted">
          {templateTypeLabel(plan.templateType)}
          {items.length === 0 ? " — no campaign items yet." : ""}
        </p>
        {items.length === 0 && (
          <>
            <div className="inline-form">
              {LAUNCH_TEMPLATE_TYPES.filter((t) => t !== "CUSTOM").map((t) => (
                <button
                  key={t}
                  className="btn btn-small"
                  onClick={() => onAction(`/launch/${plan.id}/template`, { templateType: t })}
                  disabled={pendingPath === `/launch/${plan.id}/template`}
                >
                  Apply {templateTypeLabel(t)}
                </button>
              ))}
            </div>
            {errorFor(`/launch/${plan.id}/template`) && <p className="error-text">{errorFor(`/launch/${plan.id}/template`)}</p>}
            <p className="muted">Or build a custom campaign by adding items directly below.</p>
          </>
        )}
      </div>

      <div>
        <h3>Target launch date</h3>
        <p className="muted">{plan.targetLaunchDate ? formatDueDate(plan.targetLaunchDate) : "Not set"}</p>
        <div className="inline-form">
          <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          <button
            className="btn btn-small"
            onClick={() => onAction(`/launch/${plan.id}/target-date`, { targetLaunchDate: targetDate })}
            disabled={!targetDate || pendingPath === `/launch/${plan.id}/target-date`}
          >
            Set Date
          </button>
        </div>
        {errorFor(`/launch/${plan.id}/target-date`) && <p className="error-text">{errorFor(`/launch/${plan.id}/target-date`)}</p>}
      </div>

      <div>
        <h3>Campaign items</h3>
        {items.length === 0 ? (
          <p className="muted">No campaign items yet.</p>
        ) : (
          <ul className="item-list">
            {items.map((item) => {
              const statusPath = `/launch/campaign-items/${item.id}/status`;
              const responsibilityPath = `/launch/campaign-items/${item.id}/responsibility`;
              const vendorCostPath = `/launch/campaign-items/${item.id}/vendor-cost`;
              const evidencePath = `/launch/campaign-items/${item.id}/evidence`;
              const chosenStatus = itemStatusChoice[item.id] ?? item.status;
              return (
                <li key={item.id}>
                  <div>
                    <span className={campaignItemStatusPillClass(item.status)}>{campaignItemStatusLabel(item.status)}</span>{" "}
                    <strong>{item.title}</strong> <span className="muted">({campaignItemTypeLabel(item.itemType)})</span>
                    {item.dueAt && (
                      <span className={isOverdue(item.dueAt) && item.status !== "COMPLETE" ? "pill pill-danger" : "muted"} style={{ marginLeft: "0.5rem" }}>
                        {isOverdue(item.dueAt) && item.status !== "COMPLETE" ? "Overdue " : "Due "}
                        {formatDueDate(item.dueAt)}
                      </span>
                    )}
                  </div>
                  <p className="muted" style={{ marginBottom: "0.4rem" }}>
                    {ownerTypeLabel(item.responsibleOwnerType)}
                    {item.vendorName && ` · ${item.vendorName}`}
                    {item.costCents > 0 && ` · ${formatCents(item.costCents)}`}
                    {item.blockedReason && ` · Blocked: ${item.blockedReason}`}
                  </p>

                  <div className="inline-form">
                    <select value={chosenStatus} onChange={(e) => setItemStatusChoice((prev) => ({ ...prev, [item.id]: e.target.value }))}>
                      {CAMPAIGN_ITEM_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {campaignItemStatusLabel(s)}
                        </option>
                      ))}
                    </select>
                    {chosenStatus === "BLOCKED" && (
                      <input
                        value={itemBlockedReason[item.id] ?? ""}
                        onChange={(e) => setItemBlockedReason((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="Reason (required)"
                      />
                    )}
                    <button
                      className="btn btn-small"
                      onClick={() =>
                        onAction(statusPath, {
                          status: chosenStatus,
                          blockedReason: chosenStatus === "BLOCKED" ? (itemBlockedReason[item.id] ?? "").trim() : undefined,
                        })
                      }
                      disabled={
                        chosenStatus === item.status || (chosenStatus === "BLOCKED" && !(itemBlockedReason[item.id] ?? "").trim()) || pendingPath === statusPath
                      }
                    >
                      Update Status
                    </button>
                  </div>
                  {errorFor(statusPath) && <p className="error-text">{errorFor(statusPath)}</p>}

                  <details style={{ marginTop: "0.5rem" }}>
                    <summary className="muted">View Details</summary>

                    <div className="inline-form" style={{ marginTop: "0.5rem" }}>
                      <select
                        value={itemOwnerType[item.id] ?? item.responsibleOwnerType}
                        onChange={(e) => setItemOwnerType((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      >
                        {EXCEPTION_OWNER_TYPES.map((o) => (
                          <option key={o} value={o}>
                            {ownerTypeLabel(o)}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-small"
                        onClick={() => onAction(responsibilityPath, { ownerType: itemOwnerType[item.id] ?? item.responsibleOwnerType, ownerUserId: null })}
                        disabled={pendingPath === responsibilityPath}
                      >
                        Reassign
                      </button>
                    </div>
                    {errorFor(responsibilityPath) && <p className="error-text">{errorFor(responsibilityPath)}</p>}

                    <div className="inline-form" style={{ marginTop: "0.5rem" }}>
                      <input
                        value={itemVendorName[item.id] ?? item.vendorName ?? ""}
                        onChange={(e) => setItemVendorName((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="Vendor name"
                      />
                      <input
                        value={itemCostDollars[item.id] ?? (item.costCents ? (item.costCents / 100).toFixed(2) : "")}
                        onChange={(e) => setItemCostDollars((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="Cost ($)"
                      />
                      <button
                        className="btn btn-small"
                        onClick={() =>
                          onAction(vendorCostPath, {
                            vendorName: (itemVendorName[item.id] ?? item.vendorName ?? "").trim() || null,
                            costCents: Math.round(Number(itemCostDollars[item.id] ?? (item.costCents / 100).toFixed(2)) * 100),
                          })
                        }
                        disabled={pendingPath === vendorCostPath}
                      >
                        Save Vendor & Cost
                      </button>
                    </div>
                    {errorFor(vendorCostPath) && <p className="error-text">{errorFor(vendorCostPath)}</p>}

                    {item.evidence.length > 0 && (
                      <ul className="plain">
                        {item.evidence.map((e, i) => (
                          <li key={i}>
                            <a href={e.url} target="_blank" rel="noreferrer">
                              {e.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="inline-form" style={{ marginTop: "0.5rem" }}>
                      <input
                        value={itemEvidenceLabel[item.id] ?? ""}
                        onChange={(e) => setItemEvidenceLabel((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="Evidence label (e.g. Signed brochure proof)"
                      />
                      <input
                        value={itemEvidenceUrl[item.id] ?? ""}
                        onChange={(e) => setItemEvidenceUrl((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="URL"
                      />
                      <button
                        className="btn btn-small"
                        onClick={() => {
                          onAction(evidencePath, { label: (itemEvidenceLabel[item.id] ?? "").trim(), url: (itemEvidenceUrl[item.id] ?? "").trim() });
                          setItemEvidenceLabel((prev) => ({ ...prev, [item.id]: "" }));
                          setItemEvidenceUrl((prev) => ({ ...prev, [item.id]: "" }));
                        }}
                        disabled={!(itemEvidenceLabel[item.id] ?? "").trim() || !(itemEvidenceUrl[item.id] ?? "").trim() || pendingPath === evidencePath}
                      >
                        Attach Evidence
                      </button>
                    </div>
                    {errorFor(evidencePath) && <p className="error-text">{errorFor(evidencePath)}</p>}
                  </details>
                </li>
              );
            })}
          </ul>
        )}

        <details style={{ marginTop: "0.5rem" }}>
          <summary className="muted">+ Add campaign item</summary>
          <div className="inline-form" style={{ marginTop: "0.5rem" }}>
            <select value={newItemType} onChange={(e) => setNewItemType(e.target.value as (typeof CAMPAIGN_ITEM_TYPES)[number])}>
              {CAMPAIGN_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {campaignItemTypeLabel(t)}
                </option>
              ))}
            </select>
            <input value={newItemTitle} onChange={(e) => setNewItemTitle(e.target.value)} placeholder="Title" />
            <button
              className="btn btn-small"
              onClick={() => {
                onAction(`/launch/${plan.id}/campaign-items`, { itemType: newItemType, title: newItemTitle.trim() });
                setNewItemTitle("");
              }}
              disabled={!newItemTitle.trim() || pendingPath === `/launch/${plan.id}/campaign-items`}
            >
              Add Item
            </button>
          </div>
          {errorFor(`/launch/${plan.id}/campaign-items`) && <p className="error-text">{errorFor(`/launch/${plan.id}/campaign-items`)}</p>}
        </details>
      </div>

      <div>
        <h3>Budget</h3>
        <p className={plan.budgetCents > 0 && plan.budgetSpentCents > plan.budgetCents ? "error-text" : "muted"}>
          {formatCents(plan.budgetSpentCents)} spent of {plan.budgetCents > 0 ? formatCents(plan.budgetCents) : "no budget set"}
        </p>
        <div className="inline-form">
          <input value={budgetDollars} onChange={(e) => setBudgetDollars(e.target.value)} placeholder="Budget ($)" />
          <button
            className="btn btn-small"
            onClick={() => onAction(`/launch/${plan.id}/budget`, { budgetCents: Math.round(Number(budgetDollars || "0") * 100) })}
            disabled={!budgetDollars || pendingPath === `/launch/${plan.id}/budget`}
          >
            Set Budget
          </button>
        </div>
        {errorFor(`/launch/${plan.id}/budget`) && <p className="error-text">{errorFor(`/launch/${plan.id}/budget`)}</p>}
        <p className="muted">Setting the budget and deciding an approval both require a Brokerage Administrator.</p>
      </div>

      <div>
        <h3>Vendor & budget approvals</h3>
        {approvals.length === 0 ? (
          <p className="muted">No approvals requested yet.</p>
        ) : (
          <ul className="item-list">
            {approvals.map((a) => {
              const decidePath = `/launch/vendor-approvals/${a.id}/decide`;
              const pendingDecision = a.status === "PENDING" || a.status === "CHANGES_REQUESTED";
              return (
                <li key={a.id}>
                  <div>
                    <span className={vendorApprovalStatusPillClass(a.status)}>{vendorApprovalStatusLabel(a.status)}</span>{" "}
                    <strong>{vendorApprovalTypeLabel(a.approvalType)}</strong> — {formatCents(a.requestedAmountCents)}
                  </div>
                  {a.decisionNotes && <p className="muted">{a.decisionNotes}</p>}
                  {pendingDecision && (
                    <div className="stack">
                      <input
                        value={approvalDecisionAmount[a.id] ?? (a.requestedAmountCents / 100).toFixed(2)}
                        onChange={(e) => setApprovalDecisionAmount((prev) => ({ ...prev, [a.id]: e.target.value }))}
                        placeholder="Approved amount ($)"
                      />
                      <input
                        value={approvalDecisionNotes[a.id] ?? ""}
                        onChange={(e) => setApprovalDecisionNotes((prev) => ({ ...prev, [a.id]: e.target.value }))}
                        placeholder="Decision notes"
                      />
                      <div className="inline-form">
                        <button
                          className="btn btn-small"
                          onClick={() =>
                            onAction(decidePath, {
                              decision: "APPROVED",
                              approvedAmountCents: Math.round(Number(approvalDecisionAmount[a.id] ?? (a.requestedAmountCents / 100).toFixed(2)) * 100),
                              decisionNotes: (approvalDecisionNotes[a.id] ?? "").trim() || null,
                            })
                          }
                          disabled={pendingPath === decidePath}
                        >
                          Approve
                        </button>
                        <button
                          className="btn btn-small"
                          onClick={() => onAction(decidePath, { decision: "CHANGES_REQUESTED", decisionNotes: (approvalDecisionNotes[a.id] ?? "").trim() || null })}
                          disabled={pendingPath === decidePath}
                        >
                          Request Changes
                        </button>
                        <button
                          className="btn btn-small btn-danger"
                          onClick={() => onAction(decidePath, { decision: "REJECTED", decisionNotes: (approvalDecisionNotes[a.id] ?? "").trim() || null })}
                          disabled={pendingPath === decidePath}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  )}
                  {errorFor(decidePath) && <p className="error-text">{errorFor(decidePath)}</p>}
                </li>
              );
            })}
          </ul>
        )}

        <details style={{ marginTop: "0.5rem" }}>
          <summary className="muted">+ Request an approval</summary>
          <div className="inline-form" style={{ marginTop: "0.5rem" }}>
            <select value={approvalRequestType} onChange={(e) => setApprovalRequestType(e.target.value as (typeof VENDOR_APPROVAL_TYPES)[number])}>
              {VENDOR_APPROVAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {vendorApprovalTypeLabel(t)}
                </option>
              ))}
            </select>
            {approvalRequestType === "CAMPAIGN_ITEM_COST" && (
              <select value={approvalRequestItem} onChange={(e) => setApprovalRequestItem(e.target.value)}>
                <option value="">Select campaign item…</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            )}
            <input value={approvalRequestAmount} onChange={(e) => setApprovalRequestAmount(e.target.value)} placeholder="Amount ($)" />
            <button
              className="btn btn-small"
              onClick={() => {
                onAction(`/launch/${plan.id}/vendor-approvals`, {
                  approvalType: approvalRequestType,
                  campaignItemId: approvalRequestType === "CAMPAIGN_ITEM_COST" ? approvalRequestItem || null : null,
                  requestedAmountCents: Math.round(Number(approvalRequestAmount || "0") * 100),
                });
                setApprovalRequestAmount("");
              }}
              disabled={!approvalRequestAmount || (approvalRequestType === "CAMPAIGN_ITEM_COST" && !approvalRequestItem) || pendingPath === `/launch/${plan.id}/vendor-approvals`}
            >
              Request Approval
            </button>
          </div>
          {errorFor(`/launch/${plan.id}/vendor-approvals`) && <p className="error-text">{errorFor(`/launch/${plan.id}/vendor-approvals`)}</p>}
        </details>
      </div>

      <div>
        <h3>Portal destinations</h3>
        {destinations.length === 0 ? (
          <p className="muted">No portal destinations added yet.</p>
        ) : (
          <ul className="item-list">
            {destinations.map((d) => {
              const submitPath = `/launch/portal-destinations/${d.id}/submit`;
              const failPath = `/launch/portal-destinations/${d.id}/fail`;
              const livePath = `/launch/portal-destinations/${d.id}/live`;
              return (
                <li key={d.id}>
                  <div>
                    <span className={portalStatusPillClass(d.status)}>{portalStatusLabel(d.status)}</span> <strong>{d.portalName}</strong>
                  </div>
                  {d.listingUrl && (
                    <p className="muted">
                      <a href={d.listingUrl} target="_blank" rel="noreferrer">
                        {d.listingUrl}
                      </a>
                    </p>
                  )}
                  {d.failureReason && <p className="muted">Failure: {d.failureReason}</p>}

                  {(d.status === "NOT_STARTED" || d.status === "READY_TO_SUBMIT" || d.status === "FAILED") && (
                    <div className="inline-form">
                      <input
                        value={portalUrlInput[d.id] ?? ""}
                        onChange={(e) => setPortalUrlInput((prev) => ({ ...prev, [d.id]: e.target.value }))}
                        placeholder="Listing URL (optional)"
                      />
                      <button
                        className="btn btn-small"
                        onClick={() => onAction(submitPath, { listingUrl: (portalUrlInput[d.id] ?? "").trim() || undefined })}
                        disabled={pendingPath === submitPath}
                      >
                        Mark Submitted
                      </button>
                    </div>
                  )}
                  {errorFor(submitPath) && <p className="error-text">{errorFor(submitPath)}</p>}

                  {d.status === "SUBMITTED" && (
                    <>
                      <div className="inline-form">
                        <input
                          value={portalUrlInput[d.id] ?? ""}
                          onChange={(e) => setPortalUrlInput((prev) => ({ ...prev, [d.id]: e.target.value }))}
                          placeholder="Listing URL (optional)"
                        />
                        <button
                          className="btn btn-small"
                          onClick={() => onAction(livePath, { listingUrl: (portalUrlInput[d.id] ?? "").trim() || undefined })}
                          disabled={pendingPath === livePath}
                        >
                          Confirm Live
                        </button>
                      </div>
                      {errorFor(livePath) && <p className="error-text">{errorFor(livePath)}</p>}
                      <div className="inline-form">
                        <input
                          value={portalFailReason[d.id] ?? ""}
                          onChange={(e) => setPortalFailReason((prev) => ({ ...prev, [d.id]: e.target.value }))}
                          placeholder="Failure reason (required)"
                        />
                        <button
                          className="btn btn-small btn-danger"
                          onClick={() => {
                            onAction(failPath, { failureReason: (portalFailReason[d.id] ?? "").trim() });
                            setPortalFailReason((prev) => ({ ...prev, [d.id]: "" }));
                          }}
                          disabled={!(portalFailReason[d.id] ?? "").trim() || pendingPath === failPath}
                        >
                          Mark Failed
                        </button>
                      </div>
                      {errorFor(failPath) && <p className="error-text">{errorFor(failPath)}</p>}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="inline-form" style={{ marginTop: "0.5rem" }}>
          <input value={newPortalName} onChange={(e) => setNewPortalName(e.target.value)} placeholder="Portal name (e.g. realestate.com.au)" />
          <button
            className="btn btn-small"
            onClick={() => {
              onAction(`/launch/${plan.id}/portal-destinations`, { portalName: newPortalName.trim() });
              setNewPortalName("");
            }}
            disabled={!newPortalName.trim() || pendingPath === `/launch/${plan.id}/portal-destinations`}
          >
            + Add Portal Destination
          </button>
        </div>
        {errorFor(`/launch/${plan.id}/portal-destinations`) && <p className="error-text">{errorFor(`/launch/${plan.id}/portal-destinations`)}</p>}
      </div>

      <div>
        <h3>Market Ready</h3>
        {marketReady ? (
          <p className="pill pill-success">Ready</p>
        ) : (
          <>
            <p className="muted">Not yet ready:</p>
            <ul className="plain">
              {plan.marketReadyBlockers.map((b, i) => (
                <li key={i} className="muted">
                  {b.message}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="inline-form">
          <button className="btn btn-small" onClick={() => onAction(`/launch/${plan.id}/market-ready/evaluate`)} disabled={pendingPath === `/launch/${plan.id}/market-ready/evaluate`}>
            Re-evaluate
          </button>
        </div>
        {errorFor(`/launch/${plan.id}/market-ready/evaluate`) && <p className="error-text">{errorFor(`/launch/${plan.id}/market-ready/evaluate`)}</p>}

        {plan.marketReadyOverriddenAt ? (
          <p className="muted">Overridden: {plan.marketReadyOverrideReason}</p>
        ) : (
          !marketReady && (
            <details style={{ marginTop: "0.5rem" }}>
              <summary className="muted">Override Market Ready</summary>
              <div className="inline-form" style={{ marginTop: "0.5rem" }}>
                <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Reason (required)" />
                <button
                  className="btn btn-small"
                  onClick={() => {
                    onAction(`/launch/${plan.id}/market-ready/override`, { reason: overrideReason.trim() });
                    setOverrideReason("");
                  }}
                  disabled={!overrideReason.trim() || pendingPath === `/launch/${plan.id}/market-ready/override`}
                >
                  Override
                </button>
              </div>
              {errorFor(`/launch/${plan.id}/market-ready/override`) && <p className="error-text">{errorFor(`/launch/${plan.id}/market-ready/override`)}</p>}
            </details>
          )
        )}
      </div>

      {plan.status !== "LISTING_LIVE" && plan.status !== "CANCELLED" && (
        <div>
          <h3>Listing Live</h3>
          <button className="btn btn-primary" onClick={() => onAction(`/launch/${plan.id}/confirm-live`)} disabled={pendingPath === `/launch/${plan.id}/confirm-live`}>
            Confirm Listing Live
          </button>
          {errorFor(`/launch/${plan.id}/confirm-live`) && <p className="error-text">{errorFor(`/launch/${plan.id}/confirm-live`)}</p>}
        </div>
      )}
    </div>
  );
}
