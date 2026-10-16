import { describe, expect, it } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "./obligations.js";
import { accountTreasuryOverview, accountTreasury, feeAllowanceFromEvidence, type PaymentLedgerEntry, type TreasuryAccountingInput } from "./treasury-accounting.js";
import { evaluateTreasury } from "./treasury.js";

const wallet = `0x${"1".repeat(40)}`, recipient = `0x${"2".repeat(40)}`;
const blockHash = `0x${"a".repeat(64)}`, transactionHash = `0x${"b".repeat(64)}`;
function input(): TreasuryAccountingInput {
  return { businessId: "business", now: "2026-11-01T00:00:10.000Z", paused: false,
    policy: { autoPayMaxMicroUsdc: "2000000", hardTxMaxMicroUsdc: "5000000", dailyBudgetMicroUsdc: "10000000",
      categoryBudgetMicroUsdc: "8000000", minReserveMicroUsdc: "5000000" },
    candidate: { obligationId: "candidate", purchaseOrderId: "candidate-po", category: "office", recipient, amountMicroUsdc: "1500000" },
    cash: { chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS, walletAddress: wallet, cashMicroUsdc: "20000000",
      blockNumber: "100", blockHash, blockTimestamp: "2026-11-01T00:00:08.000Z", capturedAt: "2026-11-01T00:00:08.000Z", observedAt: "2026-11-01T00:00:09.000Z" },
    fee: { chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS, walletAddress: wallet, recipient, amountMicroUsdc: "1500000",
      cashBlockHash: blockHash, capturedAt: "2026-11-01T00:00:09.000Z", evidenceReference: "test-fee",
      gasLimit: "21000", maxFeePerGasNative: "1000000000", bufferBps: 0, extraBufferMicroUsdc: "79" },
    ledgerAsOf: "2026-11-01T00:00:10.000Z", coverageFrom: "2026-11-01T00:00:00.000Z", payments: [], commitments: [] };
}
function reserved(): PaymentLedgerEntry {
  return { businessId: "business", intentId: "intent-1", obligationId: "other", purchaseOrderId: "other-po", category: "office",
    recipient, amountMicroUsdc: "2000000", feeAllowanceMicroUsdc: "10000", state: "RESERVED", reservationState: "HELD",
    reservedAt: "2026-10-01T12:00:00.000Z", settledAt: null, transactionHash: null, providerId: null, providerState: null,
    terminalEvidenceReference: null, receipt: null };
}
function receipt(): NonNullable<PaymentLedgerEntry["receipt"]> {
  return { chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS, walletAddress: wallet,
    transactionHash, blockNumber: "99", blockHash: `0x${"c".repeat(64)}`, cashBlockHash: blockHash,
    recipient, amountMicroUsdc: "2000000", actualFeeMicroUsdc: "3000", outcome: "SUCCESS", verificationReference: "verified-receipt" };
}
function settled(): PaymentLedgerEntry {
  return { ...reserved(), state: "SETTLED", reservationState: "CONSUMED", settledAt: "2026-11-01T00:00:05.000Z",
    transactionHash, providerId: "provider-1", providerState: "COMPLETE", receipt: receipt() };
}
function commitment(overrides: Partial<TreasuryAccountingInput["commitments"][number]> = {}): TreasuryAccountingInput["commitments"][number] {
  return { businessId: "business", purchaseOrderId: "upcoming-po", obligationId: "upcoming", outstandingMicroUsdc: "3000000",
    dueDate: "2026-11-08", accepted: true, essential: true, status: "OPEN", ...overrides };
}
function ready(value: TreasuryAccountingInput) {
  const result = accountTreasury(value);
  expect(result.status).toBe("READY");
  if (result.status !== "READY") throw new Error(result.reasons.join(","));
  return result;
}
function reason(value: TreasuryAccountingInput) {
  const result = accountTreasury(value);
  expect(result.status).toBe("HOLD");
  if (result.status !== "HOLD") throw new Error("Expected a hold");
  expect(result.snapshot).toBeNull();
  return result.reasons;
}

describe("treasury accounting", () => {
  it("summarizes all commitments without an excluded candidate or invented future fee", () => {
    const { candidate: _candidate, fee: _fee, ...value } = input(); void _candidate; void _fee;
    value.commitments = [commitment(), commitment({ purchaseOrderId: "candidate-po", obligationId: "candidate", outstandingMicroUsdc: "1500000" })];
    expect(accountTreasuryOverview({ ...value, category: "office" })).toMatchObject({ status: "READY", availableMicroUsdc: "10500000",
      snapshot: { protectedObligationsMicroUsdc: "4500000", feeAllowanceMicroUsdc: "0" } });
    value.commitments[0]!.essential = false;
    expect(accountTreasuryOverview({ ...value, category: "office" })).toMatchObject({ status: "READY", availableMicroUsdc: "13500000" });
    value.payments = [{ ...reserved(), state: "UNKNOWN" }];
    expect(accountTreasuryOverview({ ...value, category: "office" })).toMatchObject({ status: "HOLD", reasons: ["CASH_INCLUSION_UNRESOLVED"] });
  });
  it("keeps a discounted hold bound to nominal commitments while cash and budgets use actual payout", () => {
    const value = input(); value.payments = [{ ...reserved(), nominalAmountMicroUsdc: "2500000" }];
    value.commitments = [commitment({ purchaseOrderId: "other-po", obligationId: "other", outstandingMicroUsdc: "2500000" })];
    expect(ready(value)).toMatchObject({ totalHeldMicroUsdc: "2010000", snapshot: { protectedObligationsMicroUsdc: "0", dailyHoldsMicroUsdc: "2000000" } });
    value.payments[0]!.nominalAmountMicroUsdc = "2500001";
    expect(reason(value)).toEqual(["COMMITMENT_TERMS_MISMATCH"]);
  });
  it("keeps fractional native fee dust held and rejects inconsistent rounded fees", () => {
    const value = input();
    value.payments = [{ ...reserved(), state: "PENDING", transactionHash, providerId: "provider-1", providerState: "PENDING",
      receipt: { ...receipt(), actualFeeNative: "2999000000000001" } }];
    expect(ready(value).reflectedHeldMicroUsdc).toBe("2002999");
    value.payments[0]!.receipt!.actualFeeMicroUsdc = "2999";
    expect(reason(value)).toEqual(["RECEIPT_FEE_MISMATCH"]);
  });
  it("subtracts reserve, protected obligations and candidate fee without subtracting the candidate twice", () => {
    const value = input();
    value.commitments = [commitment(), commitment({ purchaseOrderId: "candidate-po", obligationId: "candidate", outstandingMicroUsdc: "1500000" })];
    const result = ready(value);
    expect(result.snapshot.feeAllowanceMicroUsdc).toBe("100");
    expect(result.snapshot.protectedObligationsMicroUsdc).toBe("3000000");
    expect(result.availableMicroUsdc).toBe("11999900");
    expect(evaluateTreasury({ now: value.now, dueDate: "2026-11-01", amountMicroUsdc: value.candidate.amountMicroUsdc,
      verification: "VERIFIED", duplicateOrSettled: false, screening: "LOCAL_REGISTRY", exactApprovalValid: false,
      policy: value.policy, snapshot: result.snapshot }).action).toBe("SCHEDULE");
  });
  it("retains old holds across midnight/month rollover and does not count their PO again", () => {
    const value = input(); value.payments = [reserved()];
    value.commitments = [commitment({ purchaseOrderId: "other-po", obligationId: "other", outstandingMicroUsdc: "2000000" })];
    const result = ready(value);
    expect(result.snapshot).toMatchObject({ unreflectedHoldsMicroUsdc: "2010000", protectedObligationsMicroUsdc: "0",
      dailyHoldsMicroUsdc: "2000000", categoryHoldsMicroUsdc: "2000000", hasInFlightTransfer: true });
    expect(result.dailyHeadroomMicroUsdc).toBe("8000000");
    expect(result.categoryHeadroomMicroUsdc).toBe("6000000");
    expect(result.availableMicroUsdc).toBe("12989900");
  });
  it("subtracts only the unreflected remainder when payout and actual gas already reduced cash", () => {
    const value = input(); value.payments = [{ ...reserved(), state: "PENDING", transactionHash, providerId: "provider-1", providerState: "PENDING", receipt: receipt() }];
    const result = ready(value);
    expect(result).toMatchObject({ totalHeldMicroUsdc: "2010000", reflectedHeldMicroUsdc: "2003000", availableMicroUsdc: "14992900" });
    expect(result.snapshot).toMatchObject({ unreflectedHoldsMicroUsdc: "7000", dailyHoldsMicroUsdc: "2000000", hasInFlightTransfer: true });
    value.payments[0]!.receipt!.actualFeeMicroUsdc = "20000";
    expect(ready(value).snapshot.unreflectedHoldsMicroUsdc).toBe("0");
  });
  it.each(["SUBMITTING", "PENDING", "UNKNOWN"] as const)("refuses to guess inclusion for %s", (state) => {
    const value = input(); value.payments = [{ ...reserved(), state }];
    expect(reason(value)).toEqual(["CASH_INCLUSION_UNRESOLVED"]);
  });
  it("counts settled payouts by UTC settlement date and category month, not reservation date", () => {
    const value = input(); const a = settled();
    const b: PaymentLedgerEntry = { ...settled(), intentId: "intent-2", obligationId: "other-2", purchaseOrderId: "po-2",
      transactionHash: `0x${"d".repeat(64)}`, providerId: "provider-2", settledAt: "2026-10-31T23:59:59.000Z",
      receipt: { ...receipt(), transactionHash: `0x${"d".repeat(64)}` } };
    value.payments = [a, b];
    expect(ready(value).snapshot).toMatchObject({ dailySettledMicroUsdc: "2000000", categorySettledMicroUsdc: "2000000", unreflectedHoldsMicroUsdc: "0" });
    value.payments[0]!.category = "another-category";
    expect(ready(value).snapshot).toMatchObject({ dailySettledMicroUsdc: "2000000", categorySettledMicroUsdc: "0" });
  });
  it("protects accepted essential overdue and seven-day obligations, including POs without invoices", () => {
    const value = input(); value.commitments = [
      commitment({ purchaseOrderId: "overdue", obligationId: null, dueDate: "2026-10-20" }),
      commitment({ purchaseOrderId: "boundary", obligationId: null }),
      commitment({ purchaseOrderId: "later", obligationId: null, dueDate: "2026-11-09" }),
      commitment({ purchaseOrderId: "unaccepted", obligationId: null, accepted: false }),
      commitment({ purchaseOrderId: "nonessential", obligationId: null, essential: false }),
      commitment({ purchaseOrderId: "settled", obligationId: null, status: "SETTLED" }) ];
    expect(ready(value).snapshot.protectedObligationsMicroUsdc).toBe("6000000");
  });
  it("accounts reverted gas without consuming payout budgets and requires failure evidence", () => {
    const value = input(); value.payments = [{ ...reserved(), state: "FAILED", reservationState: "RELEASED", transactionHash,
      providerId: "provider-1", providerState: "FAILED", terminalEvidenceReference: "definitive-failure",
      receipt: { ...receipt(), outcome: "REVERTED", amountMicroUsdc: "0" } }];
    expect(ready(value).snapshot).toMatchObject({ dailySettledMicroUsdc: "0", unreflectedHoldsMicroUsdc: "0", hasInFlightTransfer: false });
    value.payments[0]!.receipt = null;
    expect(reason(value)).toEqual(["UNVERIFIED_FAILURE_FEE"]);
  });
  it("counts no hold, expenditure or receipt for a reviewed rejection before transaction creation",()=>{
    const value=input(),payment:PaymentLedgerEntry={...reserved(),state:"FAILED",reservationState:"RELEASED",submissionRejection:{httpStatus:400,providerCode:2,providerRequestId:"a".repeat(32),requestedAt:"2026-10-01T12:00:01.000Z",reason:"TOKEN_ID_AND_BLOCKCHAIN_MISSING",evidenceReference:"reviewed:circle-log"}};
    value.payments=[payment];
    const result=ready(value);expect(result.snapshot).toMatchObject({dailySettledMicroUsdc:"0",dailyHoldsMicroUsdc:"0",categorySettledMicroUsdc:"0",unreflectedHoldsMicroUsdc:"0",hasInFlightTransfer:false});
    expect(result.evidenceReferences).toContain("reviewed:circle-log");
    value.payments=[{...payment,submissionRejection:null}];expect(reason(value)).toEqual(["UNVERIFIED_FAILURE_FEE"]);
    for(const changed of [{providerId:"provider"},{providerState:"FAILED"},{transactionHash},{receipt:receipt()},{state:"UNKNOWN" as const,reservationState:"HELD" as const}]){
      value.payments=[{...payment,...changed}];expect(reason(value)).toEqual(["INCONSISTENT_SUBMISSION_REJECTION"]);
    }
  });
  it("keeps a reverted but unresolved payment held until terminal provider failure", () => {
    const value = input(); value.payments = [{ ...reserved(), state: "UNKNOWN", transactionHash,
      receipt: { ...receipt(), outcome: "REVERTED", amountMicroUsdc: "0" } }];
    expect(ready(value).snapshot).toMatchObject({ unreflectedHoldsMicroUsdc: "2007000", dailyHoldsMicroUsdc: "2000000", hasInFlightTransfer: true });
  });
  it("refuses missing or stale fees and mismatched amount/recipient/wallet/block evidence", () => {
    const value = input(); value.fee = null;
    expect(reason(value)).toEqual(["FEE_EVIDENCE_UNAVAILABLE"]);
    for (const change of [{ amountMicroUsdc: "1" }, { recipient: wallet }, { walletAddress: recipient }, { cashBlockHash: transactionHash }]) {
      const sample = input(); sample.fee = { ...sample.fee!, ...change };
      expect(reason(sample)).toEqual(["FEE_TERMS_MISMATCH"]);
    }
    const stale = input(); stale.fee!.capturedAt = "2026-10-31T23:00:00.000Z";
    expect(reason(stale)).toEqual(["FEE_EVIDENCE_UNAVAILABLE"]);
  });
  it("rejects receipt mismatches and forces a cash refresh when a receipt is newer", () => {
    for (const change of [{ recipient: wallet }, { amountMicroUsdc: "1" }, { walletAddress: recipient }, { cashBlockHash: transactionHash }]) {
      const value = input(); value.payments = [{ ...settled(), receipt: { ...receipt(), ...change } }];
      expect(reason(value)).toEqual(["RECEIPT_TERMS_MISMATCH"]);
    }
    const value = input(); value.payments = [{ ...settled(), receipt: { ...receipt(), blockNumber: "101" } }];
    expect(reason(value)).toEqual(["CASH_PREDATES_RECEIPT"]);
  });
  it("fails closed on duplicate records, cross-business data and candidate reservations", () => {
    const a = input(); a.payments = [settled(), settled()]; expect(reason(a)).toEqual(["DUPLICATE_LEDGER_RECORD"]);
    const b = input(); b.payments = [{ ...reserved(), businessId: "another" }]; expect(reason(b)).toEqual(["ACCOUNTING_BUSINESS_MISMATCH"]);
    const c = input(); c.payments = [{ ...reserved(), obligationId: "candidate" }]; expect(reason(c)).toEqual(["CANDIDATE_ALREADY_RESERVED_OR_SETTLED"]);
    const d = input(); d.payments = [reserved(), { ...reserved(), intentId: "second" }]; expect(reason(d)).toEqual(["MULTIPLE_INFLIGHT_TRANSFERS"]);
    const e = input(); e.commitments = [commitment({ purchaseOrderId: "candidate-po" })]; expect(reason(e)).toEqual(["CANDIDATE_PO_ALREADY_CLAIMED"]);
  });
  it("rejects stale or incompletely covered ledgers, and inconsistent reservation state", () => {
    const value = input(); value.coverageFrom = "2026-11-01T00:00:01.000Z";
    expect(reason(value)).toEqual(["INCOMPLETE_OR_STALE_LEDGER"]);
    value.coverageFrom = "2026-11-01T00:00:00.000Z"; value.ledgerAsOf = "2026-11-01T00:00:08.000Z";
    expect(reason(value)).toEqual(["INCOMPLETE_OR_STALE_LEDGER"]);
    const broken = input(); broken.payments = [{ ...reserved(), reservationState: "RELEASED" }];
    expect(reason(broken)).toEqual(["INCONSISTENT_PAYMENT_LEDGER"]);
  });
  it("clamps displayed availability at zero and fails closed on aggregate overflow", () => {
    const value = input(); value.cash.cashMicroUsdc = "1";
    expect(ready(value).availableMicroUsdc).toBe("0");
    value.commitments = [commitment({ obligationId: null, outstandingMicroUsdc: "99999999999999999999" }),
      commitment({ purchaseOrderId: "second", obligationId: null, outstandingMicroUsdc: "1" })];
    expect(reason(value)).toEqual(["ACCOUNTING_RANGE_OR_EVIDENCE_ERROR"]);
  });
  it("rounds native gas and basis-point buffers upward using exact integers", () => {
    expect(feeAllowanceFromEvidence({ ...input().fee!, gasLimit: "1", maxFeePerGasNative: "1", extraBufferMicroUsdc: "0" })).toBe("1");
    expect(feeAllowanceFromEvidence({ ...input().fee!, gasLimit: "1", maxFeePerGasNative: "1000000000000", bufferBps: 1, extraBufferMicroUsdc: "0" })).toBe("2");
    expect(feeAllowanceFromEvidence({ ...input().fee!, gasLimit: "9007199254740993", maxFeePerGasNative: "1000000000000", extraBufferMicroUsdc: "0" })).toBe("9007199254740993");
  });
});
