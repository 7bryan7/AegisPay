import { describe, expect, it, vi } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, normalizePayableExtraction } from "@agentpay/core";
import { planAccountedPayable } from "../apps/server/src/treasury/evaluate.js";
import { syntheticEnrollment } from "./support/enrollment.js";
import { syntheticPayable } from "./support/payable.js";

const now = new Date("2026-10-09T12:00:00.000Z");
function inputs() {
  const enrollment = syntheticEnrollment();
  const normalized = normalizePayableExtraction(syntheticPayable(), { businessId: enrollment.businessId, id: "invoice", version: 1 });
  if (normalized.status !== "NORMALIZED") throw new Error("Invalid fixture");
  const { verifiedAt: _time, ...vendor } = enrollment.vendors[0]!; void _time;
  const blockHash = `0x${"a".repeat(64)}`, walletAddress = `0x${"1".repeat(40)}`;
  return {
    facts: { obligation: normalized.obligation, vendor, purchaseOrder: enrollment.purchaseOrders[0]!, policy: enrollment.treasury.policy,
      duplicateOrSettled: false, exactApprovalValid: false, screening: "LOCAL_REGISTRY" },
    evidence: { paused: false, cash: { chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS, walletAddress,
      cashMicroUsdc: "20000000", blockNumber: "100", blockHash,
      blockTimestamp: now.toISOString(), capturedAt: now.toISOString(), observedAt: now.toISOString() },
    fee: { chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS, walletAddress, recipient: vendor.address,
      amountMicroUsdc: normalized.obligation.amountMicroUsdc, cashBlockHash: blockHash, capturedAt: now.toISOString(),
      evidenceReference: "synthetic-fee", gasLimit: "21000", maxFeePerGasNative: "1000000000", bufferBps: 0, extraBufferMicroUsdc: "0" },
    ledgerAsOf: now.toISOString(), coverageFrom: "2026-10-01T00:00:00.000Z", payments: [], commitments: [] }
  };
}
const planner = () => ({ modelId: "synthetic", propose: vi.fn(() => Promise.resolve({ candidateId: "due-date",
  reason: "Verified obligation fits current limits.", evidenceIds: ["verified-obligation", "treasury-snapshot", "policy"],
  assumptions: [], alternativeConsidered: "Hold to preserve cash." })) });

describe("accounted planning service", () => {
  it("derives exact candidate terms from independently verified facts and includes native fee conversion", async () => {
    const input = inputs(), model = planner();
    const result = await planAccountedPayable(input.facts, input.evidence, model, () => now);
    expect(result.accounting).toMatchObject({ status: "READY", snapshot: { feeAllowanceMicroUsdc: "21" } });
    expect(result.decision).toMatchObject({ action: "PAY_NOW", candidate: { amountMicroUsdc: "1500000" } });
    expect(model.propose).toHaveBeenCalledOnce();
  });
  it("holds the same invoice when essential commitments consume cash, before invoking the planner", async () => {
    const input = inputs(), model = planner();
    const result = await planAccountedPayable(input.facts, { ...input.evidence, commitments: [{
      businessId: input.facts.obligation.businessId, purchaseOrderId: "other-po", obligationId: null,
      outstandingMicroUsdc: "19000000", dueDate: "2026-10-10", accepted: true, essential: true, status: "OPEN"
    }] }, model, () => now);
    expect(result.accounting).toMatchObject({ status: "READY", snapshot: { protectedObligationsMicroUsdc: "19000000" } });
    expect(result.decision.action).toBe("HOLD"); expect(model.propose).not.toHaveBeenCalled();
  });
  it("refuses missing or mismatched fee evidence and incomplete ledger coverage before invoking the planner", async () => {
    for (const modify of [
      (value: ReturnType<typeof inputs>["evidence"]) => ({ ...value, fee: null }),
      (value: ReturnType<typeof inputs>["evidence"]) => ({ ...value, fee: { ...value.fee, amountMicroUsdc: "1" } }),
      (value: ReturnType<typeof inputs>["evidence"]) => ({ ...value, coverageFrom: now.toISOString() })
    ]) {
      const input = inputs(), model = planner();
      expect((await planAccountedPayable(input.facts, modify(input.evidence), model, () => now)).decision.action).toBe("HOLD");
      expect(model.propose).not.toHaveBeenCalled();
    }
  });
  it("rejects duplicates and unaccepted obligations even when treasury evidence is unavailable", async () => {
    const input = inputs(), model = planner();
    expect((await planAccountedPayable({ ...input.facts, duplicateOrSettled: true }, null, model, () => now)).decision.action).toBe("REJECT");
    input.facts.purchaseOrder.deliveryAccepted = false;
    expect((await planAccountedPayable(input.facts, null, model, () => now)).decision.action).toBe("HOLD");
    expect(model.propose).not.toHaveBeenCalled();
  });
});
