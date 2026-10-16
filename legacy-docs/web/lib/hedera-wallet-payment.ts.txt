import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { validatePaymentRequired } from "@x402/core/schemas";
import type { PaymentRequired } from "@x402/core/types";
import type { ClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import {
  AccountId,
  Hbar,
  TransactionId,
  TransferTransaction,
  type Transaction
} from "@hiero-ledger/sdk";
import { transactionToBase64String } from "@hashgraph/hedera-wallet-connect";

const HEDERA_TESTNET = "hedera:testnet";
const HBAR_ASSET = "0.0.0";
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export type WalletTransactionSigner = (transaction: TransferTransaction) => Promise<Transaction>;

function requiredHbarTerms(paymentRequired: unknown) {
  const parsed = validatePaymentRequired(paymentRequired);
  if (parsed.x402Version !== 2) throw new Error("AgentPay requires an x402 v2 payment request.");
  if (parsed.accepts.length !== 1) throw new Error("AgentPay requires exactly one payment option.");

  const requirements = parsed.accepts[0]!;
  if (requirements.scheme !== "exact") throw new Error("The payment scheme must be exact.");
  if (requirements.network !== HEDERA_TESTNET) throw new Error("The wallet may sign Hedera Testnet payments only.");
  if (requirements.asset !== HBAR_ASSET) throw new Error("The wallet may sign native HBAR payments only.");
  if (!POSITIVE_INTEGER.test(requirements.amount)) throw new Error("The payment amount must be a positive tinybar integer.");
  if (requirements.extra?.paymentFlow !== "upfront") throw new Error("The payment must use the upfront settlement flow.");

  AccountId.fromString(requirements.payTo);
  const feePayer = requirements.extra?.feePayer;
  if (typeof feePayer !== "string") throw new Error("The Blocky402 fee payer is missing.");
  AccountId.fromString(feePayer);

  return { parsed: parsed as PaymentRequired, requirements, feePayer };
}

export async function createHederaWalletPaymentSignature(
  paymentRequired: unknown,
  payerAccountId: string,
  signTransaction: WalletTransactionSigner
): Promise<string> {
  const payer = AccountId.fromString(payerAccountId).toString();
  const { parsed, requirements, feePayer } = requiredHbarTerms(paymentRequired);
  const amount = BigInt(requirements.amount);

  const signer: ClientHederaSigner = {
    accountId: payer,
    createPartiallySignedTransferTransaction: async () => {
      const transaction = new TransferTransaction()
        .addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()))
        .addHbarTransfer(requirements.payTo, Hbar.fromTinybars(amount.toString()))
        .setTransactionId(TransactionId.generate(feePayer));
      const signed = await signTransaction(transaction);
      return transactionToBase64String(signed);
    }
  };

  const client = new x402Client()
    .register(HEDERA_TESTNET, new ExactHederaScheme(signer))
    .setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{ network: HEDERA_TESTNET, asset: HBAR_ASSET, maxAmountPerPayment: requirements.amount }]
    })
    .registerPolicy((_version, candidates) => candidates.filter((candidate) => (
      candidate.scheme === requirements.scheme
      && candidate.network === requirements.network
      && candidate.asset === requirements.asset
      && candidate.amount === requirements.amount
      && candidate.payTo === requirements.payTo
      && candidate.extra?.feePayer === feePayer
      && candidate.extra?.paymentFlow === "upfront"
    )));

  const payload = await client.createPaymentPayload(parsed);
  return encodePaymentSignatureHeader(payload);
}
