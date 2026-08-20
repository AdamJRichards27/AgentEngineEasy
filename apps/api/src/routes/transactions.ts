import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, transactions } from "@aee/db";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import {
  getTransactionByProperty,
  recordContractSigned,
  recordFinanceApproved,
  scheduleSettlement,
  completeSettlement,
  calculateCommission,
  recordFundsReceived,
  recordAgentPaid,
  closeTransaction,
} from "../lib/transactions.js";

export const transactionsRouter = Router();

transactionsRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const transaction = await getTransactionByProperty(propertyId);
  res.json({ transaction });
});

transactionsRouter.get("/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!transaction) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ transaction });
});

async function handle(fn: () => Promise<unknown>, res: import("express").Response): Promise<void> {
  try {
    const transaction = await fn();
    res.json({ transaction });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

transactionsRouter.post("/:id/contract-signed", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(() => recordContractSigned({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

transactionsRouter.post("/:id/finance-approved", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(() => recordFinanceApproved({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

const settlementScheduleSchema = z.object({ settlementDate: z.coerce.date() });

transactionsRouter.post("/:id/settlement-schedule", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = settlementScheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  await handle(
    () =>
      scheduleSettlement({
        transactionId: id,
        userId: user.id,
        brokerageId: user.brokerageId,
        settlementDate: parsed.data.settlementDate,
      }),
    res,
  );
});

transactionsRouter.post("/:id/settlement-complete", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(() => completeSettlement({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

transactionsRouter.post("/:id/calculate-commission", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(
    () => calculateCommission({ transactionId: id, userId: user.id, brokerageId: user.brokerageId, force: req.body?.force === true }),
    res,
  );
});

const fundsReceivedSchema = z.object({ amountCents: z.number().int().positive() });

transactionsRouter.post("/:id/funds-received", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = fundsReceivedSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  await handle(
    () =>
      recordFundsReceived({
        transactionId: id,
        userId: user.id,
        brokerageId: user.brokerageId,
        amountCents: parsed.data.amountCents,
      }),
    res,
  );
});

// Financial disbursement sign-off — restricted to Brokerage Administrators,
// same precedent as refunds (Phase 6) and AML exception resolution (Phase 4):
// anything that finalises a recorded financial outcome isn't a routine
// self-certified agent action.
transactionsRouter.post("/:id/agent-paid", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(() => recordAgentPaid({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

// Final sign-off — same Brokerage Administrator gate as agent-paid above.
transactionsRouter.post("/:id/close", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(() => closeTransaction({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});
