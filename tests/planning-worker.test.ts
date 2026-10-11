import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, normalizePayableExtraction } from "@agentpay/core";
import { preparePlanning, revalidatePlanning, type PlanningAdapters } from "../apps/server/src/treasury/prepare.js";
import { planningStateSchema, readPlanningState, type PlanningState } from "../apps/server/src/treasury/ledger.js";
import type * as Ledger from "../apps/server/src/treasury/ledger.js";
import { createWorkerPlanning } from "../apps/server/src/treasury/runtime.js";
import { syntheticEnrollment } from "./support/enrollment.js";
import { syntheticPayable } from "./support/payable.js";

vi.mock("../apps/server/src/treasury/ledger.js", async (original) => ({
  ...await original<typeof Ledger>(), readPlanningState: vi.fn()
}));
const time = new Date("2026-10-09T12:00:00.000Z"), hash = `0x${"a".repeat(64)}`;
const claim = { business_id: "local-business", id: "invoice", version: 1, lease_owner: "lease", raw_extraction: null, purchase_order_hint: null };
const pool = {} as Pool; // No database behavior is asserted by this orchestration suite.
function state(): PlanningState {
  const manifest = syntheticEnrollment();
  const { verifiedAt: _time, ...vendor } = manifest.vendors[0]!; void _time;
  return { treasury: { businessId: manifest.businessId, walletId: manifest.treasury.walletId,
    walletAddress: manifest.treasury.walletAddress, chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS,
    mode: "fixture", paused: false, policy: manifest.treasury.policy, policyVersion: 1 },
  vendors: [vendor], purchaseOrders: manifest.purchaseOrders, payments: [], validBindings: true };
}
function adapters() {
  return { mode: "fixture" as PlanningAdapters["mode"], planner: { modelId: "synthetic", propose: vi.fn(() => Promise.resolve({ candidateId: "due-date",
    reason: "Verified terms fit funding limits.", evidenceIds: ["verified-obligation", "treasury-snapshot", "policy"],
    assumptions: [], alternativeConsidered: "Hold for more cash." })) },
  readCash: vi.fn<PlanningAdapters["readCash"]>(() => Promise.resolve({ chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS,
    walletAddress: state().treasury.walletAddress, cashMicroUsdc: "20000000", blockNumber: "100", blockHash: hash,
    capturedAt: time.toISOString(), blockTimestamp: time.toISOString(), observedAt: time.toISOString() })),
  estimateFee: vi.fn<PlanningAdapters["estimateFee"]>((cash, recipient, amountMicroUsdc) => Promise.resolve({ chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS,
    walletAddress: cash.walletAddress, recipient, amountMicroUsdc, cashBlockHash: cash.blockHash,
    capturedAt: time.toISOString(), evidenceReference: "synthetic-fee", gasLimit: "21000", maxFeePerGasNative: "1000000000",
    bufferBps: 0, extraBufferMicroUsdc: "0" })) } satisfies PlanningAdapters;
}
beforeEach(() => { vi.mocked(readPlanningState).mockReset().mockImplementation(() => Promise.resolve(state())); });

describe("worker treasury planning", () => {
  it("loads the complete ledger after cash and derives eligible terms from independent records", async () => {
    const deps = adapters();
    const result = await preparePlanning(pool, claim, syntheticPayable(), deps, () => time);
    expect(result.decision).toMatchObject({ action: "PAY_NOW", candidate: { amountMicroUsdc: "1500000" } });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidence).toMatchObject({ coverageFrom: "1970-01-01T00:00:00.000Z", ledgerAsOf: time.toISOString() });
    expect(readPlanningState).toHaveBeenCalledTimes(2);
    expect(deps.estimateFee).toHaveBeenCalledWith(expect.anything(), state().vendors[0]!.address, "1500000");
  });
  it("discards changed policy or commitments while a network read was in flight", async () => {
    const changed = state(); changed.treasury.policyVersion++;
    vi.mocked(readPlanningState).mockResolvedValueOnce(state()).mockResolvedValueOnce(changed);
    const deps = adapters();
    expect((await preparePlanning(pool, claim, syntheticPayable(), deps, () => time)).decision.reasons).toEqual(["PLANNING_STATE_CHANGED"]);
    expect(deps.planner.propose).not.toHaveBeenCalled();
  });
  it("protects every accepted open PO even without an invoice upload", async () => {
    const records = state();
    records.purchaseOrders.push({ ...records.purchaseOrders[0]!, id: "other-po", amountMicroUsdc: "19000000", outstandingMicroUsdc: "19000000" });
    vi.mocked(readPlanningState).mockResolvedValue(records);
    const result = await preparePlanning(pool, claim, syntheticPayable(), adapters(), () => time);
    expect(result.decision.reasons).toEqual(["CASH_RESERVE"]);
    expect(result.accounting).toMatchObject({ status: "READY", snapshot: { protectedObligationsMicroUsdc: "19000000" } });
  });
  it("does not infer approval and preserves the soft threshold requirement", async () => {
    const records = state(); records.treasury.policy.autoPayMaxMicroUsdc = "1000000";
    vi.mocked(readPlanningState).mockResolvedValue(records);
    const deps = adapters();
    expect((await preparePlanning(pool, claim, syntheticPayable(), deps, () => time)).decision.action).toBe("REQUIRE_APPROVAL");
    expect(deps.planner.propose).not.toHaveBeenCalled();
  });
  it("revalidates proposals at persistence without another model call and refuses changed/stale state", async () => {
    const deps = adapters(), records = state();
    const prepared = await preparePlanning(pool, claim, syntheticPayable(), deps, () => time);
    const normalized = normalizePayableExtraction(syntheticPayable(), { businessId: claim.business_id, id: claim.id, version: 2 });
    if (normalized.status !== "NORMALIZED") throw new Error("Invalid fixture");
    const finish = (s: PlanningState, at: Date) => revalidatePlanning(prepared, s, normalized.obligation,
      s.vendors[0]!, s.purchaseOrders[0]!, () => at);
    expect((await finish(records, time)).decision.action).toBe("PAY_NOW");
    expect((await finish(records, new Date(time.getTime() + 31000))).decision.reasons).toEqual(["STALE_CASH_EVIDENCE"]);
    records.treasury.paused = true;
    expect((await finish(records, time)).decision.reasons).toEqual(["PLANNING_STATE_CHANGED"]);
    expect(deps.planner.propose).toHaveBeenCalledOnce();
  });
  it("holds on mode mismatch, private provider failures and stale cash instead of invoking the model", async () => {
    const wrong = adapters(); wrong.mode = "arc_testnet";
    expect((await preparePlanning(pool, claim, syntheticPayable(), wrong, () => time)).decision.reasons).toEqual(["PLANNING_MODE_MISMATCH"]);
    expect(wrong.readCash).not.toHaveBeenCalled();
    const broken = adapters(); broken.readCash.mockRejectedValue(new Error("private-provider-secret"));
    expect((await preparePlanning(pool, claim, syntheticPayable(), broken, () => time)).decision.reasons).toEqual(["TREASURY_EVIDENCE_UNAVAILABLE"]);
    const stale = adapters();
    expect((await preparePlanning(pool, claim, syntheticPayable(), stale, () => new Date(time.getTime() + 31000))).decision.action).toBe("HOLD");
    expect(stale.planner.propose).not.toHaveBeenCalled();
  });
  it("fails closed on incomplete ledger bindings and keeps exact decimal strings", () => {
    expect(planningStateSchema.safeParse({ ...state(), validBindings: false }).success).toBe(false);
    const records = state(); records.purchaseOrders[0]!.amountMicroUsdc = "9007199254740993";
    expect(planningStateSchema.parse(records).purchaseOrders[0]!.amountMicroUsdc).toBe("9007199254740993");
  });
  it("holds unresolved submissions without treating stored provider status as cash inclusion proof", async () => {
    const records = state();
    records.payments = [{ businessId: claim.business_id, intentId: "other-intent", obligationId: "other-invoice",
      purchaseOrderId: "other-po", category: records.vendors[0]!.category, recipient: records.vendors[0]!.address,
      amountMicroUsdc: "1500000", feeAllowanceMicroUsdc: "1000", state: "UNKNOWN", reservationState: "HELD",
      reservedAt: "2026-09-01T00:00:00.000Z", settledAt: null, transactionHash: null, providerId: null,
      providerState: null, terminalEvidenceReference: null, receipt: null }];
    vi.mocked(readPlanningState).mockResolvedValue(records);
    const deps = adapters(), result = await preparePlanning(pool, claim, syntheticPayable(), deps, () => time);
    expect(result.decision.reasons).toEqual(["CASH_INCLUSION_UNRESOLVED"]);
    expect(deps.planner.propose).not.toHaveBeenCalled();
  });
  it("requires independent acceptance before querying the chain", async () => {
    const records = state(); records.purchaseOrders[0]!.deliveryAccepted = false;
    vi.mocked(readPlanningState).mockResolvedValue(records);
    const deps = adapters();
    expect((await preparePlanning(pool, claim, syntheticPayable(), deps, () => time)).decision.action).toBe("HOLD");
    expect(deps.readCash).not.toHaveBeenCalled(); expect(deps.planner.propose).not.toHaveBeenCalled();
  });
  it("never constructs live planning in fixture/disabled mode or with missing configuration", () => {
    expect(createWorkerPlanning({ PAYMENT_MODE: "fixture" })).toBeNull();
    expect(createWorkerPlanning({ PAYMENT_MODE: "disabled" })).toBeNull();
    expect(createWorkerPlanning({ PAYMENT_MODE: "arc_testnet" })).toBeNull();
    const environment = { PAYMENT_MODE: "arc_testnet", CIRCLE_WALLET_ID: "synthetic-wallet", ARC_RPC_URL: "https://rpc.testnet.arc.io",
      ARC_CHAIN_ID: "5042002", ARC_USDC_ADDRESS, SCREENING_MODE: "local_registry", FEE_BUFFER_BPS: "2500", FEE_EXTRA_BUFFER_MICRO_USDC: "1000" };
    expect(createWorkerPlanning(environment)).toMatchObject({ mode: "arc_testnet", planner: null });
    expect(createWorkerPlanning({ ...environment, SCREENING_MODE: "external_required" })).toBeNull();
    expect(createWorkerPlanning({ ...environment, ARC_CHAIN_ID: "1" })).toBeNull();
  });
});
