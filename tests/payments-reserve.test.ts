import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { reservationFingerprint, reservePayment } from "../apps/server/src/payments/reserve.js";

const connect = vi.fn();
const pool = { connect } as unknown as Pool;
const validRequest = {
  businessId: "business", obligationId: "00000000-0000-4000-8000-000000000001",
  decisionId: "00000000-0000-4000-8000-000000000002", actorId: "operator",
  feeAllowanceMicroUsdc: "21", now: "2026-10-11T08:00:00.000Z",
  evidence: { cashBlockHash: `0x${"a".repeat(64)}`, capturedAt: "2026-10-11T07:59:45.000Z",
    ledgerFingerprint: "a".repeat(64), feeEvidenceReference: "fee:synthetic" }
};

describe("payment reservation boundary", () => {
  it("rejects malformed requests before opening a database transaction", async () => {
    await expect(reservePayment(pool, { ...validRequest, feeAllowanceMicroUsdc: "0.1" })).rejects.toMatchObject({ code: "RESERVATION_INVALID_REQUEST" });
    expect(connect).not.toHaveBeenCalled();
  });
  it("rejects stale accounting evidence before locking treasury", async () => {
    await expect(reservePayment(pool, { ...validRequest, evidence: { ...validRequest.evidence, capturedAt: "2026-10-11T07:59:00.000Z" } })).rejects.toMatchObject({ code: "RESERVATION_STALE_EVIDENCE" });
    expect(connect).not.toHaveBeenCalled();
  });
  it("creates a stable fingerprint from exact immutable terms", () => {
    const terms = { amountMicroUsdc: "1500000", recipient: `0x${"b".repeat(40)}`, chainId: 5042002 };
    expect(reservationFingerprint(terms)).toBe(reservationFingerprint({ ...terms }));
    expect(reservationFingerprint(terms)).toMatch(/^[a-f0-9]{64}$/);
    expect(reservationFingerprint({ ...terms, amountMicroUsdc: "1500001" })).not.toBe(reservationFingerprint(terms));
  });
});