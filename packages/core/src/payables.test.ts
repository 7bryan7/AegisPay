import { describe, expect, it } from "vitest";
import {
  ARC_CHAIN_ID, ARC_USDC_ADDRESS, MAX_MICRO_USDC, dateOnlySchema, evaluateTreasury, formatMicroUsdc, isExactApprovalValid,
  microUsdcToUsdc, nativeUsdcToMicroUsdcCeil, normalizeInvoiceNumber, normalizePayableExtraction,
  parseMicroUsdc, payableExtractionSchema, usdcToMicroUsdc, validatePlannerProposal, verifyObligation
} from "./index.js";

const address = "0x1111111111111111111111111111111111111111";
const vendor = { businessId: "business", id: "vendor", name: "Example Studio", aliases: ["Example"],
  status: "APPROVED", address, addressVersion: 1, chainId: ARC_CHAIN_ID, category: "design",
  settlementCurrency: "USD", settlementAgreementReference: "agreement-1", verificationReference: "owner-check-1" };
const po = { businessId: "business", id: "po-1", vendorId: "vendor", version: 1,
  amountMicroUsdc: "1500000", outstandingMicroUsdc: "1500000", deliveryAccepted: true,
  acceptanceReference: "delivery-1", description: "Accepted design", dueDate: "2026-10-08", activeObligationId: null };
const fields = ["vendorName", "invoiceNumber", "purchaseOrderId", "currency", "issueDate", "dueDate", "subtotalMicroUsdc", "taxMicroUsdc", "amountMicroUsdc"];
const invoice = { businessId: "business", id: "invoice", version: 1, vendorName: "Example", invoiceNumber: "INV-1",
  purchaseOrderId: "po-1", currency: "USD", issueDate: "2026-10-01", dueDate: "2026-10-08",
  subtotalMicroUsdc: "1400000", taxMicroUsdc: "100000", amountMicroUsdc: "1500000", printedAddress: null,
  evidence: fields.map((field) => ({ id: field, field, status: "EXTRACTED", rawText: `synthetic ${field}`, sourceReference: null })) };
const input = { now: "2026-10-08T12:00:00.000Z", dueDate: "2026-10-08", amountMicroUsdc: "1500000",
  verification: "VERIFIED", duplicateOrSettled: false, screening: "LOCAL_REGISTRY", exactApprovalValid: false,
  policy: { autoPayMaxMicroUsdc: "2000000", hardTxMaxMicroUsdc: "5000000", dailyBudgetMicroUsdc: "10000000", categoryBudgetMicroUsdc: "8000000", minReserveMicroUsdc: "5000000" },
  snapshot: { capturedAt: "2026-10-08T11:59:50.000Z", cashMicroUsdc: "20000000", unreflectedHoldsMicroUsdc: "0",
    protectedObligationsMicroUsdc: "0", feeAllowanceMicroUsdc: "10000", dailySettledMicroUsdc: "0", dailyHoldsMicroUsdc: "0",
    categorySettledMicroUsdc: "0", categoryHoldsMicroUsdc: "0", inclusionEvidenceVerified: true, hasInFlightTransfer: false, paused: false } };

describe("USDC precision", () => {
  it("round trips values beyond Number.MAX_SAFE_INTEGER and the database maximum", () => {
    for (const amount of [0n, 1n, 1_500_001n, 9_007_199_254_740_993n, MAX_MICRO_USDC]) {
      expect(usdcToMicroUsdc(microUsdcToUsdc(amount))).toBe(amount);
      expect(parseMicroUsdc(formatMicroUsdc(amount))).toBe(amount);
    }
  });
  it.each(["-1", "+1", "1e3", "1,000", "01", ".5", "1.", " 1", "1.0000001", "100000000000000"])("rejects unsafe decimal %s", (value) => {
    expect(() => usdcToMicroUsdc(value)).toThrow();
  });
  it("rejects overflow and rounds native fees upward", () => {
    expect(() => formatMicroUsdc(MAX_MICRO_USDC + 1n)).toThrow();
    expect(() => formatMicroUsdc(-1n)).toThrow();
    expect(nativeUsdcToMicroUsdcCeil(0n)).toBe(0n);
    expect(nativeUsdcToMicroUsdcCeil(1n)).toBe(1n);
    expect(nativeUsdcToMicroUsdcCeil(1_000_000_000_000n)).toBe(1n);
    expect(nativeUsdcToMicroUsdcCeil(1_000_000_000_001n)).toBe(2n);
  });
});

describe("obligation evidence", () => {
  it("normalizes source decimals and preserves evidence without granting verified status", () => {
    const visible = { vendorName: "Example", invoiceNumber: "inv-1", issueDate: "2026-10-01", dueDate: "2026-10-08",
      purchaseOrderReference: "po-1", currency: "usd", subtotal: "1.40", tax: "0.10", total: "1.50" };
    const missing = { value: null, status: "MISSING", sourceText: null };
    const raw = { ...Object.fromEntries(Object.entries(visible).map(([key, value]) => [key, { value, status: "EXTRACTED", sourceText: value }])),
      printedAddress: missing, serviceDescription: missing, servicePeriod: missing, paymentTerms: missing, lineItems: [] };
    const identity = { businessId: "business", id: "invoice", version: 1 };
    const normalized = normalizePayableExtraction(raw, identity);
    expect(normalized.status).toBe("NORMALIZED");
    if (normalized.status !== "NORMALIZED") throw new Error("Expected normalized source facts");
    expect(normalized.obligation.amountMicroUsdc).toBe("1500000");
    expect(normalized.obligation.invoiceNumber).toBe("INV-1");
    expect(normalized.obligation.evidence.find((item) => item.field === "amountMicroUsdc")?.rawText).toBe("1.50");
    expect(verifyObligation(normalized.obligation, vendor, po).status).toBe("VERIFIED");
    for (const change of [{ currency: missing }, { dueDate: { value: "10/08/2026", status: "EXTRACTED", sourceText: "10/08/2026" } },
      { total: { value: "1.0000001", status: "EXTRACTED", sourceText: "1.0000001" } }, { printedAddress: { ...missing, status: "AMBIGUOUS" } },
      { printedAddress: { value: "42 Arc Lane, Chennai, Tamil Nadu 600018, India", status: "EXTRACTED", sourceText: "42 Arc Lane, Chennai, Tamil Nadu 600018, India" } }]) {
      expect(normalizePayableExtraction({ ...raw, ...change }, identity).status).toBe("HOLD");
    }
  });
  it("preserves missing extraction facts and rejects invented values", () => {
    const rawFields = ["vendorName", "invoiceNumber", "issueDate", "dueDate", "purchaseOrderReference", "currency", "subtotal", "tax", "total", "printedAddress", "serviceDescription", "servicePeriod", "paymentTerms"];
    const raw = { ...Object.fromEntries(rawFields.map((field) => [field, { value: null, status: "MISSING", sourceText: null }])), lineItems: [] };
    expect(payableExtractionSchema.safeParse(raw).success).toBe(true);
    expect(payableExtractionSchema.safeParse({ ...raw, total: { value: "1.50", status: "MISSING", sourceText: null } }).success).toBe(false);
    expect(payableExtractionSchema.safeParse({ ...raw, total: { value: "1.50", status: "EXTRACTED", sourceText: null } }).success).toBe(false);
  });
  it("accepts matched independent records", () => expect(verifyObligation(invoice, vendor, po).status).toBe("VERIFIED"));
  it.each(["2026-02-29", "2026-04-31", "10/08/2026", "0000-01-01"])("rejects ambiguous or invalid date %s", (date) => {
    expect(dateOnlySchema.safeParse(date).success).toBe(false);
  });
  it("accepts leap days and preserves invoice identity punctuation", () => {
    expect(dateOnlySchema.parse("2028-02-29")).toBe("2028-02-29");
    expect(normalizeInvoiceNumber(" inv-1 ")).toBe("INV-1");
    expect(normalizeInvoiceNumber("INV1")).not.toBe(normalizeInvoiceNumber("INV-1"));
  });
  it.each([
    { taxMicroUsdc: "100001" }, { printedAddress: "0x2222222222222222222222222222222222222222" },
    { businessId: "another-business" }, { dueDate: "2026-10-09" }, { currency: "EUR" },
    { evidence: [] }, { vendorName: "Unknown" }, { amountMicroUsdc: "1600000" },
    { evidence: invoice.evidence.map((item) => ({ ...item, status: "AMBIGUOUS" })) }
  ])("holds inconsistent invoice facts %j", (change) => {
    expect(verifyObligation({ ...invoice, ...change }, vendor, po).status).toBe("HOLD");
  });
  it("requires acceptance, available PO and an approved vendor", () => {
    expect(verifyObligation(invoice, vendor, { ...po, deliveryAccepted: false }).status).toBe("HOLD");
    expect(verifyObligation(invoice, vendor, { ...po, activeObligationId: "another" }).status).toBe("HOLD");
    expect(verifyObligation(invoice, { ...vendor, status: "BLOCKED" }, po).status).toBe("REJECT");
  });
});

describe("treasury eligibility", () => {
  it("offers a due payment or a future schedule without reserving funds", () => {
    expect(evaluateTreasury(input).action).toBe("PAY_NOW");
    const future = evaluateTreasury({ ...input, dueDate: "2026-10-09" });
    expect(future.action).toBe("SCHEDULE");
    expect(future.candidates[0]?.executeAt).toBe("2026-10-09T09:00:00.000Z");
  });
  it("uses a soft threshold but approval never overrides hard limits", () => {
    expect(evaluateTreasury({ ...input, amountMicroUsdc: "3500000" }).action).toBe("REQUIRE_APPROVAL");
    expect(evaluateTreasury({ ...input, amountMicroUsdc: "3500000", exactApprovalValid: true }).action).toBe("PAY_NOW");
    expect(evaluateTreasury({ ...input, amountMicroUsdc: "5000001", exactApprovalValid: true }).reasons).toContain("HARD_CEILING");
  });
  it.each([
    [{ cashMicroUsdc: "6509999" }, "CASH_RESERVE"],
    [{ protectedObligationsMicroUsdc: "14000000" }, "CASH_RESERVE"],
    [{ unreflectedHoldsMicroUsdc: "14000000" }, "CASH_RESERVE"],
    [{ dailyHoldsMicroUsdc: "9000000" }, "DAILY_BUDGET"],
    [{ categoryHoldsMicroUsdc: "7000000" }, "CATEGORY_BUDGET"],
    [{ hasInFlightTransfer: true }, "UNRESOLVED_TRANSFER"],
    [{ paused: true }, "AUTONOMY_PAUSED"],
    [{ capturedAt: "2026-10-08T11:59:29.000Z" }, "STALE_OR_UNVERIFIED_CASH"],
    [{ capturedAt: "2026-10-08T12:00:01.000Z" }, "STALE_OR_UNVERIFIED_CASH"],
    [{ inclusionEvidenceVerified: false }, "STALE_OR_UNVERIFIED_CASH"]
  ])("holds unsafe snapshot %j", (change, reason) => {
    expect(evaluateTreasury({ ...input, exactApprovalValid: true, snapshot: { ...input.snapshot, ...change } }).reasons).toContain(reason);
  });
  it("rejects duplicates and holds missing evidence even with approval", () => {
    expect(evaluateTreasury({ ...input, duplicateOrSettled: true }).action).toBe("REJECT");
    expect(evaluateTreasury({ ...input, verification: "HOLD", exactApprovalValid: true }).action).toBe("HOLD");
    expect(evaluateTreasury({ ...input, screening: "STALE" }).action).toBe("HOLD");
    expect(evaluateTreasury({ ...input, screening: "DENIED" }).action).toBe("REJECT");
  });
  it("holds malformed money instead of throwing during boundary validation", () => {
    expect(evaluateTreasury({ ...input, policy: { ...input.policy, autoPayMaxMicroUsdc: "1.2" } }).action).toBe("HOLD");
    expect(verifyObligation(invoice, vendor, { ...po, outstandingMicroUsdc: "not-money" }).status).toBe("HOLD");
  });
  it("keeps old active budget holds at UTC day and month rollover", () => {
    expect(evaluateTreasury({ ...input, now: "2026-11-01T00:00:01.000Z",
      snapshot: { ...input.snapshot, capturedAt: "2026-11-01T00:00:00.000Z", dailySettledMicroUsdc: "0", dailyHoldsMicroUsdc: "9000000" }
    }).reasons).toContain("DAILY_BUDGET");
  });
  it("permits exact boundaries including fees and the 30-second freshness limit", () => {
    expect(evaluateTreasury({ ...input, snapshot: { ...input.snapshot,
      cashMicroUsdc: "6510000", capturedAt: "2026-10-08T11:59:30.000Z"
    } }).action).toBe("PAY_NOW");
  });
  it("refuses invented candidates, terms, unsupported evidence and assumptions", () => {
    const { candidates } = evaluateTreasury(input);
    const proposal = { candidateId: "due-date", reason: "Due and within policy", evidenceIds: ["verified-obligation", "treasury-snapshot", "policy"], assumptions: [], alternativeConsidered: "Preserve cash" };
    expect(validatePlannerProposal(proposal, candidates)?.action).toBe("PAY_NOW");
    for (const change of [{ candidateId: "send-anywhere" }, { recipient: address }, { evidenceIds: ["invented"] }, { assumptions: ["Assume delivery"] }]) {
      expect(validatePlannerProposal({ ...proposal, ...change }, candidates)).toBeNull();
    }
    expect(validatePlannerProposal(null, candidates)).toBeNull();
  });
});

describe("exact approval terms", () => {
  const terms = { businessId: "business", obligationId: "invoice", decisionId: "decision", walletId: "wallet",
    obligationVersion: 1, vendorId: "vendor", vendorAddressVersion: 1,
    purchaseOrderId: "po-1", purchaseOrderVersion: 1, policyVersion: 1,
    recipient: address, amountMicroUsdc: "3500000", chainId: ARC_CHAIN_ID, token: ARC_USDC_ADDRESS };
  const approval = { id: "approval", terms, actorId: "owner", role: "OPERATOR", granted: true, reason: "Approved exception",
    grantedAt: "2026-10-08T11:00:00.000Z", expiresAt: "2026-10-09T11:00:00.000Z", consumedAt: null };
  it("accepts only a current unconsumed operator grant", () => {
    expect(isExactApprovalValid(approval, terms, input.now)).toBe(true);
    for (const change of [{ role: "REVIEWER" }, { granted: false }, { consumedAt: input.now },
      { grantedAt: "2026-10-08T13:00:00.000Z" }, { expiresAt: input.now }, { expiresAt: "2026-10-10T11:00:00.000Z" }]) {
      expect(isExactApprovalValid({ ...approval, ...change }, terms, input.now)).toBe(false);
    }
  });
  it("invalidates on every bound identity, amount, network and version change", () => {
    for (const [key, value] of Object.entries(terms)) {
      const changed = typeof value === "number" ? value + 1 : `${value}-changed`;
      expect(isExactApprovalValid(approval, { ...terms, [key]: changed }, input.now), key).toBe(false);
    }
  });
});
