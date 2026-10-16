import { z } from "zod";
import { isoCalendarDateSchema as dateOnlySchema } from "./dates.js";
import { verifiedDiscountSchema } from "./discounts.js";
import { formatMicroUsdc, microUsdcStringSchema, usdcToMicroUsdc } from "./amounts.js";

export const ARC_CHAIN_ID = 5_042_002;
export const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
export const arcAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((value) => !/^0x0{40}$/.test(value), "zero address is not a recipient")
  .transform((value) => value.toLowerCase());
export { isoCalendarDateSchema as dateOnlySchema } from "./dates.js";

const nonempty = z.string().trim().min(1).max(500);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const positiveAmount = microUsdcStringSchema.refine((value) => value !== "0", "amount must be positive");

export const fieldEvidenceSchema = z.strictObject({
  id: nonempty,
  field: nonempty,
  status: z.enum(["EXTRACTED", "MISSING", "AMBIGUOUS", "OPERATOR_VERIFIED"]),
  rawText: z.string().trim().min(1).max(4000).nullable(),
  sourceReference: z.string().trim().min(1).max(1000).nullable()
}).refine((value) => value.status !== "EXTRACTED" || value.rawText !== null || value.sourceReference !== null,
  "extracted facts require source evidence")
  .refine((value) => value.status !== "OPERATOR_VERIFIED" || value.sourceReference !== null,
    "operator corrections require an independent evidence reference");

export const payableVendorSchema = z.strictObject({
  businessId: nonempty, id: nonempty, name: nonempty, aliases: z.array(nonempty).max(50),
  status: z.enum(["APPROVED", "BLOCKED"]), address: arcAddressSchema, addressVersion: version,
  chainId: z.literal(ARC_CHAIN_ID), category: nonempty,
  settlementCurrency: z.enum(["USD", "USDC"]), settlementAgreementReference: nonempty,
  verificationReference: nonempty
});

export const purchaseOrderSchema = z.strictObject({
  businessId: nonempty, id: nonempty, vendorId: nonempty, version,
  amountMicroUsdc: positiveAmount, outstandingMicroUsdc: microUsdcStringSchema,
  deliveryAccepted: z.boolean(), acceptanceReference: nonempty.nullable(),
  description: nonempty, dueDate: dateOnlySchema,
  activeObligationId: nonempty.nullable(),
  servicePeriod: nonempty.nullable().optional(), essential: z.boolean().optional(), verifiedDiscount: verifiedDiscountSchema.nullable().optional()
}).refine((value) => !microUsdcStringSchema.safeParse(value.outstandingMicroUsdc).success
  || !microUsdcStringSchema.safeParse(value.amountMicroUsdc).success
  || BigInt(value.outstandingMicroUsdc) <= BigInt(value.amountMicroUsdc),
  "outstanding amount exceeds authorized amount");


const extractedFieldSchema = z.strictObject({
  value: z.string().trim().min(1).max(4000).nullable(),
  status: z.enum(["EXTRACTED", "MISSING", "AMBIGUOUS"]),
  sourceText: z.string().trim().min(1).max(4000).nullable()
}).refine((field) => field.status !== "EXTRACTED" || (field.value !== null && field.sourceText !== null),
  "extracted values require visible source text")
  .refine((field) => field.status !== "MISSING" || field.value === null, "missing fields cannot have invented values");

/** Raw model output retains uncertainty. It is never a verified payable or registry update. */
export const payableExtractionSchema = z.strictObject({
  vendorName: extractedFieldSchema,
  invoiceNumber: extractedFieldSchema,
  issueDate: extractedFieldSchema,
  dueDate: extractedFieldSchema,
  purchaseOrderReference: extractedFieldSchema,
  currency: extractedFieldSchema,
  subtotal: extractedFieldSchema,
  tax: extractedFieldSchema,
  total: extractedFieldSchema,
  printedAddress: extractedFieldSchema,
  serviceDescription: extractedFieldSchema,
  servicePeriod: extractedFieldSchema,
  paymentTerms: extractedFieldSchema,
  lineItems: z.array(z.strictObject({
    description: extractedFieldSchema,
    quantity: extractedFieldSchema,
    unitPrice: extractedFieldSchema,
    amount: extractedFieldSchema
  })).max(200)
});

/** Normalized facts are separate from raw extraction; missing data cannot parse as verified. */
export const normalizedObligationSchema = z.strictObject({
  businessId: nonempty, id: nonempty, version, vendorName: nonempty,
  invoiceNumber: nonempty, purchaseOrderId: nonempty,
  currency: z.enum(["USD", "USDC"]), issueDate: dateOnlySchema, dueDate: dateOnlySchema,
  subtotalMicroUsdc: microUsdcStringSchema, taxMicroUsdc: microUsdcStringSchema,
  amountMicroUsdc: positiveAmount, printedAddress: arcAddressSchema.nullable(),
  serviceDescription: z.string().trim().min(1).max(4000).nullable().optional(),
  servicePeriod: z.string().trim().min(1).max(4000).nullable().optional(),
  paymentTerms: z.string().trim().min(1).max(4000).nullable().optional(),
  lineItems: payableExtractionSchema.shape.lineItems.optional(),
  evidence: z.array(fieldEvidenceSchema).min(1).max(100)
});


export type PayableVendor = z.infer<typeof payableVendorSchema>;
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;
export type NormalizedObligation = z.infer<typeof normalizedObligationSchema>;
export type PayableExtraction = z.infer<typeof payableExtractionSchema>;

export type NormalizationResult =
  | { status: "NORMALIZED"; obligation: NormalizedObligation }
  | { status: "HOLD"; reasons: string[] };

/** Identity/version come from the ingestion service, never from model output. */
export function normalizePayableExtraction(
  raw: unknown, identity: { businessId: string; id: string; version: number }
): NormalizationResult {
  const result = payableExtractionSchema.safeParse(raw);
  if (!result.success) return { status: "HOLD", reasons: ["INVALID_EXTRACTION"] };
  const extraction = result.data;
  const critical = ["vendorName", "invoiceNumber", "purchaseOrderReference", "currency", "issueDate", "dueDate", "subtotal", "tax", "total"] as const;
  const uncertain = critical.filter((key) => extraction[key].status !== "EXTRACTED");
  if (uncertain.length || extraction.printedAddress.status === "AMBIGUOUS") {
    return { status: "HOLD", reasons: ["MISSING_OR_AMBIGUOUS_CRITICAL_FACTS"] };
  }
  const aliases: Record<string, string> = { purchaseOrderReference: "purchaseOrderId", subtotal: "subtotalMicroUsdc", tax: "taxMicroUsdc", total: "amountMicroUsdc" };
  try {
    // The schema already checks that EXTRACTED fields contain non-null visible values.
    const amount = (field: "subtotal" | "tax" | "total") => formatMicroUsdc(usdcToMicroUsdc(extraction[field].value ?? ""));
    const candidate = {
      ...identity,
      vendorName: extraction.vendorName.value,
      invoiceNumber: normalizeInvoiceNumber(extraction.invoiceNumber.value ?? ""),
      purchaseOrderId: extraction.purchaseOrderReference.value,
      currency: extraction.currency.value?.toUpperCase(),
      issueDate: extraction.issueDate.value,
      dueDate: extraction.dueDate.value,
      subtotalMicroUsdc: amount("subtotal"), taxMicroUsdc: amount("tax"), amountMicroUsdc: amount("total"),
      printedAddress: extraction.printedAddress.status === "MISSING" ? null : extraction.printedAddress.value,
      serviceDescription: extraction.serviceDescription.status === "EXTRACTED" ? extraction.serviceDescription.value : null,
      servicePeriod: extraction.servicePeriod.status === "EXTRACTED" ? extraction.servicePeriod.value : null,
      paymentTerms: extraction.paymentTerms.status === "EXTRACTED" ? extraction.paymentTerms.value : null,
      lineItems: extraction.lineItems,
      evidence: [...critical, ...(["serviceDescription", "servicePeriod", "paymentTerms"] as const).filter((key) => extraction[key].status === "EXTRACTED"), ...(extraction.printedAddress.status === "EXTRACTED" ? ["printedAddress" as const] : [])].map((key) => ({
        id: `source:${key}`, field: aliases[key] ?? key, status: extraction[key].status,
        rawText: extraction[key].sourceText, sourceReference: null
      }))
    };
    const normalized = normalizedObligationSchema.safeParse(candidate);
    return normalized.success ? { status: "NORMALIZED", obligation: normalized.data }
      : { status: "HOLD", reasons: ["INVALID_NORMALIZED_FACTS"] };
  } catch {
    return { status: "HOLD", reasons: ["UNSUPPORTED_AMOUNT_OR_IDENTITY"] };
  }
}

export function normalizeInvoiceNumber(value: string): string {
  // Preserve punctuation: INV-1 and INV1 may be distinct business identifiers.
  return nonempty.parse(value).normalize("NFKC").toUpperCase().replace(/\s+/g, " ");
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export type ObligationVerification = { status: "VERIFIED" | "HOLD" | "REJECT"; reasons: string[] };

/** Call only with owner-maintained registry/PO data, never invoice-supplied records. */
export function verifyObligation(
  rawObligation: unknown, rawVendor: unknown, rawPurchaseOrder: unknown
): ObligationVerification {
  const parsed = normalizedObligationSchema.safeParse(rawObligation);
  const vendorResult = payableVendorSchema.safeParse(rawVendor);
  const poResult = purchaseOrderSchema.safeParse(rawPurchaseOrder);
  if (!parsed.success || !vendorResult.success || !poResult.success) {
    return { status: "HOLD", reasons: ["MISSING_OR_INVALID_EVIDENCE"] };
  }
  const invoice = parsed.data, vendor = vendorResult.data, po = poResult.data;
  const reasons: string[] = [];
  if (invoice.businessId !== vendor.businessId || invoice.businessId !== po.businessId) {
    return { status: "HOLD", reasons: ["BUSINESS_MISMATCH"] };
  }
  if (vendor.status === "BLOCKED") return { status: "REJECT", reasons: ["VENDOR_BLOCKED"] };
  if (![vendor.name, ...vendor.aliases].some((name) => normalizedName(name) === normalizedName(invoice.vendorName))) reasons.push("VENDOR_NAME_MISMATCH");
  if (invoice.purchaseOrderId !== po.id || po.vendorId !== vendor.id) reasons.push("PURCHASE_ORDER_MISMATCH");
  if (!po.deliveryAccepted || !po.acceptanceReference) reasons.push("DELIVERY_NOT_ACCEPTED");
  if (po.activeObligationId !== null && po.activeObligationId !== invoice.id) reasons.push("PURCHASE_ORDER_ALREADY_CLAIMED");
  if (po.servicePeriod && (!invoice.servicePeriod || normalizedName(po.servicePeriod) !== normalizedName(invoice.servicePeriod))) reasons.push("SERVICE_PERIOD_MISMATCH");
  if (invoice.currency !== vendor.settlementCurrency) reasons.push("SETTLEMENT_AGREEMENT_MISMATCH");
  if (invoice.printedAddress !== null && invoice.printedAddress !== vendor.address) reasons.push("PRINTED_ADDRESS_MISMATCH");
  if (BigInt(invoice.subtotalMicroUsdc) + BigInt(invoice.taxMicroUsdc) !== BigInt(invoice.amountMicroUsdc)) reasons.push("ARITHMETIC_MISMATCH");
  if (invoice.amountMicroUsdc !== po.outstandingMicroUsdc || po.outstandingMicroUsdc !== po.amountMicroUsdc) reasons.push("FULL_PAYMENT_MISMATCH");
  if (invoice.issueDate > invoice.dueDate || invoice.dueDate !== po.dueDate) reasons.push("DATE_MISMATCH");
  const lines = invoice.lineItems ?? [];
  if (lines.length && lines.every((line) => line.amount.status === "EXTRACTED")) {
    try {
      const sum = lines.reduce((total, line) => total + usdcToMicroUsdc(line.amount.value ?? ""), 0n);
      if (sum !== BigInt(invoice.subtotalMicroUsdc)) reasons.push("LINE_ITEM_SUBTOTAL_MISMATCH");
    } catch { reasons.push("INVALID_LINE_ITEM_AMOUNT"); }
  }
  const evidenceIds = invoice.evidence.map((item) => item.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) reasons.push("DUPLICATE_EVIDENCE_ID");
  const verifiedEvidence = (item: z.infer<typeof fieldEvidenceSchema>) => item.status === "EXTRACTED" || item.status === "OPERATOR_VERIFIED";
  if (invoice.evidence.some((item) => !verifiedEvidence(item))) reasons.push("UNCERTAIN_SOURCE_FACTS");
  for (const field of ["vendorName", "invoiceNumber", "purchaseOrderId", "currency", "issueDate", "dueDate", "subtotalMicroUsdc", "taxMicroUsdc", "amountMicroUsdc"]) {
    if (!invoice.evidence.some((item) => item.field === field && verifiedEvidence(item))) reasons.push(`MISSING_SOURCE_${field}`);
  }
  if (invoice.printedAddress !== null && !invoice.evidence.some((item) => item.field === "printedAddress" && verifiedEvidence(item))) reasons.push("MISSING_SOURCE_printedAddress");
  return { status: reasons.length ? "HOLD" : "VERIFIED", reasons };
}
