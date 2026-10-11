import { describe, expect, it, vi } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@agentpay/core";
import { createCircleTransferAdapter } from "../apps/server/src/payments/circle.js";

const request = { walletId: "wallet", providerIdempotencyKey: "00000000-0000-4000-8000-000000000001",
  recipient: `0x${"2".repeat(40)}`, amountMicroUsdc: "1500000", chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS };

describe("Circle transfer adapter", () => {
  it("submits exact persisted terms with a stable idempotency key", async () => {
    const createTransaction = vi.fn(() => Promise.resolve({ data: { id: "00000000-0000-4000-8000-000000000002", state: "INITIATED" } }));
    const adapter = createCircleTransferAdapter({ apiKey: "key", entitySecret: "secret" }, { createTransaction });
    await expect(adapter.submit(request)).resolves.toEqual({ providerId: "00000000-0000-4000-8000-000000000002", providerState: "INITIATED" });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ walletId: "wallet",
      tokenAddress: ARC_USDC_ADDRESS, amount: ["1.500000"], destinationAddress: request.recipient,
      idempotencyKey: request.providerIdempotencyKey, fee: { type: "level", config: { feeLevel: "MEDIUM" } } }));
  });
  it("fails closed on malformed terms, unavailable providers, and invalid responses", async () => {
    const unavailable = createCircleTransferAdapter({ apiKey: "key", entitySecret: "secret" },
      { createTransaction: vi.fn(() => Promise.reject(new Error("private provider error"))) });
    await expect(unavailable.submit({ ...request, amountMicroUsdc: "0" })).rejects.toMatchObject({ code: "CIRCLE_NOT_CONFIGURED" });
    await expect(unavailable.submit(request)).rejects.toMatchObject({ code: "CIRCLE_UNAVAILABLE" });
    const invalid = createCircleTransferAdapter({ apiKey: "key", entitySecret: "secret" },
      { createTransaction: vi.fn(() => Promise.resolve({ data: { id: "bad", state: "" } })) });
    await expect(invalid.submit(request)).rejects.toMatchObject({ code: "CIRCLE_INVALID_RESPONSE" });
  });
  it("rejects a stored intent bound to a different configured wallet", async () => {
    const adapter = createCircleTransferAdapter({ apiKey: "key", entitySecret: "secret", walletId: "configured-wallet" },
      { createTransaction: vi.fn() });
    await expect(adapter.submit(request)).rejects.toMatchObject({ code: "CIRCLE_NOT_CONFIGURED" });
  });
  it("reads provider status without treating a hash as settlement", async () => {
    const adapter = createCircleTransferAdapter({ apiKey: "key", entitySecret: "secret" }, {
      createTransaction: vi.fn(() => Promise.resolve({ data: { id: request.providerIdempotencyKey, state: "INITIATED" } })),
      getTransaction: vi.fn(() => Promise.resolve({ data: { transaction: { id: request.providerIdempotencyKey, state: "COMPLETE", txHash: `0x${"a".repeat(64)}` } } }))
    });
    await expect(adapter.getStatus(request.providerIdempotencyKey)).resolves.toEqual({ providerId: request.providerIdempotencyKey,
      providerState: "COMPLETE", transactionHash: `0x${"a".repeat(64)}`, errorReason: null });
  });
});