import { describe, expect, it, vi } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@agentpay/core";
import { createCircleTransferAdapter, type CircleAdapterConfig, type CircleExpectedTerms, type CircleTransferClient } from "../apps/server/src/payments/circle.js";
import { createCircleAdapterFromEnvironment, dispatchNextPayment } from "../apps/server/src/payments/dispatch.js";
import { reconcileNextPayment } from "../apps/server/src/payments/reconcile.js";
import type { Pool } from "pg";
import { reservationFingerprint } from "../apps/server/src/payments/reserve.js";

const walletId = "00000000-0000-4000-8000-000000000001";
const providerId = "00000000-0000-4000-8000-000000000002";
const tokenId = "00000000-0000-4000-8000-000000000003";
const walletAddress = "0x" + "1".repeat(40), recipient = "0x" + "2".repeat(40);
const config: CircleAdapterConfig = { mode: "arc_testnet", blockchain: "ARC-TESTNET", apiKey: "synthetic-key",
  entitySecret: "a".repeat(64), walletId, walletAddress };
const terms: CircleExpectedTerms = { walletId, recipient, amountMicroUsdc: "9007199254740993", chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS };
const request = { ...terms, providerIdempotencyKey: providerId, feeAllowanceMicroUsdc: "22",
  fee: { gasLimit: "21000", maxFeePerGasNative: "1000000001", maxPriorityFeePerGasNative: "100000000" } };
function fixture() {
  const wallet = { id: walletId, address: walletAddress, blockchain: "ARC-TESTNET", accountType: "EOA", custodyType: "DEVELOPER", state: "LIVE" };
  const transaction = { id: providerId, walletId, blockchain: "ARC-TESTNET", sourceAddress: walletAddress, destinationAddress: recipient,
    amounts: ["9007199254.740993"], tokenId, state: "COMPLETE", transactionType: "OUTBOUND", operation: "TRANSFER",
    txHash: "0x" + "a".repeat(64), createDate: "2026-10-13T00:00:00Z", updateDate: "2026-10-13T00:00:01Z",
    networkFee: "0.000022", errorDetails: "private-provider-detail" };
  const token = { id: tokenId, tokenAddress: ARC_USDC_ADDRESS as string, blockchain: "ARC-TESTNET", decimals: 6, isNative: false };
  const client = {
    createTransaction: vi.fn<CircleTransferClient["createTransaction"]>(() => Promise.resolve({ data: { id: providerId, state: "INITIATED", createDate: "2026-10-13T00:00:00Z" } })),
    getWallet: vi.fn(() => Promise.resolve({ data: { wallet } })),
    getTransaction: vi.fn(() => Promise.resolve({ data: { transaction } })),
    getToken: vi.fn(() => Promise.resolve({ data: { token } }))
  } satisfies CircleTransferClient;
  return { client, wallet, token, transaction, adapter: createCircleTransferAdapter(config, client) };
}
describe("Circle transfer adapter", () => {
  it("preserves exact money/key and caps fees using decimal gwei", async () => {
    const f = fixture();
    expect(await f.adapter.submit(request)).toEqual({ providerId, providerState: "INITIATED" });
    expect(f.client.createTransaction).toHaveBeenCalledExactlyOnceWith({ walletId, tokenAddress: ARC_USDC_ADDRESS,
      amount: ["9007199254.740993"], destinationAddress: recipient, idempotencyKey: providerId,
      fee: { type: "absolute", config: { gasLimit: "21000", maxFee: "1.000000001", priorityFee: "0.100000000" } } });
    expect(f.client.getWallet).toHaveBeenCalledExactlyOnceWith({ id: walletId });
  });
  it.each([{ amountMicroUsdc: "0" }, { walletId: providerId }, { chainId: 1 }, { recipient: walletAddress },
    { recipient: ARC_USDC_ADDRESS }, { tokenAddress: recipient }, { providerIdempotencyKey: "bad" }, { fee: undefined }])(
    "refuses invalid terms before any network call: %j", async (change) => {
      const f = fixture();
      await expect(f.adapter.submit({ ...request, ...change })).rejects.toMatchObject({ code: "CIRCLE_TERMS_MISMATCH" });
      expect(f.client.getWallet).not.toHaveBeenCalled(); expect(f.client.createTransaction).not.toHaveBeenCalled();
    });
  it("rounds worst-case fees up and rejects tips above the cap", async () => {
    const f = fixture();
    await expect(f.adapter.submit({ ...request, feeAllowanceMicroUsdc: "21" })).rejects.toMatchObject({ code: "CIRCLE_FEE_LIMIT" });
    await expect(f.adapter.submit({ ...request, fee: { ...request.fee, maxPriorityFeePerGasNative: "1000000002" } }))
      .rejects.toMatchObject({ code: "CIRCLE_FEE_LIMIT" });
    expect(f.client.createTransaction).not.toHaveBeenCalled();
  });
  it.each([{ blockchain: "ETH" }, { address: recipient }, { id: providerId }, { accountType: "SCA" }, { custodyType: "ENDUSER" }, { state: "FROZEN" }])(
    "verifies the configured live developer EOA wallet: %j", async (change) => {
      const f = fixture(); Object.assign(f.wallet, change);
      await expect(f.adapter.submit(request)).rejects.toMatchObject({ code: "CIRCLE_WALLET_MISMATCH" });
      expect(f.client.createTransaction).not.toHaveBeenCalled();
    });
  it("redacts failures and never retries uncertain submissions", async () => {
    const f = fixture(); f.client.createTransaction.mockRejectedValue(new Error("private-url-key"));
    await expect(f.adapter.submit(request)).rejects.toMatchObject({ code: "CIRCLE_UNAVAILABLE", message: "CIRCLE_UNAVAILABLE" });
    expect(f.client.createTransaction).toHaveBeenCalledTimes(1);
  });
  it("copies money and fees before awaiting wallet verification", async () => {
    const f = fixture(), mutable = structuredClone(request);
    f.client.getWallet.mockImplementation(() => { mutable.amountMicroUsdc = "1"; mutable.fee.gasLimit = "1"; return Promise.resolve({ data: { wallet: f.wallet } }); });
    await f.adapter.submit(mutable);
    expect(f.client.createTransaction.mock.calls[0]?.[0]).toMatchObject({ amount: ["9007199254.740993"], fee: { config: { gasLimit: "21000" } } });
  });
  it("accepts realistic full responses but returns no raw provider details", async () => {
    const f = fixture();
    expect(await f.adapter.getStatus(providerId, terms)).toEqual({ providerId, providerState: "COMPLETE", transactionHash: f.transaction.txHash, errorReason: null });
  });
  it.each([{ id: tokenId }, { destinationAddress: walletAddress }, { sourceAddress: recipient }, { walletId: tokenId },
    { amounts: ["9007199254.740994"] }, { blockchain: "ETH" }, { operation: "CONTRACT_EXECUTION" }])(
    "refuses mismatched provider transaction: %j", async (change) => {
      const f = fixture(); Object.assign(f.transaction, change);
      await expect(f.adapter.getStatus(providerId, terms)).rejects.toThrow();
    });
  it("requires token identity and a hash for COMPLETE; STUCK stays observable", async () => {
    const f = fixture(); f.token.decimals = 18;
    await expect(f.adapter.getStatus(providerId, terms)).rejects.toMatchObject({ code: "CIRCLE_TERMS_MISMATCH" });
    f.token.decimals = 6; Reflect.deleteProperty(f.transaction, "txHash");
    await expect(f.adapter.getStatus(providerId, terms)).rejects.toMatchObject({ code: "CIRCLE_INVALID_RESPONSE" });
    f.transaction.state = "STUCK";
    expect(await f.adapter.getStatus(providerId, terms)).toMatchObject({ providerState: "STUCK", transactionHash: null });
  });
  it("refuses fixture/disabled mode even with credentials and prevents claims by the live dispatcher", async () => {
    for (const mode of ["fixture", "disabled"]) {
      expect(() => createCircleTransferAdapter({ ...config, mode } as CircleAdapterConfig, fixture().client)).toThrow();
      expect(createCircleAdapterFromEnvironment({ PAYMENT_MODE: mode, CIRCLE_API_KEY: "key", CIRCLE_ENTITY_SECRET: config.entitySecret, CIRCLE_WALLET_ID: walletId })).toBeNull();
    }
    const pool = { connect: vi.fn(), query: vi.fn() };
    expect(await dispatchNextPayment(pool as unknown as Pool, fixture().adapter, "business")).toEqual({ status: "DISABLED" });
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it.each(["STUCK", "FAILED", "CANCELLED", "DENIED"])("retains holds during %s reconciliation", async (providerState) => {
    const storedTerms={businessId:"business",obligationId:walletId,decisionId:providerId,walletId,obligationVersion:1,vendorId:"vendor",
      vendorAddressVersion:1,purchaseOrderId:"po",purchaseOrderVersion:1,policyVersion:1,recipient,amountMicroUsdc:terms.amountMicroUsdc,
      chainId:ARC_CHAIN_ID,token:ARC_USDC_ADDRESS,walletAddress,feeAllowanceMicroUsdc:request.feeAllowanceMicroUsdc,fee:request.fee,evidence:{}};
    const query = vi.fn((sql: string) => { void sql; return Promise.resolve({ rows: [{ business_id: "business", id: "intent", obligation_id: walletId,
      provider_id: providerId, terms:storedTerms, request_fingerprint:reservationFingerprint(storedTerms),
      wallet_id: walletId, recipient, amount_micro_usdc: terms.amountMicroUsdc }] }); });
    const cashReader = { read: vi.fn() }, receiptReader = { verify: vi.fn() };
    const result = await reconcileNextPayment({ query } as unknown as Pool, { getStatus: () => Promise.resolve({
      providerId, providerState, transactionHash: null, errorReason: null }) }, cashReader, receiptReader, "business");
    expect(result.status).toBe("WAITING");
    expect(result).toMatchObject({reason:providerState==="STUCK"?"PROVIDER_PENDING":"FAILURE_EVIDENCE_REQUIRED"});
    expect(query.mock.calls.some((call) => /RELEASED|state = 'FAILED'/.test(String(call[0])))).toBe(false);
    expect(cashReader.read).not.toHaveBeenCalled();
  });
  it("bounds an uncertain SDK submission without retry",async()=>{
    vi.useFakeTimers();
    try {
      const f=fixture();f.client.createTransaction.mockImplementation(()=>new Promise(()=>{}));
      const pending=expect(f.adapter.submit(request)).rejects.toMatchObject({code:"CIRCLE_UNAVAILABLE"});
      await vi.advanceTimersByTimeAsync(15001);await pending;
      expect(f.client.createTransaction).toHaveBeenCalledTimes(1);
    } finally {vi.useRealTimers();}
  });
});
