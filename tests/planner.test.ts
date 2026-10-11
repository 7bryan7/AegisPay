import { describe, expect, it, vi } from "vitest";
import type { generateText } from "ai";
import { normalizePayableExtraction } from "@agentpay/core";
import { createGeminiPayablePlanner, planPayable, type PlanningContext, type PayablePlanner } from "../apps/server/src/agent/planner.js";
import { syntheticPayable } from "./support/payable.js";
import { syntheticEnrollment } from "./support/enrollment.js";

const now = new Date("2026-10-09T12:00:00.000Z");
function context(): PlanningContext {
  const manifest = syntheticEnrollment();
  const normalized = normalizePayableExtraction(syntheticPayable(), { businessId: manifest.businessId, id: "invoice", version: 1 });
  if (normalized.status !== "NORMALIZED") throw new Error("Invalid test fixture");
  const { verifiedAt: _verifiedAt, ...vendor } = manifest.vendors[0]!;
  void _verifiedAt;
  return { obligation: normalized.obligation, vendor, purchaseOrder: manifest.purchaseOrders[0]!, policy: manifest.treasury.policy,
    duplicateOrSettled: false, exactApprovalValid: false, screening: "LOCAL_REGISTRY",
    snapshot: { capturedAt: now.toISOString(), cashMicroUsdc: "20000000", unreflectedHoldsMicroUsdc: "0",
      protectedObligationsMicroUsdc: "0", feeAllowanceMicroUsdc: "10000", dailySettledMicroUsdc: "0", dailyHoldsMicroUsdc: "0",
      categorySettledMicroUsdc: "0", categoryHoldsMicroUsdc: "0", inclusionEvidenceVerified: true, hasInFlightTransfer: false, paused: false } };
}
const proposal = { candidateId: "due-date", reason: "Verified invoice is due and fits the supplied limits.",
  evidenceIds: ["verified-obligation", "treasury-snapshot", "policy"], assumptions: [], alternativeConsidered: "Preserve cash by holding." };
const planner = (value: unknown = proposal): PayablePlanner => ({ modelId: "synthetic", propose: () => Promise.resolve(value) });

describe("bounded payable planning", () => {
  it("selects only server-approved timing and amounts and can choose to preserve cash", async () => {
    expect(await planPayable(context(), planner(), () => now)).toMatchObject({ action: "PAY_NOW", candidate: { amountMicroUsdc: "1500000" } });
    const future = context(); future.obligation.dueDate = "2026-10-10"; future.purchaseOrder!.dueDate = "2026-10-10";
    expect(await planPayable(future, planner(), () => now)).toMatchObject({ action: "SCHEDULE", candidate: { executeAt: "2026-10-10T09:00:00.000Z" } });
    expect(await planPayable(context(), planner({ ...proposal, candidateId: "preserve-cash", evidenceIds: ["treasury-snapshot"] }), () => now))
      .toMatchObject({ action: "HOLD", reasons: ["VALIDATED_MODEL_CHOICE"] });
  });
  it("stops before calling the model for missing acceptance, low cash, duplicate invoices or a soft threshold", async () => {
    for (const [change, expected] of [
      [(c: PlanningContext) => { c.purchaseOrder!.deliveryAccepted = false; }, "HOLD"],
      [(c: PlanningContext) => { c.snapshot.protectedObligationsMicroUsdc = "19000000"; }, "HOLD"],
      [(c: PlanningContext) => { c.duplicateOrSettled = true; }, "REJECT"],
      [(c: PlanningContext) => { c.policy.autoPayMaxMicroUsdc = "1000000"; }, "REQUIRE_APPROVAL"]
    ] as const) {
      const input = context(); change(input); const adapter = { modelId: "synthetic", propose: vi.fn() };
      expect((await planPayable(input, adapter, () => now)).action).toBe(expected);
      expect(adapter.propose).not.toHaveBeenCalled();
    }
  });
  it("holds on unavailable/failed models, unsupported evidence, invented candidates and extra transfer fields", async () => {
    expect((await planPayable(context(), null, () => now)).reasons).toEqual(["PLANNER_UNAVAILABLE"]);
    expect((await planPayable(context(), { modelId: "synthetic", propose: () => Promise.reject(new Error("private-token")) }, () => now)).reasons).toEqual(["PLANNER_FAILED"]);
    for (const output of [null, { ...proposal, candidateId: "pay-any-address" }, { ...proposal, amountMicroUsdc: "1" },
      { ...proposal, evidenceIds: ["invented"] }, { ...proposal, assumptions: ["Assume delivery"] }]) {
      expect((await planPayable(context(), planner(output), () => now)).reasons).toEqual(["INVALID_PLANNER_PROPOSAL"]);
    }
  });
  it("discards stale model results and prevents adapters from altering authoritative candidates", async () => {
    let time = now;
    const slow = { modelId: "synthetic", propose: () => { time = new Date(now.getTime() + 31_000); return Promise.resolve(proposal); } };
    expect((await planPayable(context(), slow, () => time)).reasons).toEqual(["PLANNING_CONTEXT_EXPIRED"]);
    const malicious: PayablePlanner = { modelId: "synthetic", propose: (input, candidates) => {
      input.obligation.amountMicroUsdc = "1"; candidates[0]!.amountMicroUsdc = "1"; return Promise.resolve(proposal);
    } };
    expect((await planPayable(context(), malicious, () => now)).candidate?.amountMicroUsdc).toBe("1500000");
  });
  it("uses structured Gemini output without tools or signing access", async () => {
    const generate = vi.fn(() => Promise.resolve({ output: proposal })) as unknown as typeof generateText;
    const adapter = createGeminiPayablePlanner({ EXTRACTION_MODEL_API_KEY: "synthetic", EXTRACTION_MODEL_ID: "synthetic-model",
      EXTRACTION_MODEL_BASE_URL: "https://generativelanguage.googleapis.com/v1beta" }, generate);
    expect((await planPayable(context(), adapter, () => now)).action).toBe("PAY_NOW");
    expect(vi.mocked(generate).mock.calls[0]?.[0]?.tools).toBeUndefined();
    expect(vi.mocked(generate).mock.calls[0]?.[0]?.maxRetries).toBe(0);
    expect(() => createGeminiPayablePlanner({ PAYMENT_MODE: "fixture", EXTRACTION_MODEL_API_KEY: "synthetic",
      EXTRACTION_MODEL_ID: "synthetic-model", EXTRACTION_MODEL_BASE_URL: "https://generativelanguage.googleapis.com/v1beta" }, generate)).toThrow("LIVE_PLANNER_DISABLED_IN_FIXTURE_MODE");
  });
});
