import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fieldEvidenceSchema, invoiceCorrectionSchema, normalizeReviewedExtraction, payableExtractionSchema, payableVendorSchema, verifyObligation } from "@agentpay/core";
import { syntheticPayable } from "./support/payable.js";
import { syntheticEnrollment } from "./support/enrollment.js";

describe("owner invoice corrections", () => {
  it("retains original source text and distinguishes owner evidence from model extraction", () => {
    const raw = syntheticPayable(), before = structuredClone(raw), id = randomUUID(), businessId = randomUUID();
    raw.dueDate = { status: "AMBIGUOUS", value: "09/10", sourceText: "09/10" };
    const result = normalizeReviewedExtraction(raw, { dueDate: { value: "2026-10-09", evidenceReference: "owner:accepted-po" } },
      { businessId, id, version: 3 });
    expect(result.status).toBe("NORMALIZED");
    if (result.status !== "NORMALIZED") throw new Error("expected corrected facts");
    expect(result.obligation.evidence.find((item) => item.field === "dueDate"))
      .toMatchObject({ status: "OPERATOR_VERIFIED", rawText: "09/10", sourceReference: "owner:accepted-po" });
    const enrollment = syntheticEnrollment(businessId);
    expect(verifyObligation(result.obligation, payableVendorSchema.strip().parse(enrollment.vendors[0]), enrollment.purchaseOrders[0]).status).toBe("VERIFIED");
    expect(raw.total).toEqual(before.total);
    expect(raw.dueDate.sourceText).toBe("09/10");
  });
  it("carries service terms and source line items while keeping correction provenance and checking arithmetic", () => {
    const businessId = randomUUID(), manifest = syntheticEnrollment(businessId), raw = syntheticPayable();
    const field = (value: string) => ({ value, sourceText: value, status: "EXTRACTED" as const });
    raw.serviceDescription = field("Hosted service"); raw.servicePeriod = field("September 2026"); raw.paymentTerms = field("Net 30");
    raw.lineItems = [{ description: field("Hosted service"), quantity: field("1"), unitPrice: field("1.40"), amount: field("1.40") }];
    const result = normalizeReviewedExtraction(raw, { servicePeriod: { value: "October 2026", evidenceReference: "owner:accepted-period" } }, { businessId, id: randomUUID(), version: 1 });
    if (result.status !== "NORMALIZED") throw new Error("expected facts");
    expect(result.obligation).toMatchObject({ serviceDescription: "Hosted service", servicePeriod: "October 2026", paymentTerms: "Net 30", lineItems: raw.lineItems });
    expect(result.obligation.evidence.find((item) => item.field === "servicePeriod")).toMatchObject({ status: "OPERATOR_VERIFIED", rawText: "September 2026", sourceReference: "owner:accepted-period" });
    const vendor = payableVendorSchema.strip().parse(manifest.vendors[0]), po = { ...manifest.purchaseOrders[0], servicePeriod: "October 2026" };
    expect(verifyObligation(result.obligation, vendor, po).status).toBe("VERIFIED");
    expect(verifyObligation(result.obligation, vendor, { ...po, servicePeriod: "September 2026" }).reasons).toContain("SERVICE_PERIOD_MISMATCH");
    result.obligation.lineItems![0]!.amount.value = "1.41";
    expect(verifyObligation(result.obligation, vendor, po).reasons).toContain("LINE_ITEM_SUBTOTAL_MISMATCH");
  });
  it("does not let model output claim owner verification or corrections bypass accounting/evidence", () => {
    const raw = syntheticPayable(), identity = { businessId: randomUUID(), id: randomUUID(), version: 1 };
    expect(payableExtractionSchema.safeParse({ ...raw, total: { ...raw.total, status: "OPERATOR_VERIFIED" } }).success).toBe(false);
    expect(fieldEvidenceSchema.safeParse({ id: "owner", field: "total", status: "OPERATOR_VERIFIED", rawText: null, sourceReference: null }).success).toBe(false);
    expect(invoiceCorrectionSchema.safeParse({ commandId: randomUUID(), expectedVersion: 1, reason: "review", fields: { recipient: "attacker" } }).success).toBe(false);
    const corrected = normalizeReviewedExtraction(raw, { total: { value: "2", evidenceReference: "owner:invoice" } }, identity);
    if (corrected.status !== "NORMALIZED") throw new Error("expected schema-valid amount");
    const enrollment = syntheticEnrollment(identity.businessId);
    expect(verifyObligation(corrected.obligation, payableVendorSchema.strip().parse(enrollment.vendors[0]), enrollment.purchaseOrders[0]).reasons).toContain("ARITHMETIC_MISMATCH");
    expect(normalizeReviewedExtraction(raw, { total: { value: null, evidenceReference: "owner:missing" } }, identity).status).toBe("HOLD");
  });
});
