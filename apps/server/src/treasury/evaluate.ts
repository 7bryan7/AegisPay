import { compareVerifiedDiscount, paymentAmounts, type DiscountComparison, accountTreasury, treasuryAccountingInputSchema, verifyObligation, type TreasuryAccountingResult } from "@agentpay/core";
import { planPayable, planningContextSchema, type BoundedDecision, type PayablePlanner } from "../agent/planner.js";

const factsSchema = planningContextSchema.omit({ snapshot: true });
const evidenceSchema = treasuryAccountingInputSchema.omit({ candidate: true, policy: true, businessId: true, now: true });
export type AccountedDecision = { discountComparison?: DiscountComparison | null; accounting: TreasuryAccountingResult | null; decision: BoundedDecision };

/** Internal service boundary: facts, complete ledger, fee quote and receipt matches come from
 * trusted server adapters. Derives candidate terms rather than trusting a second caller-supplied copy.
 * Does not persist a decision or authorize dispatch; those operations still require version locks.
 */
export async function planAccountedPayable(rawFacts: unknown, rawEvidence: unknown, planner: PayablePlanner | null,
  clock: () => Date = () => new Date()): Promise<AccountedDecision> {
  const stop = (reasons: string[], action: "HOLD" | "REJECT" = "HOLD"): AccountedDecision => ({ accounting: null,
    decision: { action, reasons, candidate: null, proposal: null, modelId: null, promptVersion: null } });
  const parsedFacts = factsSchema.safeParse(rawFacts), parsedEvidence = evidenceSchema.safeParse(rawEvidence);
  if (!parsedFacts.success) return stop(["INVALID_PLANNING_CONTEXT"]);
  const facts = parsedFacts.data;
  if (facts.duplicateOrSettled) return stop(["DUPLICATE_OR_SETTLED"], "REJECT");
  const verification = verifyObligation(facts.obligation, facts.vendor, facts.purchaseOrder);
  if (verification.status !== "VERIFIED" || !facts.vendor) {
    return stop(verification.reasons, verification.status === "REJECT" ? "REJECT" : "HOLD");
  }
  if (!parsedEvidence.success) return stop(["INVALID_ACCOUNTING_INPUT"]);
  let amounts;
  try { amounts = paymentAmounts(facts.obligation.amountMicroUsdc, facts.obligation.dueDate,
    facts.purchaseOrder?.verifiedDiscount, clock().toISOString(), facts.policy.annualCashPreservationCostBps); }
  catch { return stop(["INVALID_DISCOUNT_TERMS"]); }
  const accounting = accountTreasury({ ...parsedEvidence.data, now: clock().toISOString(),
    businessId: facts.obligation.businessId, policy: facts.policy,
    candidate: { obligationId: facts.obligation.id, purchaseOrderId: facts.obligation.purchaseOrderId,
      category: facts.vendor.category, recipient: facts.vendor.address, amountMicroUsdc: amounts.amountMicroUsdc } });
  if (accounting.status === "HOLD") return { ...stop(accounting.reasons), accounting };
  const discount = compareVerifiedDiscount({ nominalAmountMicroUsdc: facts.obligation.amountMicroUsdc, dueDate: facts.obligation.dueDate,
    terms: facts.purchaseOrder?.verifiedDiscount ?? null, now: clock().toISOString(), annualCashPreservationCostBps: facts.policy.annualCashPreservationCostBps ?? 0 });
  return { accounting, discountComparison: discount.status === "AVAILABLE" ? discount.comparison : null, decision: await planPayable({ ...facts, snapshot: accounting.snapshot }, planner, clock) };
}
