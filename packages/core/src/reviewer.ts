import { z } from "zod";
import { evaluateTreasury, payableActionSchema } from "./treasury.js";
import { microUsdcStringSchema } from "./amounts.js";

export const reviewerExampleIdSchema = z.enum(["due", "future", "low-cash", "approval", "duplicate", "discount"]);
export const reviewerEvaluationRequestSchema = z.strictObject({ exampleId: reviewerExampleIdSchema });
export const reviewerExampleSchema = z.strictObject({ id: reviewerExampleIdSchema, title: z.string(), description: z.string() });
export const reviewerExamplesSchema = z.strictObject({ synthetic: z.literal(true), examples: z.array(reviewerExampleSchema) });
export const reviewerEvaluationSchema = z.strictObject({ synthetic: z.literal(true), example: reviewerExampleSchema,
  evaluatedAt: z.iso.datetime(), nominalAmountMicroUsdc: microUsdcStringSchema, cashMicroUsdc: microUsdcStringSchema,
  dueDate: z.string(), action: payableActionSchema, reasons: z.array(z.string()),
  candidates: z.array(z.strictObject({ id: z.string(), action: payableActionSchema, amountMicroUsdc: microUsdcStringSchema,
    executeAt: z.iso.datetime().nullable(), evidenceIds: z.array(z.string()) })), disclosure: z.string() });
const examples = reviewerExamplesSchema.parse({ synthetic: true, examples: [
  { id: "due", title: "Due and within policy", description: "Accepted synthetic invoice fits cash and all spending limits." },
  { id: "future", title: "Schedule a future payable", description: "Verified due date is later; scheduling does not guarantee funding." },
  { id: "low-cash", title: "Preserve the cash reserve", description: "The invoice would leave less than the required reserve." },
  { id: "approval", title: "Request exact approval", description: "Amount exceeds the automatic threshold while fitting hard limits." },
  { id: "duplicate", title: "Refuse a duplicate", description: "An existing synthetic invoice identity must never be paid twice." },
  { id: "discount", title: "Use a verified discount", description: "Exact discounted amount and expiry settle the full synthetic obligation." }
] });
export function reviewerExamples() { return structuredClone(examples); }

/** Pure, fixed-clock examples: no storage, model, RPC, wallet or provider access.
 * The request selects a predefined scenario and cannot supply financial terms. */
export function evaluateReviewerExample(raw: unknown) {
  const id = reviewerExampleIdSchema.parse(raw), now = "2026-10-15T12:00:00.000Z";
  const amount = id === "approval" ? "2000000" : "1000000";
  const dueDate = ["future", "discount"].includes(id) ? "2026-11-15" : "2026-10-15";
  const cash = id === "low-cash" ? "1200000" : "10000000";
  const result = evaluateTreasury({ now, dueDate, amountMicroUsdc: amount, verification: "VERIFIED",
    duplicateOrSettled: id === "duplicate", screening: "LOCAL_REGISTRY", exactApprovalValid: false,
    verifiedDiscount: id === "discount" ? { discountedAmountMicroUsdc: "900000", validThrough: "2026-10-20",
      verifiedAt: "2026-10-14T00:00:00.000Z", verificationReference: "synthetic:full-settlement", settlesInFull: true } : null,
    policy: { autoPayMaxMicroUsdc: "1500000", hardTxMaxMicroUsdc: "5000000", dailyBudgetMicroUsdc: "10000000",
      categoryBudgetMicroUsdc: "10000000", minReserveMicroUsdc: "500000", annualCashPreservationCostBps: 0 },
    snapshot: { capturedAt: now, cashMicroUsdc: cash, unreflectedHoldsMicroUsdc: "0", protectedObligationsMicroUsdc: "0",
      feeAllowanceMicroUsdc: "100", dailySettledMicroUsdc: "0", dailyHoldsMicroUsdc: "0", categorySettledMicroUsdc: "0",
      categoryHoldsMicroUsdc: "0", inclusionEvidenceVerified: true, hasInFlightTransfer: false, paused: false } });
  return reviewerEvaluationSchema.parse({ synthetic: true, example: examples.examples.find((item) => item.id === id),
    evaluatedAt: now, nominalAmountMicroUsdc: amount, cashMicroUsdc: cash, dueDate, ...result,
    disclosure: "Synthetic policy simulation at a fixed clock. No model call or real extraction, transfer or settlement. Local registry checks are not sanctions clearance. Cash-preservation cost defaults to zero." });
}
