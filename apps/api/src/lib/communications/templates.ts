// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Templates for Launch/Transaction/PC events (Section 14): versioned,
// approved-placeholder-only. A template's subject/body may only reference
// placeholder keys it has explicitly declared in `placeholders` — this
// mirrors the Exception & Risk Engine's RISK_EXCEPTION_METADATA_ALLOW_LIST
// convention (lib/exceptions/types.ts), applied here to outbound message
// content instead of exception metadata: an undeclared token is a
// build-time mistake to reject, never something rendering papers over.
//
// Versioning is immutable-by-append: a previous version's content is never
// edited in place (communicationMessages snapshots templateId +
// templateVersion at send time, so a later edit could never rewrite what a
// historical message says it said), and at most one version per
// (brokerageId, templateKey) is ever ACTIVE — activating a new one retires
// the last.
//
// brokerageId = null rows are system-wide defaults available to every
// tenant; a brokerage may layer its own template under the same
// templateKey, which takes precedence when both are ACTIVE.

import { and, eq, isNull, or, desc } from "drizzle-orm";
import { db, communicationTemplates, type CommunicationTemplate } from "@aee/db";
import { logAudit } from "../audit.js";
import { CommunicationTenancyError } from "./types.js";
import type { CommunicationChannel, CommunicationClassification } from "./types.js";

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export class CommunicationTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommunicationTemplateError";
  }
}

export type CommunicationTemplateCategory = "LAUNCH" | "TRANSACTION" | "PC_EVENT" | "GENERAL";
export type CommunicationTemplateStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

/** Every {{placeholder}} token referenced anywhere in a template's content. */
export function extractPlaceholderTokens(...parts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const match of part.matchAll(PLACEHOLDER_PATTERN)) found.add(match[1]);
  }
  return [...found];
}

/**
 * The allow-list gate: every token actually used in subject/bodyText/bodyHtml
 * must appear in `declaredPlaceholders`. Called both when a template is
 * saved (so an undeclared placeholder is rejected long before it could ever
 * be sent) and again defensively at render time.
 */
export function assertPlaceholdersDeclared(
  content: { subject?: string | null; bodyText: string; bodyHtml?: string | null },
  declaredPlaceholders: string[],
): void {
  const used = extractPlaceholderTokens(content.subject, content.bodyText, content.bodyHtml);
  const undeclared = used.filter((token) => !declaredPlaceholders.includes(token));
  if (undeclared.length > 0) {
    throw new CommunicationTemplateError(
      `This template uses placeholder(s) not declared in its approved list: ${undeclared.join(", ")}.`,
    );
  }
}

export interface CreateTemplateInput {
  brokerageId: number;
  templateKey: string;
  name: string;
  channel: CommunicationChannel;
  classification: CommunicationClassification;
  category: CommunicationTemplateCategory;
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  placeholders: string[];
  createdByUserId: number;
}

/** Always inserts version 1 of a new templateKey. Use createTemplateVersion to add a version to an existing key. */
export async function createTemplate(input: CreateTemplateInput): Promise<CommunicationTemplate> {
  assertPlaceholdersDeclared(input, input.placeholders);

  const [row] = await db
    .insert(communicationTemplates)
    .values({
      brokerageId: input.brokerageId,
      templateKey: input.templateKey,
      name: input.name,
      channel: input.channel,
      classification: input.classification,
      category: input.category,
      version: 1,
      status: "DRAFT",
      subject: input.subject ?? null,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml ?? null,
      placeholders: input.placeholders,
      createdByUserId: input.createdByUserId,
    })
    .returning();

  await logAudit({
    userId: input.createdByUserId,
    action: "communication_template_created",
    recordType: "communication_template",
    recordId: String(row.id),
    updatedValue: `${row.templateKey} v${row.version}`,
  });

  return row;
}

export interface CreateTemplateVersionInput {
  brokerageId: number;
  templateId: number;
  name?: string;
  subject?: string | null;
  bodyText?: string;
  bodyHtml?: string | null;
  placeholders?: string[];
  createdByUserId: number;
}

/** Clones an existing template row into a new DRAFT version — never edits a previous version's content in place. */
export async function createTemplateVersion(input: CreateTemplateVersionInput): Promise<CommunicationTemplate> {
  const [existing] = await db
    .select()
    .from(communicationTemplates)
    .where(and(eq(communicationTemplates.id, input.templateId), eq(communicationTemplates.brokerageId, input.brokerageId)));
  if (!existing || existing.brokerageId !== input.brokerageId) throw new CommunicationTenancyError();

  const [latest] = await db
    .select()
    .from(communicationTemplates)
    .where(and(eq(communicationTemplates.brokerageId, input.brokerageId), eq(communicationTemplates.templateKey, existing.templateKey)))
    .orderBy(desc(communicationTemplates.version))
    .limit(1);

  const merged = {
    subject: input.subject !== undefined ? input.subject : existing.subject,
    bodyText: input.bodyText ?? existing.bodyText,
    bodyHtml: input.bodyHtml !== undefined ? input.bodyHtml : existing.bodyHtml,
    placeholders: input.placeholders ?? ((existing.placeholders as string[]) ?? []),
  };
  assertPlaceholdersDeclared(merged, merged.placeholders);

  const [row] = await db
    .insert(communicationTemplates)
    .values({
      brokerageId: existing.brokerageId,
      templateKey: existing.templateKey,
      name: input.name ?? existing.name,
      channel: existing.channel,
      classification: existing.classification,
      category: existing.category,
      version: (latest?.version ?? existing.version) + 1,
      status: "DRAFT",
      subject: merged.subject,
      bodyText: merged.bodyText,
      bodyHtml: merged.bodyHtml,
      placeholders: merged.placeholders,
      createdByUserId: input.createdByUserId,
    })
    .returning();

  await logAudit({
    userId: input.createdByUserId,
    action: "communication_template_versioned",
    recordType: "communication_template",
    recordId: String(row.id),
    previousValue: `${existing.templateKey} v${existing.version}`,
    updatedValue: `${row.templateKey} v${row.version}`,
  });

  return row;
}

/** DRAFT -> ACTIVE. Retires (ARCHIVED) any other ACTIVE row sharing this templateKey+brokerageId, so at most one version is ever live at a time. */
export async function activateTemplate(templateId: number, brokerageId: number, userId: number): Promise<CommunicationTemplate> {
  const [existing] = await db
    .select()
    .from(communicationTemplates)
    .where(and(eq(communicationTemplates.id, templateId), eq(communicationTemplates.brokerageId, brokerageId)));
  if (!existing || existing.brokerageId !== brokerageId) throw new CommunicationTenancyError();
  if (existing.status !== "DRAFT") {
    throw new CommunicationTemplateError(`Only a DRAFT template can be activated (this one is ${existing.status}).`);
  }
  assertPlaceholdersDeclared(existing, (existing.placeholders as string[]) ?? []);

  const previouslyActive = await db
    .select()
    .from(communicationTemplates)
    .where(
      and(
        eq(communicationTemplates.brokerageId, brokerageId),
        eq(communicationTemplates.templateKey, existing.templateKey),
        eq(communicationTemplates.status, "ACTIVE"),
      ),
    );

  const now = new Date();
  for (const prior of previouslyActive) {
    await db
      .update(communicationTemplates)
      .set({ status: "ARCHIVED", updatedAt: now })
      .where(and(eq(communicationTemplates.id, prior.id), eq(communicationTemplates.brokerageId, brokerageId)));
  }

  const [row] = await db
    .update(communicationTemplates)
    .set({ status: "ACTIVE", activatedAt: now, updatedAt: now })
    .where(and(eq(communicationTemplates.id, templateId), eq(communicationTemplates.brokerageId, brokerageId)))
    .returning();
  if (!row) throw new CommunicationTenancyError();

  await logAudit({
    userId,
    action: "communication_template_activated",
    recordType: "communication_template",
    recordId: String(row.id),
    updatedValue: `${row.templateKey} v${row.version}`,
  });

  return row;
}

export async function archiveTemplate(templateId: number, brokerageId: number, userId: number): Promise<CommunicationTemplate> {
  const [existing] = await db
    .select()
    .from(communicationTemplates)
    .where(and(eq(communicationTemplates.id, templateId), eq(communicationTemplates.brokerageId, brokerageId)));
  if (!existing || existing.brokerageId !== brokerageId) throw new CommunicationTenancyError();
  if (existing.status === "ARCHIVED") return existing;

  const [row] = await db
    .update(communicationTemplates)
    .set({ status: "ARCHIVED", updatedAt: new Date() })
    .where(and(eq(communicationTemplates.id, templateId), eq(communicationTemplates.brokerageId, brokerageId)))
    .returning();
  if (!row) throw new CommunicationTenancyError();

  await logAudit({
    userId,
    action: "communication_template_archived",
    recordType: "communication_template",
    recordId: String(row.id),
    updatedValue: `${row.templateKey} v${row.version}`,
  });

  return row;
}

export interface ListTemplatesFilter {
  channel?: CommunicationChannel;
  category?: CommunicationTemplateCategory;
  status?: CommunicationTemplateStatus;
}

/** A brokerage's own templates plus every system-wide default (brokerageId null) — the composer's full pick-list. */
export async function listTemplatesForBrokerage(brokerageId: number, filter: ListTemplatesFilter = {}): Promise<CommunicationTemplate[]> {
  const conditions = [or(eq(communicationTemplates.brokerageId, brokerageId), isNull(communicationTemplates.brokerageId))!];
  if (filter.channel) conditions.push(eq(communicationTemplates.channel, filter.channel));
  if (filter.category) conditions.push(eq(communicationTemplates.category, filter.category));
  if (filter.status) conditions.push(eq(communicationTemplates.status, filter.status));

  return db
    .select()
    .from(communicationTemplates)
    .where(and(...conditions))
    .orderBy(desc(communicationTemplates.updatedAt));
}

/**
 * The single-ACTIVE-version lookup the send/compose flow actually uses. A
 * brokerage's own ACTIVE template for this key takes precedence over the
 * system-wide default; returns null if neither exists.
 */
export async function getActiveTemplateByKey(brokerageId: number, templateKey: string): Promise<CommunicationTemplate | null> {
  const rows = await db
    .select()
    .from(communicationTemplates)
    .where(
      and(
        or(eq(communicationTemplates.brokerageId, brokerageId), isNull(communicationTemplates.brokerageId)),
        eq(communicationTemplates.templateKey, templateKey),
        eq(communicationTemplates.status, "ACTIVE"),
      ),
    );
  if (rows.length === 0) return null;
  const brokerageOwned = rows.find((r) => r.brokerageId === brokerageId);
  return brokerageOwned ?? rows[0];
}

export interface RenderedTemplate {
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
}

/**
 * Substitutes {{placeholder}} tokens with `values`. Defensive by design
 * (Section 42 forbids fabricating certainty): a token used in content but
 * not in the template's declared allow-list, or a declared token with no
 * supplied value, both throw rather than silently sending a raw `{{...}}`
 * or a blank to a real recipient.
 */
export function renderTemplate(
  template: Pick<CommunicationTemplate, "subject" | "bodyText" | "bodyHtml" | "placeholders">,
  values: Record<string, string>,
): RenderedTemplate {
  const declared = (template.placeholders as string[]) ?? [];
  assertPlaceholdersDeclared(template, declared);

  const used = extractPlaceholderTokens(template.subject, template.bodyText, template.bodyHtml);
  const missing = used.filter((token) => values[token] === undefined || values[token] === null);
  if (missing.length > 0) {
    throw new CommunicationTemplateError(`Missing value(s) for placeholder(s): ${missing.join(", ")}.`);
  }

  const substitute = (text: string | null): string | null => {
    if (text == null) return null;
    return text.replace(PLACEHOLDER_PATTERN, (_full, token) => values[token] ?? "");
  };

  return {
    subject: substitute(template.subject),
    bodyText: substitute(template.bodyText) as string,
    bodyHtml: substitute(template.bodyHtml),
  };
}
