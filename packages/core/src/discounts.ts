import { z } from "zod";
import { microUsdcStringSchema } from "./amounts.js";
import { isoCalendarDateSchema } from "./dates.js";

export const verifiedDiscountSchema = z.strictObject({
  discountedAmountMicroUsdc: microUsdcStringSchema.refine((value) => value !== "0"),
  validThrough: isoCalendarDateSchema, verifiedAt: z.iso.datetime(),
  verificationReference: z.string().trim().min(1).max(500), settlesInFull: z.literal(true)
});
export const cashPreservationCostBpsSchema = z.number().int().min(0).max(10000);
export const discountComparisonSchema = z.strictObject({ nominalAmountMicroUsdc: microUsdcStringSchema,
  payoutAmountMicroUsdc: microUsdcStringSchema, discountAdjustmentMicroUsdc: microUsdcStringSchema,
  cashPreservationCostMicroUsdc: microUsdcStringSchema, daysEarly: z.number().int().positive(),
  expiry: z.iso.datetime(), verificationReference: z.string().min(1).max(500) });
export type DiscountComparison = z.infer<typeof discountComparisonSchema>;
export type DiscountResult = { status: "AVAILABLE"; comparison: DiscountComparison }
  | { status: "NONE" | "INVALID"; reason: string };

/** Stable primitive fields bind an approval and an intent to the verified
 * full-settlement adjustment. Ordinary payments retain their original shape. */
export function paymentAmounts(nominal: string, dueDate: string, terms: unknown, now: string, annualCashPreservationCostBps = 0) {
  const result = compareVerifiedDiscount({ nominalAmountMicroUsdc: nominal, dueDate, terms: terms ?? null, now, annualCashPreservationCostBps });
  if (result.status === "INVALID") throw new Error(result.reason);
  return result.status === "AVAILABLE" ? {
    amountMicroUsdc: result.comparison.payoutAmountMicroUsdc,
    nominalAmountMicroUsdc: nominal, discountAdjustmentMicroUsdc: result.comparison.discountAdjustmentMicroUsdc,
    discountExpiresAt: result.comparison.expiry, discountVerificationReference: result.comparison.verificationReference
  } : { amountMicroUsdc: nominal };
}

/** Only owner-verified terms enter this boundary. The model may select an
 * offered payout but cannot invent a rate, amount, expiry or settlement rule. */
export function compareVerifiedDiscount(raw: unknown): DiscountResult {
  const parsed = z.strictObject({ nominalAmountMicroUsdc: microUsdcStringSchema.refine((value) => value !== "0"),
    dueDate: isoCalendarDateSchema, terms: verifiedDiscountSchema.nullable(), now: z.iso.datetime(),
    annualCashPreservationCostBps: cashPreservationCostBpsSchema.default(0) }).safeParse(raw);
  if (!parsed.success) return { status: "INVALID", reason: "INVALID_DISCOUNT_TERMS" };
  const input = parsed.data;
  if (!input.terms) return { status: "NONE", reason: "NO_VERIFIED_DISCOUNT" };
  const terms = input.terms, now = Date.parse(input.now), due = Date.parse(`${input.dueDate}T09:00:00.000Z`);
  const expiry = `${terms.validThrough}T23:59:59.999Z`;
  const nominal = BigInt(input.nominalAmountMicroUsdc), payout = BigInt(terms.discountedAmountMicroUsdc);
  if (payout >= nominal || terms.validThrough > input.dueDate || Date.parse(terms.verifiedAt) > now)
    return { status: "INVALID", reason: "DISCOUNT_NOT_VERIFIED_FOR_OBLIGATION" };
  if (now > Date.parse(expiry) || now >= due) return { status: "NONE", reason: "DISCOUNT_EXPIRED_OR_NOT_EARLY" };
  const daysEarly = Math.ceil((due - now) / 86_400_000);
  const numerator = payout * BigInt(input.annualCashPreservationCostBps) * BigInt(daysEarly), denominator = 3_650_000n;
  const cost = (numerator + denominator - 1n) / denominator;
  const savings = nominal - payout;
  if (savings <= cost) return { status: "NONE", reason: "DISCOUNT_DOES_NOT_COVER_CASH_COST" };
  return { status: "AVAILABLE", comparison: { nominalAmountMicroUsdc: nominal.toString(), payoutAmountMicroUsdc: payout.toString(),
    discountAdjustmentMicroUsdc: savings.toString(), cashPreservationCostMicroUsdc: cost.toString(), daysEarly,
    expiry, verificationReference: terms.verificationReference } };
}
