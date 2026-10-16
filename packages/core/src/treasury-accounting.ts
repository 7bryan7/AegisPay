import { z } from "zod";
import { formatMicroUsdc, microUsdcStringSchema } from "./amounts.js";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, arcAddressSchema, dateOnlySchema } from "./obligations.js";
import { treasuryPolicySchema, treasurySnapshotSchema } from "./treasury.js";

const id = z.string().trim().min(1).max(500);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const unsigned = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine((value) => BigInt(value) < 2n ** 256n);
const positive = microUsdcStringSchema.refine((value) => value !== "0");
const identity = { chainId: z.literal(ARC_CHAIN_ID), tokenAddress: z.literal(ARC_USDC_ADDRESS), walletAddress: arcAddressSchema };

export const cashEvidenceSchema = z.strictObject({
  ...identity, cashMicroUsdc: microUsdcStringSchema, blockNumber: unsigned, blockHash: hash,
  blockTimestamp: z.iso.datetime(), capturedAt: z.iso.datetime(), observedAt: z.iso.datetime()
});
export const feeEvidenceSchema = z.strictObject({
  ...identity, recipient: arcAddressSchema, amountMicroUsdc: positive,
  cashBlockHash: hash, capturedAt: z.iso.datetime(), evidenceReference: id,
  gasLimit: unsigned.refine((value) => value !== "0"), maxFeePerGasNative: unsigned.refine((value) => value !== "0"),
  bufferBps: z.number().int().min(0).max(10000), extraBufferMicroUsdc: microUsdcStringSchema
});
// These records are supplied by a trusted receipt verifier, never a browser or model.
// The accounting layer checks bindings; it does not itself prove canonical ancestry or receipt authenticity.
const receiptSchema = z.strictObject({
  ...identity, transactionHash: hash, blockNumber: unsigned, blockHash: hash, cashBlockHash: hash,
  recipient: arcAddressSchema, amountMicroUsdc: microUsdcStringSchema, actualFeeMicroUsdc: microUsdcStringSchema,
  actualFeeNative: unsigned.optional(),
  outcome: z.enum(["SUCCESS", "REVERTED"]), verificationReference: id
});
export const submissionRejectionEvidenceSchema = z.strictObject({
  httpStatus:z.literal(400),providerCode:z.literal(2),providerRequestId:z.string().regex(/^[a-f0-9]{32}$/),
  requestedAt:z.iso.datetime(),reason:z.literal("TOKEN_ID_AND_BLOCKCHAIN_MISSING"),evidenceReference:id
});
export const paymentLedgerSchema = z.strictObject({
  businessId: id, intentId: id, obligationId: id, purchaseOrderId: id, category: id,
  recipient: arcAddressSchema, amountMicroUsdc: positive, nominalAmountMicroUsdc: positive.optional(), feeAllowanceMicroUsdc: microUsdcStringSchema,
  state: z.enum(["RESERVED", "SUBMITTING", "PENDING", "UNKNOWN", "SETTLED", "FAILED", "CANCELLED"]),
  reservationState: z.enum(["HELD", "CONSUMED", "RELEASED"]),
  reservedAt: z.iso.datetime(), settledAt: z.iso.datetime().nullable(),
  transactionHash: hash.nullable(), providerId: id.nullable(), providerState: id.nullable(),
  terminalEvidenceReference: id.nullable(),
  submissionRejection:submissionRejectionEvidenceSchema.nullable().optional(),
  receipt: receiptSchema.nullable()
});
const commitmentSchema = z.strictObject({
  businessId: id, purchaseOrderId: id, obligationId: id.nullable(),
  outstandingMicroUsdc: microUsdcStringSchema, dueDate: dateOnlySchema,
  accepted: z.boolean(), essential: z.boolean(), status: z.enum(["OPEN", "SETTLED", "REJECTED"])
});
export const treasuryAccountingInputSchema = z.strictObject({
  businessId: id, now: z.iso.datetime(), paused: z.boolean(), policy: treasuryPolicySchema,
  candidate: z.strictObject({ obligationId: id, purchaseOrderId: id, category: id, recipient: arcAddressSchema, amountMicroUsdc: positive }),
  cash: cashEvidenceSchema, fee: feeEvidenceSchema.nullable(),
  // Caller must read a complete, consistent business-scoped ledger including ALL active holds,
  // not a paginated UI list. coverageFrom covers settlements from at least this UTC month start.
  ledgerAsOf: z.iso.datetime(), coverageFrom: z.iso.datetime(),
  payments: z.array(paymentLedgerSchema).max(100000), commitments: z.array(commitmentSchema).max(100000)
});
export type TreasuryAccountingInput = z.infer<typeof treasuryAccountingInputSchema>;
export type PaymentLedgerEntry = z.infer<typeof paymentLedgerSchema>;
export type TreasuryAccountingResult =
  | { status: "HOLD"; reasons: string[]; snapshot: null }
  | { status: "READY"; snapshot: z.infer<typeof treasurySnapshotSchema>;
      availableMicroUsdc: string; dailyHeadroomMicroUsdc: string; categoryHeadroomMicroUsdc: string;
      totalHeldMicroUsdc: string; reflectedHeldMicroUsdc: string; evidenceReferences: string[] };

/** Ceiling is applied after multiplication and basis-point buffer, avoiding fractional micro-USDC loss. */
export function feeAllowanceFromEvidence(raw: unknown): string {
  const fee = feeEvidenceSchema.parse(raw);
  const numerator = BigInt(fee.gasLimit) * BigInt(fee.maxFeePerGasNative) * BigInt(10000 + fee.bufferBps);
  const denominator = 10000n * 1_000_000_000_000n;
  return formatMicroUsdc((numerator + denominator - 1n) / denominator + BigInt(fee.extraBufferMicroUsdc));
}

/** Pre-reservation accounting over trusted evidence. READY means arithmetic is usable, not permission to pay.
 * No state is changed; reservations, receipt verification and dispatch locks are separate services.
 */
export function accountTreasury(raw: unknown): TreasuryAccountingResult { return calculateTreasury(raw, false); }

/** Treasury-wide view: no candidate is excluded and no future payment fee is
 * invented. Existing fee holds remain included. Not a dispatch authorization. */
export function accountTreasuryOverview(raw: unknown): TreasuryAccountingResult { return calculateTreasury(raw, true); }
const overviewInputSchema = treasuryAccountingInputSchema.omit({ candidate: true, fee: true })
  .extend({ category: id });
function calculateTreasury(raw: unknown, overview: boolean): TreasuryAccountingResult {
  const hold = (reason: string): TreasuryAccountingResult => ({ status: "HOLD", reasons: [reason], snapshot: null });
  const parsed = overview ? overviewInputSchema.transform((value) => ({ ...value, candidate: null, fee: null })).safeParse(raw)
    : treasuryAccountingInputSchema.transform((value) => ({ ...value, category: value.candidate.category })).safeParse(raw);
  if (!parsed.success) return hold("INVALID_ACCOUNTING_INPUT");
  const input = parsed.data, { cash, fee, candidate, policy } = input;
  const now = Date.parse(input.now), month = input.now.slice(0, 7), day = input.now.slice(0, 10);
  const fresh = (value: string) => now - Date.parse(value) >= 0 && now - Date.parse(value) <= 30_000;
  if (!fresh(cash.capturedAt) || cash.capturedAt !== cash.blockTimestamp || !fresh(cash.observedAt)
    || Date.parse(cash.observedAt) < Date.parse(cash.capturedAt)) return hold("STALE_CASH_EVIDENCE");
  if (!fresh(input.ledgerAsOf) || Date.parse(input.ledgerAsOf) < Date.parse(cash.observedAt)
    || Date.parse(input.coverageFrom) > Date.parse(`${month}-01T00:00:00.000Z`)) return hold("INCOMPLETE_OR_STALE_LEDGER");
  if (!overview && (!fee || !fresh(fee.capturedAt) || Date.parse(fee.capturedAt) < Date.parse(cash.capturedAt))) return hold("FEE_EVIDENCE_UNAVAILABLE");
  if (fee && (fee.walletAddress !== cash.walletAddress || fee.cashBlockHash !== cash.blockHash
    || fee.recipient !== candidate?.recipient || fee.amountMicroUsdc !== candidate?.amountMicroUsdc)) return hold("FEE_TERMS_MISMATCH");
  const activeStates = new Set(["RESERVED", "SUBMITTING", "PENDING", "UNKNOWN"]);
  const active = input.payments.filter((payment) => activeStates.has(payment.state));
  if (active.length > 1) return hold("MULTIPLE_INFLIGHT_TRANSFERS");
  if (new Set(input.payments.map((p) => p.intentId)).size !== input.payments.length
    || new Set(input.commitments.map((p) => p.purchaseOrderId)).size !== input.commitments.length) return hold("DUPLICATE_LEDGER_RECORD");
  const hashes = input.payments.flatMap((p) => p.transactionHash ? [p.transactionHash] : []);
  const providers = input.payments.flatMap((p) => p.providerId ? [p.providerId] : []);
  const claimed = input.payments.filter((p) => activeStates.has(p.state) || p.state === "SETTLED").map((p) => p.obligationId);
  const claimedPos = input.payments.filter((p) => activeStates.has(p.state) || p.state === "SETTLED").map((p) => p.purchaseOrderId);
  const linked = input.commitments.flatMap((c) => c.obligationId ? [c.obligationId] : []);
  if (new Set(hashes).size !== hashes.length || new Set(providers).size !== providers.length
    || new Set(claimed).size !== claimed.length || new Set(claimedPos).size !== claimedPos.length
    || new Set(linked).size !== linked.length) return hold("DUPLICATE_LEDGER_IDENTITY");
  if (candidate && (claimed.includes(candidate.obligationId) || claimedPos.includes(candidate.purchaseOrderId))) return hold("CANDIDATE_ALREADY_RESERVED_OR_SETTLED");
  if (input.payments.some((p) => p.businessId !== input.businessId)
    || input.commitments.some((c) => c.businessId !== input.businessId)) return hold("ACCOUNTING_BUSINESS_MISMATCH");
  let totalHeld = 0n, reflectedHeld = 0n, dailyHolds = 0n, categoryHolds = 0n, dailySettled = 0n, categorySettled = 0n;
  const evidenceReferences = new Set<string>(fee ? [fee.evidenceReference] : []);
  try {
    for (const payment of input.payments) {
      const held = activeStates.has(payment.state);
      if (Date.parse(payment.reservedAt) > Date.parse(input.ledgerAsOf)
        || (held && payment.reservationState !== "HELD")
        || (payment.state === "SETTLED" && payment.reservationState !== "CONSUMED")
        || (["FAILED", "CANCELLED"].includes(payment.state) && payment.reservationState !== "RELEASED")
        || ((payment.state === "SETTLED") !== (payment.settledAt !== null))) return hold("INCONSISTENT_PAYMENT_LEDGER");
      const receipt = payment.receipt;
      if(payment.submissionRejection && (payment.state!=="FAILED"||payment.providerId||payment.providerState
        ||payment.transactionHash||receipt))return hold("INCONSISTENT_SUBMISSION_REJECTION");
      if (receipt) {
        if (receipt.actualFeeNative !== undefined
          && (BigInt(receipt.actualFeeNative) + 999_999_999_999n) / 1_000_000_000_000n !== BigInt(receipt.actualFeeMicroUsdc)) {
          return hold("RECEIPT_FEE_MISMATCH");
        }
        if (receipt.cashBlockHash !== cash.blockHash || receipt.walletAddress !== cash.walletAddress
          || receipt.recipient !== payment.recipient || receipt.transactionHash !== payment.transactionHash
          || (receipt.outcome === "SUCCESS" ? receipt.amountMicroUsdc !== payment.amountMicroUsdc : receipt.amountMicroUsdc !== "0")) {
          return hold("RECEIPT_TERMS_MISMATCH");
        }
        if (BigInt(receipt.blockNumber) > BigInt(cash.blockNumber)) return hold("CASH_PREDATES_RECEIPT");
        if (receipt.blockNumber === cash.blockNumber && receipt.blockHash !== cash.blockHash) return hold("RECEIPT_BLOCK_MISMATCH");
        evidenceReferences.add(receipt.verificationReference);
      }
      if (payment.state === "RESERVED" || payment.state === "CANCELLED") {
        if (receipt || payment.transactionHash || payment.providerId || payment.providerState) return hold("UNSUBMITTED_PAYMENT_HAS_CHAIN_IDENTITY");
      } else if (payment.state === "FAILED") {
        if(payment.submissionRejection){
          // Human-reviewed provider validation rejection, bound by persistence to
          // this intent and its audit event. No transaction or network fee exists.
          evidenceReferences.add(payment.submissionRejection.evidenceReference);
        } else {
        if (!payment.terminalEvidenceReference || payment.providerState !== "FAILED" || (receipt && receipt.outcome !== "REVERTED")
          || (!receipt && payment.transactionHash)) return hold("UNVERIFIED_FAILURE_FEE");
        evidenceReferences.add(payment.terminalEvidenceReference);
        }
      } else if (!receipt) return hold("CASH_INCLUSION_UNRESOLVED");
      if (payment.state === "SETTLED") {
        if (!receipt || receipt.outcome !== "SUCCESS" || payment.providerState !== "COMPLETE" || !payment.providerId
          || !payment.settledAt || Date.parse(payment.settledAt) > Date.parse(input.ledgerAsOf)
          || Date.parse(payment.settledAt) < Date.parse(payment.reservedAt)) return hold("UNVERIFIED_SETTLEMENT");
        const amount = BigInt(payment.amountMicroUsdc);
        if (payment.settledAt.slice(0, 10) === day) dailySettled += amount;
        if (payment.category === input.category && payment.settledAt.slice(0, 7) === month) categorySettled += amount;
      }
      if (held) {
        const amount = BigInt(payment.amountMicroUsdc), holdAmount = amount + BigInt(payment.feeAllowanceMicroUsdc);
        totalHeld += holdAmount;
        dailyHolds += amount; // All periods; rollover never frees an unresolved commitment.
        if (payment.category === input.category) categoryHolds += amount;
        if (receipt) {
          // Report fees rounded up, but never overstate the debit already reflected in six-decimal cash.
          const reflectedFee = receipt.actualFeeNative === undefined ? BigInt(receipt.actualFeeMicroUsdc)
            : BigInt(receipt.actualFeeNative) / 1_000_000_000_000n;
          const debit = BigInt(receipt.amountMicroUsdc) + reflectedFee;
          reflectedHeld += debit < holdAmount ? debit : holdAmount;
        }
      }
    }
    const covered = new Set(claimed);
    const coveredPos = new Set(claimedPos);
    const coveredByPo = new Map(input.payments.filter((p) => activeStates.has(p.state) || p.state === "SETTLED").map((p) => [p.purchaseOrderId, p]));
    const coveredByObligation = new Map(input.payments.filter((p) => activeStates.has(p.state) || p.state === "SETTLED").map((p) => [p.obligationId, p]));
    const horizon = new Date(now + 7 * 86400000).toISOString().slice(0, 10);
    let protectedAmount = 0n;
    for (const commitment of input.commitments) {
      if (commitment.purchaseOrderId === candidate?.purchaseOrderId && commitment.obligationId !== null
        && commitment.obligationId !== candidate?.obligationId) return hold("CANDIDATE_PO_ALREADY_CLAIMED");
      if (commitment.obligationId === candidate?.obligationId && commitment.purchaseOrderId !== candidate?.purchaseOrderId) return hold("COMMITMENT_IDENTITY_MISMATCH");
      const associated = coveredByPo.get(commitment.purchaseOrderId)
        ?? (commitment.obligationId ? coveredByObligation.get(commitment.obligationId) : undefined);
      if (associated && (associated.purchaseOrderId !== commitment.purchaseOrderId
        || (commitment.obligationId !== null && associated.obligationId !== commitment.obligationId)
        || (activeStates.has(associated.state) && (associated.nominalAmountMicroUsdc ?? associated.amountMicroUsdc) !== commitment.outstandingMicroUsdc))) return hold("COMMITMENT_TERMS_MISMATCH");
      if (commitment.purchaseOrderId === candidate?.purchaseOrderId || commitment.obligationId === candidate?.obligationId) continue;
      if (coveredPos.has(commitment.purchaseOrderId) || (commitment.obligationId && covered.has(commitment.obligationId))) continue;
      // Includes overdue obligations; a different category does not remove a cash commitment.
      if (commitment.status === "OPEN" && commitment.accepted && commitment.essential && commitment.dueDate <= horizon) {
        protectedAmount += BigInt(commitment.outstandingMicroUsdc);
      }
    }
    const feeAmount = fee ? feeAllowanceFromEvidence(fee) : "0", unreflected = totalHeld - reflectedHeld;
    const capturedAt = [cash.capturedAt, ...(fee ? [fee.capturedAt] : []), input.ledgerAsOf].sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
    const snapshot = treasurySnapshotSchema.parse({ capturedAt, cashMicroUsdc: cash.cashMicroUsdc,
      unreflectedHoldsMicroUsdc: formatMicroUsdc(unreflected), protectedObligationsMicroUsdc: formatMicroUsdc(protectedAmount),
      feeAllowanceMicroUsdc: feeAmount, dailySettledMicroUsdc: formatMicroUsdc(dailySettled), dailyHoldsMicroUsdc: formatMicroUsdc(dailyHolds),
      categorySettledMicroUsdc: formatMicroUsdc(categorySettled), categoryHoldsMicroUsdc: formatMicroUsdc(categoryHolds),
      inclusionEvidenceVerified: true, hasInFlightTransfer: active.length > 0, paused: input.paused });
    const nonnegative = (value: bigint) => formatMicroUsdc(value < 0n ? 0n : value);
    return { status: "READY", snapshot,
      availableMicroUsdc: nonnegative(BigInt(cash.cashMicroUsdc) - unreflected - protectedAmount - BigInt(feeAmount) - BigInt(policy.minReserveMicroUsdc)),
      dailyHeadroomMicroUsdc: nonnegative(BigInt(policy.dailyBudgetMicroUsdc) - dailySettled - dailyHolds),
      categoryHeadroomMicroUsdc: nonnegative(BigInt(policy.categoryBudgetMicroUsdc) - categorySettled - categoryHolds),
      totalHeldMicroUsdc: formatMicroUsdc(totalHeld), reflectedHeldMicroUsdc: formatMicroUsdc(reflectedHeld), evidenceReferences: [...evidenceReferences] };
  } catch { return hold("ACCOUNTING_RANGE_OR_EVIDENCE_ERROR"); }
}
