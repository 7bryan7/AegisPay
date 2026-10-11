import { z } from "zod";
import { microUsdcStringSchema } from "./amounts.js";
import { normalizedObligationSchema } from "./obligations.js";

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
export const invoiceDetailSchema = z.strictObject({
  invoice: invoiceSummarySchema, facts: normalizedObligationSchema.nullable(),
  decision: z.strictObject({ id: z.uuid(), action: z.string(), reason: z.string(), evidenceIds: z.array(z.string()), evaluatedAt: z.iso.datetime() }).nullable(),
  payment: z.strictObject({ state: z.string(), providerId: z.string().nullable(), providerState: z.string().nullable(),
    transactionHash: z.string().nullable(), settledAt: z.iso.datetime().nullable(), actualFeeMicroUsdc: microUsdcStringSchema.nullable(),
    verificationReference: z.string().nullable() }).nullable(),
  processingMessage: z.string()
});
export const auditSchema = z.strictObject({ events: z.array(z.strictObject({
  key: z.string(), type: z.string(), version: z.number().int(), createdAt: z.iso.datetime()
})) });
export const treasuryViewSchema = z.strictObject({
  network: z.literal("Arc Testnet"), configuredMode: z.enum(["disabled", "fixture", "arc_testnet"]),
  dispatchEnabled: z.literal(false), screening: z.literal("local_registry"),
  walletAddress: z.string().nullable(), paused: z.boolean(),
  cashMicroUsdc: microUsdcStringSchema.nullable(), holdsMicroUsdc: microUsdcStringSchema.nullable(),
  minimumReserveMicroUsdc: microUsdcStringSchema.nullable(),
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
