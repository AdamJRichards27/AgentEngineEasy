// GP-1 — the manual lifecycle decision, without a database. Stored values are
// the ones already named on grow_opportunities. Reopening is refused because
// the domain has no such transition.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPPORTUNITY_ACTIVE_APPRAISAL,
  OPPORTUNITY_APPRAISAL_BOOKED_MANUAL,
  OPPORTUNITY_CONVERTED_LOCKED,
  OPPORTUNITY_CONVERTED_MANUAL,
  OPPORTUNITY_LOST_REASON_REQUIRED,
  OPPORTUNITY_REOPEN_UNSUPPORTED,
  applyGrowOpportunityLifecycle,
  parseGrowOpportunityLifecycleRequest,
} from "@aee/domain";

test("manual stages move in either direction, and appraisal stages are refused", () => {
  for (const stage of ["New", "Contacted", "Qualified"] as const) {
    const parsed = parseGrowOpportunityLifecycleRequest({ stage });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    const applied = applyGrowOpportunityLifecycle({
      command: parsed.command,
      status: "Open",
      stage: stage === "New" ? "Qualified" : "New",
      activeAppraisalLinked: false,
    });
    assert.equal(applied.ok, true);
    if (!applied.ok) continue;
    assert.equal(applied.patch.stage, stage);
    assert.equal(applied.patch.status, "Open");
    assert.equal(applied.patch.close, false);
  }

  const booked = parseGrowOpportunityLifecycleRequest({ stage: "AppraisalBooked" });
  assert.deepEqual(booked, { ok: false, status: 409, error: OPPORTUNITY_APPRAISAL_BOOKED_MANUAL });
  const converted = parseGrowOpportunityLifecycleRequest({ stage: "Converted" });
  assert.deepEqual(converted, { ok: false, status: 409, error: OPPORTUNITY_CONVERTED_MANUAL });
  const statusConverted = parseGrowOpportunityLifecycleRequest({ status: "Converted" });
  assert.deepEqual(statusConverted, { ok: false, status: 409, error: OPPORTUNITY_CONVERTED_MANUAL });
});

test("lost requires a reason and close keeps the current stage", () => {
  assert.deepEqual(parseGrowOpportunityLifecycleRequest({ status: "Lost" }), {
    ok: false,
    status: 400,
    error: OPPORTUNITY_LOST_REASON_REQUIRED,
  });
  assert.deepEqual(parseGrowOpportunityLifecycleRequest({ status: "Lost", lostReason: "   " }), {
    ok: false,
    status: 400,
    error: OPPORTUNITY_LOST_REASON_REQUIRED,
  });

  const lost = parseGrowOpportunityLifecycleRequest({ status: "Lost", lostReason: "  Seller said no  " });
  assert.equal(lost.ok, true);
  if (!lost.ok) return;
  const applied = applyGrowOpportunityLifecycle({
    command: lost.command,
    status: "Open",
    stage: "Contacted",
    activeAppraisalLinked: false,
  });
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual(applied.patch, { status: "Lost", stage: "Lost", lostReason: "Seller said no", close: true });

  const close = parseGrowOpportunityLifecycleRequest({ status: "Closed" });
  assert.equal(close.ok, true);
  if (!close.ok) return;
  const closed = applyGrowOpportunityLifecycle({
    command: close.command,
    status: "Open",
    stage: "Qualified",
    activeAppraisalLinked: false,
  });
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.equal(closed.patch.status, "Closed");
  assert.equal(closed.patch.stage, "Qualified");
  assert.equal(closed.patch.close, true);
});

test("an active appraisal, a converted row, and a lost or closed row cannot be changed by hand", () => {
  const stage = parseGrowOpportunityLifecycleRequest({ stage: "Contacted" });
  assert.equal(stage.ok, true);
  if (!stage.ok) return;

  const active = applyGrowOpportunityLifecycle({
    command: stage.command,
    status: "Open",
    stage: "AppraisalBooked",
    activeAppraisalLinked: true,
  });
  assert.deepEqual(active, { ok: false, status: 409, error: OPPORTUNITY_ACTIVE_APPRAISAL });

  const converted = applyGrowOpportunityLifecycle({
    command: stage.command,
    status: "Converted",
    stage: "Converted",
    activeAppraisalLinked: false,
  });
  assert.deepEqual(converted, { ok: false, status: 409, error: OPPORTUNITY_CONVERTED_LOCKED });

  for (const current of [
    { status: "Lost", stage: "Lost" },
    { status: "Closed", stage: "Qualified" },
    { status: "Lost", stage: "AppraisalBooked" },
  ]) {
    const refused = applyGrowOpportunityLifecycle({
      command: stage.command,
      status: current.status,
      stage: current.stage,
      activeAppraisalLinked: false,
    });
    assert.deepEqual(refused, { ok: false, status: 409, error: OPPORTUNITY_REOPEN_UNSUPPORTED });
  }

  assert.deepEqual(parseGrowOpportunityLifecycleRequest({ status: "Open" }), {
    ok: false,
    status: 409,
    error: OPPORTUNITY_REOPEN_UNSUPPORTED,
  });
});
