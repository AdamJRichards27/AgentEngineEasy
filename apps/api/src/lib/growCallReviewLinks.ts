// E-8 — the call-review join.
//
// Reads and writes grow_call_review_links. Proposing, listing, and the
// pending-commitments provenance all use these columns. They do not parse
// ai_action_requests.resource_id. Execution stamps commitment_id on the
// same row once createApprovedGrowCommitment has inserted the Open
// commitment. A proposal is not that commitment, and this module never
// approves or executes one.

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  aiActionRequests,
  db,
  growCallReviewLinks,
  growCommitments,
  type AiActionRequest,
  type GrowCallReviewLink,
  type GrowCallReviewLinkItemType,
} from "@aee/db";

export const CALL_REVIEW_ITEM_ID_MAX = 128;

export const callReviewLinkSchema = z.object({
  callSessionId: z.number().int().positive(),
  transcriptionId: z.number().int().positive(),
  itemType: z.enum(["COMMITMENT", "FOLLOWUP"]),
  itemId: z.string().min(1).max(CALL_REVIEW_ITEM_ID_MAX),
}).strict();

export type CallReviewLinkInput = z.infer<typeof callReviewLinkSchema>;

export type CallReviewProvenance = CallReviewLinkInput & { source: "call_review" };

export function callReviewProvenance(link: Pick<
  GrowCallReviewLink,
  "callSessionId" | "transcriptionId" | "itemType" | "itemId"
>): CallReviewProvenance {
  return {
    source: "call_review",
    callSessionId: link.callSessionId,
    transcriptionId: link.transcriptionId,
    itemType: link.itemType as GrowCallReviewLinkItemType,
    itemId: link.itemId,
  };
}

export async function ensureCallReviewLink(input: CallReviewLinkInput & {
  brokerageId: number;
  actionRequestId: number;
}): Promise<void> {
  await db.insert(growCallReviewLinks).values({
    brokerageId: input.brokerageId,
    callSessionId: input.callSessionId,
    transcriptionId: input.transcriptionId,
    itemType: input.itemType,
    itemId: input.itemId,
    actionRequestId: input.actionRequestId,
  }).onConflictDoNothing({ target: growCallReviewLinks.actionRequestId });
}

/**
 * Sets commitment_id after governed execution. No-op when this proposal
 * did not come from a call review (no link row) or the commitment is not
 * in this brokerage. Does not insert a commitment.
 */
export async function attachCommitmentToCallReviewLink(input: {
  brokerageId: number;
  actionRequestId: number;
  commitmentId: number;
}): Promise<void> {
  const [commitment] = await db.select({ id: growCommitments.id }).from(growCommitments).where(and(
    eq(growCommitments.id, input.commitmentId),
    eq(growCommitments.brokerageId, input.brokerageId),
  )).limit(1);
  if (!commitment) return;
  await db.update(growCallReviewLinks).set({
    commitmentId: commitment.id,
    updatedAt: new Date(),
  }).where(and(
    eq(growCallReviewLinks.actionRequestId, input.actionRequestId),
    eq(growCallReviewLinks.brokerageId, input.brokerageId),
    isNull(growCallReviewLinks.commitmentId),
  ));
}

export async function listCallReviewLinkRequests(input: {
  brokerageId: number;
  transcriptionId: number;
  itemType?: GrowCallReviewLinkItemType;
  itemId?: string;
}): Promise<Array<{ link: GrowCallReviewLink; request: AiActionRequest }>> {
  const filters = [
    eq(growCallReviewLinks.brokerageId, input.brokerageId),
    eq(growCallReviewLinks.transcriptionId, input.transcriptionId),
    eq(aiActionRequests.brokerageId, input.brokerageId),
    eq(aiActionRequests.actionKey, "CREATE_GROW_COMMITMENT"),
  ];
  if (input.itemType !== undefined) filters.push(eq(growCallReviewLinks.itemType, input.itemType));
  if (input.itemId !== undefined) filters.push(eq(growCallReviewLinks.itemId, input.itemId));
  const rows = await db.select({
    link: growCallReviewLinks,
    request: aiActionRequests,
  }).from(growCallReviewLinks).innerJoin(
    aiActionRequests,
    eq(growCallReviewLinks.actionRequestId, aiActionRequests.id),
  ).where(and(...filters)).orderBy(desc(aiActionRequests.createdAt), desc(aiActionRequests.id));
  return rows;
}

export async function callReviewProvenanceForRequests(
  brokerageId: number,
  actionRequestIds: number[],
): Promise<Map<number, CallReviewProvenance>> {
  const provenance = new Map<number, CallReviewProvenance>();
  if (actionRequestIds.length === 0) return provenance;
  const rows = await db.select().from(growCallReviewLinks).where(and(
    eq(growCallReviewLinks.brokerageId, brokerageId),
    inArray(growCallReviewLinks.actionRequestId, actionRequestIds),
  ));
  for (const row of rows) provenance.set(row.actionRequestId, callReviewProvenance(row));
  return provenance;
}
