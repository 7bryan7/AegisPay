import { vendorRecordSchema } from "./administration.js";
import { z } from "zod";
import { microUsdcStringSchema } from "./amounts.js";
import { purchaseOrderSchema, normalizedObligationSchema } from "./obligations.js";
import { payableExtractionSchema } from "./obligations.js";
import { treasurySnapshotSchema, payableActionSchema } from "./treasury.js";
import { cashEvidenceSchema, feeEvidenceSchema } from "./treasury-accounting.js";
import { discountComparisonSchema } from "./discounts.js";
import { payableApprovalSchema } from "./approvals.js";
import { approvalOfferSchema, ownerCorrectionsSchema } from "./invoice-review.js";

export const apSessionSchema = z.discriminatedUnion("authenticated", [
  z.strictObject({ authenticated: z.literal(false), loginAvailable: z.boolean() }),
  z.strictObject({ authenticated: z.literal(true), role: z.enum(["OPERATOR", "REVIEWER"]),
    csrfToken: z.string(), expiresAt: z.iso.datetime() })
]);
export const invoiceSummarySchema = z.strictObject({
  id: z.uuid(), status: z.enum(["RECEIVED", "EXTRACTING", "OPEN", "SETTLED", "REJECTED"]),
  version: z.number().int().positive(), invoiceNumber: z.string().nullable(), vendorName: z.string().nullable(),
  amountMicroUsdc: microUsdcStringSchema.nullable(), dueDate: z.string().nullable(), createdAt: z.iso.datetime(),
  decision: z.enum(["PAY_NOW", "SCHEDULE", "HOLD", "REQUIRE_APPROVAL", "REJECT"]).nullable(),
  paymentState: z.enum(["RESERVED", "SUBMITTING", "PENDING", "UNKNOWN", "SETTLED", "FAILED", "CANCELLED"]).nullable()
});
export const invoiceListSchema = z.strictObject({ invoices: z.array(invoiceSummarySchema), nextOffset: z.number().int().nullable() });
export const decisionEvidenceSchema = z.object({ available: z.boolean(), snapshot: treasurySnapshotSchema.optional(),
  cash: cashEvidenceSchema.optional(), fee: feeEvidenceSchema.optional(),
  availableMicroUsdc: microUsdcStringSchema.optional(), dailyHeadroomMicroUsdc: microUsdcStringSchema.optional(),
  categoryHeadroomMicroUsdc: microUsdcStringSchema.optional(), totalHeldMicroUsdc: microUsdcStringSchema.optional(),
  reflectedHeldMicroUsdc: microUsdcStringSchema.optional(), evidenceReferences: z.array(z.string()).optional(),
  ledgerAsOf: z.iso.datetime().optional(), ledgerFingerprint: z.string().optional(),
  discountComparison: discountComparisonSchema.nullable().optional(), annualCashPreservationCostBps: z.number().int().optional() });
export const decisionViewSchema = z.strictObject({ id: z.uuid(), action: z.string(), reason: z.string(), evidenceIds: z.array(z.string()), evaluatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(), nextEvaluationAt: z.iso.datetime().nullable().optional(),
  versions: z.strictObject({ invoice: z.number().int(), policy: z.number().int(), vendor: z.number().int().nullable(), purchaseOrder: z.number().int().nullable() }).optional(),
  candidate: z.strictObject({ id: z.string(), action: payableActionSchema, amountMicroUsdc: microUsdcStringSchema,
    executeAt: z.iso.datetime().nullable(), evidenceIds: z.array(z.string()) }).nullable().optional(),
  treasury: decisionEvidenceSchema.optional(), alternativeConsidered: z.string().nullable().optional(), similarInvoiceIds: z.array(z.uuid()).optional() });
export const paymentSubmissionIssueSchema = z.strictObject({
  code: z.enum(["CIRCLE_NOT_CONFIGURED", "CIRCLE_INVALID_RESPONSE", "CIRCLE_UNAVAILABLE", "CIRCLE_TERMS_MISMATCH", "CIRCLE_WALLET_MISMATCH", "CIRCLE_FEE_LIMIT"]),
  stage: z.enum(["VALIDATION", "WALLET_CHECK", "TRANSFER_REQUEST", "TRANSFER_RESPONSE"]),
  httpStatus: z.number().int().min(100).max(599).nullable(), providerCode: z.string().regex(/^[0-9]{1,9}$/).nullable(), requestId: z.uuid().nullable()
});
export type PaymentSubmissionIssue = z.infer<typeof paymentSubmissionIssueSchema>;
export const invoiceDetailSchema = z.strictObject({
  invoice: invoiceSummarySchema, facts: normalizedObligationSchema.nullable(),
  source: z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.enum(["image/png", "image/jpeg"]).nullable(),
    byteSize: z.number().int().positive().nullable(), retained: z.boolean(), uploadedBy: z.string().nullable() }).optional(),
  verification: z.strictObject({ status: z.enum(["VERIFIED", "HOLD", "REJECT"]), reasons: z.array(z.string()) }).optional(),
  registry: z.strictObject({ vendor: vendorRecordSchema.nullable(), purchaseOrder: purchaseOrderSchema.nullable() }).optional(),
  approvalOffer: approvalOfferSchema.nullable().optional(),
  review: z.strictObject({ originalExtraction: payableExtractionSchema.nullable(), latestExtraction: payableExtractionSchema.nullable(),
    corrections: ownerCorrectionsSchema, revisions: z.array(z.strictObject({ version: z.number().int(), actorId: z.string(), action: z.string(),
      reason: z.string(), createdAt: z.iso.datetime() })) }).optional(),
  decision: decisionViewSchema.nullable(),
  payment: z.strictObject({ id: z.uuid().optional(), state: z.string(), providerId: z.string().nullable(), providerState: z.string().nullable(),
    submissionIssue: paymentSubmissionIssueSchema.nullable().optional(),
    transactionHash: z.string().nullable(), settledAt: z.iso.datetime().nullable(), actualFeeMicroUsdc: microUsdcStringSchema.nullable(),
    verificationReference: z.string().nullable(),
    payoutAmountMicroUsdc: microUsdcStringSchema.optional(), nominalAmountMicroUsdc: microUsdcStringSchema.optional(),
    discountAdjustmentMicroUsdc: microUsdcStringSchema.optional() }).nullable(),
  processingMessage: z.string()
});
export const auditSchema = z.strictObject({ events: z.array(z.strictObject({
  key: z.string(), type: z.string(), version: z.number().int(), createdAt: z.iso.datetime(), actorId: z.string().optional(), reason: z.string().nullable().optional()
})), decision: invoiceDetailSchema.shape.decision.optional(), payment: invoiceDetailSchema.shape.payment.optional(),
  invoice: invoiceSummarySchema.optional(), facts: normalizedObligationSchema.nullable().optional(),
  decisions: z.array(decisionViewSchema).optional(), approvals: z.array(payableApprovalSchema).optional(),
  corrections: z.array(z.strictObject({ version: z.number().int(), actorId: z.string(), action: z.string(), reason: z.string(),
    createdAt: z.iso.datetime(), fields: ownerCorrectionsSchema })).optional(), truncated: z.boolean().optional() });
export const treasuryOverviewSchema = z.strictObject({
  status: z.enum(["AVAILABLE", "UNAVAILABLE"]), reason: z.string().nullable(),
  capturedAt: z.iso.datetime().nullable(), blockNumber: z.string().nullable(), blockHash: z.string().nullable(),
  cashMicroUsdc: microUsdcStringSchema.nullable(), spendableMicroUsdc: microUsdcStringSchema.nullable(),
  protectedObligationsMicroUsdc: microUsdcStringSchema.nullable(), reflectedHoldsMicroUsdc: microUsdcStringSchema.nullable(),
  dailySettledMicroUsdc: microUsdcStringSchema.nullable(), dailyHoldsMicroUsdc: microUsdcStringSchema.nullable(), dailyHeadroomMicroUsdc: microUsdcStringSchema.nullable(),
  categories: z.array(z.strictObject({ category: z.string(), settledMicroUsdc: microUsdcStringSchema, holdsMicroUsdc: microUsdcStringSchema, headroomMicroUsdc: microUsdcStringSchema })),
  upcoming: z.array(z.strictObject({ purchaseOrderId: z.string(), amountMicroUsdc: microUsdcStringSchema, dueDate: z.string(), essential: z.boolean(), accepted: z.boolean() })),
  futureFeeMessage: z.literal("Spendable cash includes existing fee holds; a new transfer requires a fresh fee estimate.")
});
export type TreasuryOverview = z.infer<typeof treasuryOverviewSchema>;
export const treasuryViewSchema = z.strictObject({
  network: z.literal("Arc Testnet"), configuredMode: z.enum(["disabled", "fixture", "arc_testnet"]),
  dispatchEnabled: z.boolean(), screening: z.literal("local_registry"),
  walletAddress: z.string().nullable(), paused: z.boolean(),
  cashMicroUsdc: microUsdcStringSchema.nullable(), holdsMicroUsdc: microUsdcStringSchema.nullable(),
  minimumReserveMicroUsdc: microUsdcStringSchema.nullable(),
  overview: treasuryOverviewSchema.optional(),
  message: z.string()
});
export const uploadResultSchema = z.strictObject({ obligationId: z.uuid(), status: z.string(), reused: z.boolean() });
export const approvalResultSchema = z.strictObject({ approvalId: z.uuid(), expiresAt: z.iso.datetime() });
export type ApSession = z.infer<typeof apSessionSchema>;
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;
export type InvoiceList = z.infer<typeof invoiceListSchema>;
export type AuditView = z.infer<typeof auditSchema>;
export type TreasuryView = z.infer<typeof treasuryViewSchema>;
