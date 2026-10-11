import { describe, expect, it } from "vitest";
import { enrollmentSchema } from "@agentpay/core";
import { validateEnrollment } from "../apps/server/src/obligations/enroll.js";
import { syntheticEnrollment } from "./support/enrollment.js";

const context = { businessId: "local-business", actorId: "synthetic-owner", role: "OPERATOR" as const, paymentMode: "fixture" as const };
describe("owner enrollment validation", () => {
  it("accepts labeled fixtures and validates independent owner setup without a database call", () => {
    const fixture = syntheticEnrollment();
    expect(validateEnrollment(context, fixture)).toEqual(fixture);
    const owner = { ...fixture, kind: "owner_verified", treasury: { ...fixture.treasury, paymentMode: "disabled" } };
    expect(validateEnrollment({ ...context, paymentMode: "disabled" }, owner).kind).toBe("owner_verified");
  });
  it("rejects role/business/mode mismatches and fixture data in a live configuration", () => {
    const manifest = syntheticEnrollment();
    for (const change of [{ businessId: "another-business" }, { paymentMode: "arc_testnet" as const }, { role: "REVIEWER" as "OPERATOR" }]) {
      expect(() => validateEnrollment({ ...context, ...change }, manifest)).toThrow();
    }
    expect(() => enrollmentSchema.parse({ ...manifest, treasury: { ...manifest.treasury, paymentMode: "arc_testnet" } })).toThrow();
  });
  it("rejects conflicting identities, foreign records and unverified delivery", () => {
    const manifest = syntheticEnrollment(), vendor = manifest.vendors[0]!, po = manifest.purchaseOrders[0]!;
    for (const change of [
      { vendors: [vendor, vendor] }, { purchaseOrders: [po, po] },
      { vendors: [{ ...vendor, businessId: "foreign" }] }, { purchaseOrders: [{ ...po, vendorId: "missing" }] },
      { purchaseOrders: [{ ...po, acceptanceReference: null }] },
      { purchaseOrders: [{ ...po, activeObligationId: "claimed" }] },
      { purchaseOrders: [{ ...po, outstandingMicroUsdc: "1000000" }] },
      { vendors: [{ ...vendor, address: manifest.treasury.walletAddress }] },
      { vendors: [{ ...vendor, addressVersion: 2 }] }
    ]) expect(() => enrollmentSchema.parse({ ...manifest, ...change })).toThrow();
  });
  it("rejects imprecise money, inconsistent limits, future verification and injected extra fields", () => {
    const manifest = syntheticEnrollment();
    expect(() => enrollmentSchema.parse({ ...manifest, secret: "do-not-copy" })).toThrow();
    expect(() => enrollmentSchema.parse({ ...manifest, treasury: { ...manifest.treasury,
      policy: { ...manifest.treasury.policy, autoPayMaxMicroUsdc: "6000000" } } })).toThrow();
    expect(() => enrollmentSchema.parse({ ...manifest, purchaseOrders: [{ ...manifest.purchaseOrders[0], amountMicroUsdc: "1.5" }] })).toThrow();
    expect(() => validateEnrollment(context, { ...manifest, vendors: [{ ...manifest.vendors[0], verifiedAt: "9999-01-01T00:00:00.000Z" }] })).toThrow();
  });
});
