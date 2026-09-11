// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage F.
//
// Communications Hub integration for financial notices (Section 25). No
// other engine auto-drafts a communication today (Launch, Exception & Risk
// and Automation all surface their own material events through the
// Exception & Risk Engine and/or Property Timeline instead — see
// lib/exceptions/rules/financial.ts and lib/timeline.ts's own Stage F
// additions) — this is the first. Kept deliberately narrow and low-risk:
//
//  - Channel is always INTERNAL_NOTE (schema/communications.ts §6: "never
//    sent externally, and is filtered out of every external-facing read"),
//    so this can never itself place an unauthorised external send — it's
//    a note left on the property's communications thread for a human to
//    see, never a message that reaches a client or vendor on its own.
//  - createDraftMessage (lib/communications/messages.ts) ALWAYS creates a
//    DRAFT ("nothing here ever queues or sends" — that module's own doc
//    comment); notifyFinancialEvent inherits that guarantee for free
//    rather than re-implementing it, so this can never bypass the
//    approval/send flow requestApproval/approveMessage/sendMessageNow
//    already gate.
//  - Reuses one thread per property (subject FINANCIAL_NOTICES_SUBJECT)
//    rather than opening a new thread per notice, so a property's
//    financial notices read as one running log instead of a flood of
//    separate threads — the same "don't flood with minor updates"
//    reasoning lib/timeline.ts's own Launch-events comment gives for its
//    curated event subset.
//  - Never throws: a broken notification must not break the financial
//    write path that triggered it (same posture as events.ts's
//    emitFinancialEvent, for the same reason).
//
//  - AE Grow Priority 3: createDraftMessage no longer accepts propertyId
//    (or partyId) as a caller-supplied field — a message always
//    denormalises its anchor straight from its parent thread (see
//    lib/communications/messages.ts's own CreateDraftMessageInput doc
//    comment). findOrCreateFinancialNoticesThread already creates/finds
//    the thread with this notice's propertyId set, so the draft message
//    below still ends up with the identical propertyId as before this
//    change — nothing about this module's actual behaviour is different,
//    only how that value reaches the message row.

import { createThread, createDraftMessage, listThreadsForProperty } from "../communications/messages.js";
import { logger } from "@aee/events";

const FINANCIAL_NOTICES_SUBJECT = "Financial notices";

export interface NotifyFinancialEventInput {
  brokerageId: number;
  propertyId: number;
  transactionId?: number | null;
  /** The agent (or other authorised user) this note is attributed to as its author — always a real user id, per createDraftMessage's own contract. */
  createdByUserId: number;
  subject: string;
  bodyText: string;
}

async function findOrCreateFinancialNoticesThread(input: NotifyFinancialEventInput): Promise<number> {
  const existing = await listThreadsForProperty(input.propertyId, input.brokerageId);
  const match = existing.find((t) => t.subject === FINANCIAL_NOTICES_SUBJECT);
  if (match) return match.id;

  const thread = await createThread({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    transactionId: input.transactionId ?? null,
    subject: FINANCIAL_NOTICES_SUBJECT,
    createdByUserId: input.createdByUserId,
  });
  return thread.id;
}

/**
 * Leaves an INTERNAL_NOTE draft on the property's running "Financial
 * notices" thread. Called from a small, deliberately curated set of
 * material financial milestones (see call sites) — never for every
 * ledger-level state transition (financialLedgerEvents already records
 * those in full).
 */
export async function notifyFinancialEvent(input: NotifyFinancialEventInput): Promise<void> {
  try {
    const threadId = await findOrCreateFinancialNoticesThread(input);
    await createDraftMessage({
      threadId,
      brokerageId: input.brokerageId,
      transactionId: input.transactionId ?? null,
      channel: "INTERNAL_NOTE",
      classification: "TRANSACTIONAL",
      subject: input.subject,
      bodyText: input.bodyText,
      senderUserId: input.createdByUserId,
      createdByUserId: input.createdByUserId,
    });
  } catch (err) {
    logger.error("notify_financial_event_failed", { error: err });
  }
}
