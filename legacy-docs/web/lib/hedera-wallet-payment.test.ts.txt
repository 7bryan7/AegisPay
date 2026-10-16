import { decodePaymentSignatureHeader } from "@x402/core/http";
import { getNetForAccount, inspectHederaTransaction } from "@x402/hedera";
import { AccountId, PrivateKey, type Transaction, type TransferTransaction } from "@hiero-ledger/sdk";
import { describe, expect, it, vi } from "vitest";
import { createHederaWalletPaymentSignature } from "./hedera-wallet-payment";

const paymentRequired = {
  x402Version: 2,
  resource: { url: "https://provider.example/providers/alpha/extract" },
  accepts: [{
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.0",
    amount: "1000000",
    payTo: "0.0.2001",
    maxTimeoutSeconds: 60,
    extra: { paymentFlow: "upfront", feePayer: "0.0.7162784" }
  }]
};

describe("Hedera browser-wallet payment", () => {
  it("creates one x402 header around a payer-signed native HBAR transfer", async () => {
    const key = PrivateKey.generateECDSA();
    const signTransaction = vi.fn(async (transaction: TransferTransaction): Promise<Transaction> => {
      transaction.setNodeAccountIds([AccountId.fromString("0.0.3")]);
      transaction.freeze();
      return await transaction.sign(key);
    });

    const header = await createHederaWalletPaymentSignature(paymentRequired, "0.0.1001", signTransaction);
    const payload = decodePaymentSignatureHeader(header);
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toMatchObject(paymentRequired.accepts[0]!);
    expect(signTransaction).toHaveBeenCalledOnce();

    const transaction = payload.payload.transaction;
    expect(typeof transaction).toBe("string");
    const inspected = inspectHederaTransaction(transaction as string);
    expect(inspected.transactionIdAccountId).toBe("0.0.7162784");
    expect(getNetForAccount(inspected.hbarTransfers, "0.0.1001")).toBe(-1_000_000n);
    expect(getNetForAccount(inspected.hbarTransfers, "0.0.2001")).toBe(1_000_000n);
    expect(inspected.hasNonTransferOperations).toBe(false);
  });

  it.each([
    ["mainnet", { network: "hedera:mainnet" }],
    ["non-HBAR asset", { asset: "0.0.429274" }],
    ["non-upfront flow", { extra: { paymentFlow: "after", feePayer: "0.0.7162784" } }],
    ["zero amount", { amount: "0" }]
  ])("rejects %s terms before asking the wallet to sign", async (_label, changed) => {
    const signTransaction = vi.fn();
    const invalid = {
      ...paymentRequired,
      accepts: [{ ...paymentRequired.accepts[0], ...changed }]
    };
    await expect(createHederaWalletPaymentSignature(invalid, "0.0.1001", signTransaction)).rejects.toThrow();
    expect(signTransaction).not.toHaveBeenCalled();
  });
});
