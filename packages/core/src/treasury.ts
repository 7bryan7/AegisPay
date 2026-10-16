import { z } from "zod";
import { microUsdcStringSchema } from "./amounts.js";
import { compareVerifiedDiscount, verifiedDiscountSchema, cashPreservationCostBpsSchema } from "./discounts.js";
import { dateOnlySchema } from "./obligations.js";

export const payableActionSchema = z.enum(["PAY_NOW", "SCHEDULE", "HOLD", "REQUIRE_APPROVAL", "REJECT"]);
export const treasuryPolicySchema = z.strictObject({
  autoPayMaxMicroUsdc: microUsdcStringSchema,
  hardTxMaxMicroUsdc: microUsdcStringSchema,
  dailyBudgetMicroUsdc: microUsdcStringSchema,
  categoryBudgetMicroUsdc: microUsdcStringSchema,
  minReserveMicroUsdc: microUsdcStringSchema,
  annualCashPreservationCostBps: cashPreservationCostBpsSchema.optional()
}).refine((policy) => !microUsdcStringSchema.safeParse(policy.autoPayMaxMicroUsdc).success
  || !microUsdcStringSchema.safeParse(policy.hardTxMaxMicroUsdc).success
  || BigInt(policy.autoPayMaxMicroUsdc) <= BigInt(policy.hardTxMaxMicroUsdc),
  "automatic threshold exceeds hard ceiling");

export const treasurySnapshotSchema = z.strictObject({
  capturedAt: z.iso.datetime(),
  cashMicroUsdc: microUsdcStringSchema,
  unreflectedHoldsMicroUsdc: microUsdcStringSchema,
  protectedObligationsMicroUsdc: microUsdcStringSchema,
  feeAllowanceMicroUsdc: microUsdcStringSchema,
  dailySettledMicroUsdc: microUsdcStringSchema,
  dailyHoldsMicroUsdc: microUsdcStringSchema,
  categorySettledMicroUsdc: microUsdcStringSchema,
  categoryHoldsMicroUsdc: microUsdcStringSchema,
  inclusionEvidenceVerified: z.boolean(),
  hasInFlightTransfer: z.boolean(),
  paused: z.boolean()
});

const eligibilityInputSchema = z.strictObject({
  now: z.iso.datetime(), dueDate: dateOnlySchema,
  verifiedDiscount: verifiedDiscountSchema.nullable().optional(),
  amountMicroUsdc: microUsdcStringSchema.refine((value) => value !== "0"),
  verification: z.enum(["VERIFIED", "HOLD", "REJECT"]),
  duplicateOrSettled: z.boolean(),
  screening: z.enum(["LOCAL_REGISTRY", "CLEAR", "DENIED", "UNAVAILABLE", "STALE"]),
  // The service must validate exact terms, versions and expiry before setting this.
  exactApprovalValid: z.boolean(),
  policy: treasuryPolicySchema, snapshot: treasurySnapshotSchema
});

export type PayableCandidate = {
  id: string;
  action: z.infer<typeof payableActionSchema>;
  amountMicroUsdc: string;
  executeAt: string | null;
  evidenceIds: string[];
};
export type TreasuryEligibility = {
  action: z.infer<typeof payableActionSchema>;
  reasons: string[];
  candidates: PayableCandidate[];
};

/** Eligibility is not a payment authorization. Reservation must recheck under a treasury lock.
 * Snapshot aggregates exclude the candidate and never count a held obligation twice.
 * Active budget holds include prior periods; reflected cash holds require inclusion evidence.
 */
export function evaluateTreasury(rawInput: unknown): TreasuryEligibility {
  const parsed = eligibilityInputSchema.safeParse(rawInput);
  const stop = (action: "HOLD" | "REJECT" | "REQUIRE_APPROVAL", reason: string): TreasuryEligibility =>
    ({ action, reasons: [reason], candidates: [] });
  if (!parsed.success) return stop("HOLD", "INVALID_POLICY_OR_SNAPSHOT");
  const input = parsed.data;
  const { snapshot, policy } = input;
  if (input.duplicateOrSettled) return stop("REJECT", "DUPLICATE_OR_SETTLED");
  if (input.verification === "REJECT" || input.screening === "DENIED") return stop("REJECT", "VERIFICATION_REJECTED");
  if (input.verification !== "VERIFIED") return stop("HOLD", "OBLIGATION_NOT_VERIFIED");
  if (["UNAVAILABLE", "STALE"].includes(input.screening)) return stop("HOLD", "SCREENING_UNAVAILABLE");
  if (snapshot.paused) return stop("HOLD", "AUTONOMY_PAUSED");
  if (snapshot.hasInFlightTransfer) return stop("HOLD", "UNRESOLVED_TRANSFER");
  const age = Date.parse(input.now) - Date.parse(snapshot.capturedAt);
  if (age < 0 || age > 30_000 || !snapshot.inclusionEvidenceVerified) return stop("HOLD", "STALE_OR_UNVERIFIED_CASH");
  const discount = compareVerifiedDiscount({ nominalAmountMicroUsdc: input.amountMicroUsdc, dueDate: input.dueDate,
    terms: input.verifiedDiscount ?? null, now: input.now, annualCashPreservationCostBps: policy.annualCashPreservationCostBps ?? 0 });
  if (discount.status === "INVALID") return stop("HOLD", discount.reason);
  const payout = discount.status === "AVAILABLE" ? discount.comparison.payoutAmountMicroUsdc : input.amountMicroUsdc;
  const amount = BigInt(payout);
  if (amount > BigInt(policy.hardTxMaxMicroUsdc)) return stop("HOLD", "HARD_CEILING");
  const spendable = BigInt(snapshot.cashMicroUsdc) - BigInt(snapshot.unreflectedHoldsMicroUsdc)
    - BigInt(policy.minReserveMicroUsdc) - BigInt(snapshot.protectedObligationsMicroUsdc)
    - BigInt(snapshot.feeAllowanceMicroUsdc);
  if (amount > spendable) return stop("HOLD", "CASH_RESERVE");
  if (amount + BigInt(snapshot.dailySettledMicroUsdc) + BigInt(snapshot.dailyHoldsMicroUsdc) > BigInt(policy.dailyBudgetMicroUsdc)) return stop("HOLD", "DAILY_BUDGET");
  if (amount + BigInt(snapshot.categorySettledMicroUsdc) + BigInt(snapshot.categoryHoldsMicroUsdc) > BigInt(policy.categoryBudgetMicroUsdc)) return stop("HOLD", "CATEGORY_BUDGET");
  if (amount > BigInt(policy.autoPayMaxMicroUsdc) && !input.exactApprovalValid) return stop("REQUIRE_APPROVAL", "SOFT_THRESHOLD");
  const executeAt = `${input.dueDate}T09:00:00.000Z`;
  const action = discount.status === "AVAILABLE" || Date.parse(executeAt) <= Date.parse(input.now) ? "PAY_NOW" : "SCHEDULE";
  return {
    action, reasons: [discount.status === "AVAILABLE" ? "VERIFIED_DISCOUNT_SAVES_CASH" : action === "PAY_NOW" ? "DUE_AND_ELIGIBLE" : "VERIFIED_DUE_DATE"],
    candidates: [
      { id: discount.status === "AVAILABLE" ? "verified-discount" : "due-date", action, amountMicroUsdc: payout,
        executeAt: action === "SCHEDULE" ? executeAt : null, evidenceIds: ["verified-obligation", "treasury-snapshot", "policy", ...(discount.status === "AVAILABLE" ? ["verified-discount"] : [])] },
      { id: "preserve-cash", action: "HOLD", amountMicroUsdc: payout,
        executeAt: null, evidenceIds: ["treasury-snapshot"] }
    ]
  };
}

export const plannerProposalSchema = z.strictObject({
  candidateId: z.string().min(1).max(100),
  reason: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(z.string().min(1).max(100)).min(1).max(30),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(10),
  alternativeConsidered: z.string().trim().min(1).max(1000)
});

/** This checks evidence membership, not whether prose is true; store/review the cited facts. */
export function validatePlannerProposal(raw: unknown, candidates: readonly PayableCandidate[]): PayableCandidate | null {
  const parsed = plannerProposalSchema.safeParse(raw);
  if (!parsed.success || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) return null;
  const proposal = parsed.data;
  const candidate = candidates.find((item) => item.id === proposal.candidateId);
  if (!candidate || proposal.assumptions.length > 0 || new Set(proposal.evidenceIds).size !== proposal.evidenceIds.length) return null;
  if (proposal.evidenceIds.some((id) => !candidate.evidenceIds.includes(id))) return null;
  if (candidate.evidenceIds.some((id) => !proposal.evidenceIds.includes(id))) return null;
  return candidate;
}
