import { z } from "zod";
import { invoiceSummarySchema } from "./payables-api.js";
import { microUsdcStringSchema } from "./amounts.js";
import { payableActionSchema } from "./treasury.js";

export const workspaceQuerySchema = z.strictObject({ offset: z.coerce.number().int().min(0).max(10000).default(0),
  q: z.string().trim().max(120).default(""), decision: payableActionSchema.optional(),
  status: invoiceSummarySchema.shape.status.optional(),
  queue: z.enum(["open_actions", "rejected"]).optional(),
  sort: z.enum(["due_asc", "due_desc", "amount_asc", "amount_desc", "created_desc"]).optional() });
export type WorkspaceQuery = z.infer<typeof workspaceQuerySchema>;
export const workspaceInvoiceSchema = invoiceSummarySchema.extend({ reason: z.string().nullable(), nextEvaluationAt: z.iso.datetime().nullable() });
export const workspaceInvoiceListSchema = z.strictObject({ invoices: z.array(workspaceInvoiceSchema), total: z.number().int().nonnegative(), nextOffset: z.number().int().nullable() });
export const activityEventSchema = z.strictObject({ key: z.string(), entityId: z.string(), invoiceId: z.uuid().nullable(),
  type: z.string(), version: z.number().int(), actorId: z.string(), reason: z.string().nullable(), createdAt: z.iso.datetime() });
export const activityListSchema = z.strictObject({ events: z.array(activityEventSchema), nextOffset: z.number().int().nullable() });
export const workspaceSummarySchema = z.strictObject({ capturedAt: z.iso.datetime(), counts: z.strictObject({
  total: z.number().int().nonnegative(), processing: z.number().int().nonnegative(), approvals: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(), scheduled: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(), settled: z.number().int().nonnegative() }),
  recentInvoices: z.array(workspaceInvoiceSchema), actionQueue: z.array(workspaceInvoiceSchema), recentActivity: z.array(activityEventSchema) });
export const paymentRowSchema = z.strictObject({ id: z.uuid(), invoiceId: z.uuid(), invoiceNumber: z.string().nullable(), vendorName: z.string().nullable(),
  state: invoiceSummarySchema.shape.paymentState.unwrap(), sender: z.string(), recipient: z.string().nullable(),
  amountMicroUsdc: microUsdcStringSchema, feeAllowanceMicroUsdc: microUsdcStringSchema, actualFeeMicroUsdc: microUsdcStringSchema.nullable(),
  nominalAmountMicroUsdc: microUsdcStringSchema, discountAdjustmentMicroUsdc: microUsdcStringSchema,
  chainId: z.number().int(), token: z.string(), providerId: z.string().nullable(), providerState: z.string().nullable(),
  transactionHash: z.string().nullable(), verificationReference: z.string().nullable(), createdAt: z.iso.datetime(), settledAt: z.iso.datetime().nullable() });
export const paymentListSchema = z.strictObject({ payments: z.array(paymentRowSchema), nextOffset: z.number().int().nullable() });
export const readinessSchema = z.strictObject({ status: z.enum(["ready", "unavailable"]), configuredMode: z.enum(["disabled", "fixture", "arc_testnet"]),
  dependencies: z.boolean(), authentication: z.boolean(), storage: z.boolean(), extractionWorker: z.boolean(), paymentWorker: z.boolean(), dispatchEnabled: z.boolean() });
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceInvoiceList = z.infer<typeof workspaceInvoiceListSchema>;
export type PaymentRow = z.infer<typeof paymentRowSchema>;
export type PaymentList = z.infer<typeof paymentListSchema>;
export type ActivityList = z.infer<typeof activityListSchema>;
export type Readiness = z.infer<typeof readinessSchema>;
