import { z } from "zod";
import { normalizePayableExtraction, payableExtractionSchema, type NormalizationResult } from "./obligations.js";
import { approvalTermsSchema } from "./approvals.js";

export const reviewableInvoiceFields = payableExtractionSchema.omit({ lineItems: true }).keyof();
export const ownerCorrectionSchema = z.strictObject({
  value: z.string().trim().min(1).max(4000).nullable(),
  evidenceReference: z.string().trim().min(1).max(1000)
});
export const ownerCorrectionsSchema = z.partialRecord(reviewableInvoiceFields, ownerCorrectionSchema);
export const invoiceCommandSchema = z.strictObject({
  commandId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(2000)
});
export const invoiceCorrectionSchema = invoiceCommandSchema.extend({
  fields: ownerCorrectionsSchema.refine((fields) => Object.keys(fields).length > 0, "Supply at least one correction")
});
export const invoiceEvaluationSchema = invoiceCommandSchema.extend({ reextract: z.boolean().default(false) });
export const invoiceMutationResultSchema = z.strictObject({
  obligationId: z.uuid(), version: z.number().int().positive(), status: z.enum(["RECEIVED", "OPEN", "REJECTED"])
});
export type InvoiceCorrection = z.infer<typeof invoiceCorrectionSchema>;
export type InvoiceCommand = z.infer<typeof invoiceCommandSchema>;
export type InvoiceEvaluation = z.infer<typeof invoiceEvaluationSchema>;
export type InvoiceMutationResult = z.infer<typeof invoiceMutationResultSchema>;
export const paymentReconciliationRequestSchema = z.strictObject({ reason: z.string().trim().min(1).max(2000) });
export const paymentReconciliationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("NO_UNRESOLVED") }),
  z.strictObject({ status: z.literal("WAITING"), intentId: z.uuid(), reason: z.string() }),
  z.strictObject({ status: z.literal("FAILED"), intentId: z.uuid(), providerState: z.string() }),
  z.strictObject({ status: z.literal("SETTLED"), intentId: z.uuid(), transactionHash: z.string() }),
  z.strictObject({ status: z.literal("UNCHANGED"), intentId: z.uuid(), state: z.string() })
]);
export type PaymentReconciliationResult = z.infer<typeof paymentReconciliationResultSchema>;
export const approvalOfferSchema = z.strictObject({ decisionId: z.uuid(), expectedVersion: z.number().int().positive(),
  termsHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.iso.datetime(), terms: approvalTermsSchema });
export const invoiceApprovalRequestSchema = approvalOfferSchema.omit({ expiresAt: true, terms: true }).extend({ reason: z.string().trim().min(1).max(2000) });
export type ApprovalOffer = z.infer<typeof approvalOfferSchema>;

/** Operator evidence is separate from model output. Internal normalized values
 * may use it, but it must never be relabeled as a visible model/source excerpt. */
export function normalizeReviewedExtraction(raw: unknown, corrections: unknown,
  identity: { businessId: string; id: string; version: number }): NormalizationResult {
  const reviewed = ownerCorrectionsSchema.safeParse(corrections ?? {});
  if (!reviewed.success) return { status: "HOLD", reasons: ["INVALID_OWNER_CORRECTIONS"] };
  if (!Object.keys(reviewed.data).length) return normalizePayableExtraction(raw, identity);
  const parsed = payableExtractionSchema.safeParse(raw);
  const original = parsed.success ? parsed.data : payableExtractionSchema.parse({
    ...Object.fromEntries(reviewableInvoiceFields.options.map((key) => [key, { value: null, status: "MISSING", sourceText: null }])), lineItems: []
  });
  const effective = structuredClone(original);
  for (const key of reviewableInvoiceFields.options) {
    const correction = reviewed.data[key];
    if (correction) effective[key] = { value: correction.value, status: correction.value === null ? "MISSING" : "EXTRACTED",
      sourceText: correction.value }; // Intermediate normalization only; provenance is replaced below.
  }
  const normalized = normalizePayableExtraction(effective, identity);
  if (normalized.status !== "NORMALIZED") return normalized;
  const aliases: Record<string, string> = { purchaseOrderReference: "purchaseOrderId", subtotal: "subtotalMicroUsdc",
    tax: "taxMicroUsdc", total: "amountMicroUsdc" };
  for (const key of reviewableInvoiceFields.options) {
    const correction = reviewed.data[key];
    if (!correction) continue;
    const evidence = normalized.obligation.evidence.find((item) => item.field === (aliases[key] ?? key));
    if (evidence && correction.value !== null) {
      evidence.status = "OPERATOR_VERIFIED";
      evidence.rawText = original[key].sourceText;
      evidence.sourceReference = correction.evidenceReference;
    }
  }
  return normalized;
}
