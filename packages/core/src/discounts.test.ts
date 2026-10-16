import { describe, expect, it } from "vitest";
import { compareVerifiedDiscount } from "./discounts.js";

const input = () => ({ nominalAmountMicroUsdc: "9007199254740993", dueDate: "2026-11-15", now: "2026-10-15T12:00:00.000Z",
  terms: { discountedAmountMicroUsdc: "9007199254740000", validThrough: "2026-10-20", verifiedAt: "2026-10-14T00:00:00.000Z",
    verificationReference: "owner:discount-agreement", settlesInFull: true as const }, annualCashPreservationCostBps: 0 });
describe("verified exact-amount early-payment discounts", () => {
  it("preserves large amounts exactly and keeps nominal, savings and payout separate", () => {
    expect(compareVerifiedDiscount(input())).toMatchObject({ status: "AVAILABLE", comparison: {
      nominalAmountMicroUsdc: "9007199254740993", payoutAmountMicroUsdc: "9007199254740000", discountAdjustmentMicroUsdc: "993",
      cashPreservationCostMicroUsdc: "0", daysEarly: 31 } });
  });
  it("requires verified full-settlement terms and rejects future verification, non-savings and invented fields", () => {
    for (const terms of [{ ...input().terms, verifiedAt: "2026-10-16T00:00:00.000Z" },
      { ...input().terms, discountedAmountMicroUsdc: input().nominalAmountMicroUsdc }, { ...input().terms, settlesInFull: false },
      { ...input().terms, validThrough: "2026-12-01" }, { ...input().terms, recipient: "attacker" }])
      expect(compareVerifiedDiscount({ ...input(), terms }).status).toBe("INVALID");
  });
  it("expires at the documented UTC day and compares an explicit upward-rounded cash cost", () => {
    expect(compareVerifiedDiscount({ ...input(), now: "2026-10-21T00:00:00.000Z" }).status).toBe("NONE");
    expect(compareVerifiedDiscount({ ...input(), annualCashPreservationCostBps: 1 })).toMatchObject({ status: "NONE", reason: "DISCOUNT_DOES_NOT_COVER_CASH_COST" });
    expect(compareVerifiedDiscount({ ...input(), nominalAmountMicroUsdc: "1000000", terms: { ...input().terms, discountedAmountMicroUsdc: "900000" },
      annualCashPreservationCostBps: 100 })).toMatchObject({ status: "AVAILABLE", comparison: { cashPreservationCostMicroUsdc: "765" } });
    expect(compareVerifiedDiscount({ ...input(), terms: null })).toMatchObject({ status: "NONE", reason: "NO_VERIFIED_DISCOUNT" });
  });
});
