import { z } from "zod";
import { microUsdcStringSchema } from "./amounts.js";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, arcAddressSchema } from "./obligations.js";

const id = z.string().trim().min(1).max(500);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const approvalTermsSchema = z.strictObject({
  businessId: id, obligationId: id, decisionId: id, walletId: id,
  obligationVersion: version, vendorId: id, vendorAddressVersion: version,
  purchaseOrderId: id, purchaseOrderVersion: version, policyVersion: version,
  recipient: arcAddressSchema,
  amountMicroUsdc: microUsdcStringSchema.refine((value) => value !== "0"),
  nominalAmountMicroUsdc: microUsdcStringSchema.optional(), discountAdjustmentMicroUsdc: microUsdcStringSchema.optional(),
  discountExpiresAt: z.iso.datetime().optional(), discountVerificationReference: id.optional(),
  chainId: z.literal(ARC_CHAIN_ID), token: z.literal(ARC_USDC_ADDRESS)
}).refine((terms) => {
  const fields = [terms.nominalAmountMicroUsdc, terms.discountAdjustmentMicroUsdc, terms.discountExpiresAt, terms.discountVerificationReference];
  if (fields.every((value) => value === undefined)) return true;
  if (![terms.amountMicroUsdc, terms.discountAdjustmentMicroUsdc, terms.nominalAmountMicroUsdc].every((value) => microUsdcStringSchema.safeParse(value).success)) return false;
  return fields.every((value) => value !== undefined) && BigInt(terms.discountAdjustmentMicroUsdc!) > 0n
    && BigInt(terms.amountMicroUsdc) + BigInt(terms.discountAdjustmentMicroUsdc!) === BigInt(terms.nominalAmountMicroUsdc!);
}, "Discount requires complete exact full-settlement terms");

export const payableApprovalSchema = z.strictObject({
  id, terms: approvalTermsSchema, actorId: id, role: z.literal("OPERATOR"),
  granted: z.boolean(), reason: z.string().trim().min(1).max(2000),
  grantedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), consumedAt: z.iso.datetime().nullable()
});

/** The server loads the grant from trusted persistence; this does not authenticate a browser payload. */
export function isExactApprovalValid(rawApproval: unknown, rawCurrentTerms: unknown, now: string): boolean {
  const approvalResult = payableApprovalSchema.safeParse(rawApproval);
  const termsResult = approvalTermsSchema.safeParse(rawCurrentTerms);
  const nowResult = z.iso.datetime().safeParse(now);
  if (!approvalResult.success || !termsResult.success || !nowResult.success) return false;
  const approval = approvalResult.data;
  const granted = Date.parse(approval.grantedAt), expires = Date.parse(approval.expiresAt), current = Date.parse(now);
  if (!approval.granted || approval.consumedAt !== null || granted > current || expires <= current
    || expires <= granted || expires - granted > 24 * 60 * 60 * 1000) return false;
  const keys = Object.keys(approvalTermsSchema.shape) as (keyof z.infer<typeof approvalTermsSchema>)[];
  return keys.every((key) => approval.terms[key] === termsResult.data[key]);
}
