import {randomUUID} from "node:crypto";
import * as circleSdk from "@circle-fin/developer-controlled-wallets";
import type { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { z } from "zod";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, arcAddressSchema, microUsdcToUsdc, microUsdcStringSchema, usdcToMicroUsdc, paymentSubmissionIssueSchema, type PaymentSubmissionIssue } from "@agentpay/core";

const initiate = circleSdk.initiateDeveloperControlledWalletsClient
  ?? (circleSdk as { default?: { initiateDeveloperControlledWalletsClient?: typeof circleSdk.initiateDeveloperControlledWalletsClient } }).default?.initiateDeveloperControlledWalletsClient;
const uuid = z.uuid();
const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine((v) => BigInt(v) < 2n ** 256n);
const positive = uint.refine((v) => v !== "0");
const state = z.enum(["INITIATED", "QUEUED", "CLEARED", "SENT", "STUCK", "CONFIRMED", "COMPLETE", "FAILED", "CANCELLED", "DENIED"]);
const termsSchema = z.strictObject({ walletId: uuid, recipient: arcAddressSchema,
  amountMicroUsdc: microUsdcStringSchema.refine((v) => v !== "0"), chainId: z.literal(ARC_CHAIN_ID), tokenAddress: z.literal(ARC_USDC_ADDRESS) });
const requestSchema = termsSchema.extend({ providerIdempotencyKey: z.uuidv4(), feeAllowanceMicroUsdc: microUsdcStringSchema, providerRequestId: z.uuid().optional(),
  fee: z.strictObject({ gasLimit: positive, maxFeePerGasNative: positive, maxPriorityFeePerGasNative: uint }) });
const configSchema = z.strictObject({ mode: z.literal("arc_testnet"), apiKey: z.string().trim().min(1),
  entitySecret: z.string().regex(/^[a-fA-F0-9]{64}$/), walletId: uuid, walletAddress: arcAddressSchema,
  blockchain: z.literal("ARC-TESTNET") });
// Provider responses can contain extra documented fields; only validated fields leave this adapter.
const responseSchema = z.object({ id: uuid, state });
const statusSchema = responseSchema.extend({ walletId: uuid, blockchain: z.literal("ARC-TESTNET"),
  sourceAddress: arcAddressSchema, destinationAddress: arcAddressSchema, amounts: z.array(z.string()).length(1),
  tokenId: uuid, transactionType: z.literal("OUTBOUND"), operation: z.literal("TRANSFER"),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v.toLowerCase()).optional() });
export type CircleTransferRequest = z.infer<typeof requestSchema>;
export type CircleExpectedTerms = z.infer<typeof termsSchema>;
export type CircleAdapterConfig = z.infer<typeof configSchema>;
export type CircleTransferResult = { providerId: string; providerState: string };
export type CircleTransactionStatus = { providerId: string; providerState: string; transactionHash: string | null; errorReason: string | null };
export type CircleTransferClient = {
  createTransaction: (input: Parameters<CircleDeveloperControlledWalletsClient["createTransaction"]>[0]) => Promise<{ data?: unknown }>;
  getTransaction: (input: { id: string }) => Promise<{ data?: unknown }>;
  getWallet: (input: { id: string }) => Promise<{ data?: unknown }>;
  getToken: (input: { id: string }) => Promise<{ data?: unknown }>;
};
export class CircleTransferError extends Error {
  constructor(readonly code: "CIRCLE_NOT_CONFIGURED" | "CIRCLE_INVALID_RESPONSE" | "CIRCLE_UNAVAILABLE"
    | "CIRCLE_TERMS_MISMATCH" | "CIRCLE_WALLET_MISMATCH" | "CIRCLE_FEE_LIMIT", readonly submissionIssue?: PaymentSubmissionIssue) {
    super(code); this.name = "CircleTransferError";
  }
}
/** Never retain SDK messages/URLs/request bodies/ciphertexts. Only documented numeric codes/status and our correlation UUID. */
function submissionError(error:unknown,stage:PaymentSubmissionIssue["stage"],requestId:string):CircleTransferError {
 const record=error!==null&&typeof error==='object'?error as Record<string,unknown>:{};
 const response=record.response!==null&&typeof record.response==='object'?record.response as Record<string,unknown>:{};
 const status=record.status??response.status;
 const data=response.data!==null&&typeof response.data==='object'?response.data as Record<string,unknown>:{};
 const candidate=record.code??data.code;
 const providerCode=(typeof candidate==='number'&&Number.isSafeInteger(candidate)||typeof candidate==='string')&&/^[0-9]{1,9}$/.test(String(candidate))?String(candidate):null;
 const code=error instanceof CircleTransferError?error.code:'CIRCLE_UNAVAILABLE';
 const issue=paymentSubmissionIssueSchema.parse({code,stage,requestId,providerCode,
  httpStatus:typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?status:null});
 return new CircleTransferError(code,issue);
}
const gwei = (v: string) => (BigInt(v) / 1_000_000_000n).toString() + "." + (BigInt(v) % 1_000_000_000n).toString().padStart(9, "0");
// Bound worker waiting. A timeout cannot prove cancellation of the provider request.
// The dispatcher retains UNKNOWN and never retries even if the SDK completes later.
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CircleTransferError("CIRCLE_UNAVAILABLE")), 15000);
  })]); } finally { clearTimeout(timer); }
}

/** Trusted persistence callers only. No retry, acceleration, cancellation or key generation.
 * The worker must persist exact terms/fees and SUBMITTING, and revalidate under treasury locks.
 */
export function createCircleTransferAdapter(rawConfig: CircleAdapterConfig, injectedClient?: CircleTransferClient) {
  const parsed = configSchema.safeParse(rawConfig);
  if (!parsed.success || (!injectedClient && !initiate)) throw new CircleTransferError("CIRCLE_NOT_CONFIGURED");
  const config = parsed.data;
  const client = injectedClient ?? initiate({ apiKey: config.apiKey, entitySecret: config.entitySecret, baseUrl: "https://api.circle.com" });
  const validateTerms = (raw: unknown) => {
    const value = termsSchema.safeParse(raw);
    if (!value.success || value.data.walletId !== config.walletId || value.data.recipient === config.walletAddress
      || value.data.recipient === ARC_USDC_ADDRESS) throw new CircleTransferError("CIRCLE_TERMS_MISMATCH");
    return value.data;
  };
  const verifyWallet = async () => {
    const result = await bounded(client.getWallet({ id: config.walletId }));
    const wallet = z.object({ wallet: z.object({ id: uuid, address: arcAddressSchema, blockchain: z.literal("ARC-TESTNET"),
      accountType: z.literal("EOA"), custodyType: z.literal("DEVELOPER"), state: z.literal("LIVE") }) }).safeParse(result.data);
    if (!wallet.success || wallet.data.wallet.id !== config.walletId || wallet.data.wallet.address !== config.walletAddress) {
      throw new CircleTransferError("CIRCLE_WALLET_MISMATCH");
    }
  };
  return {
    // The environment factory enables this only through an explicit operator setting.
    dispatchEnabled: false as const,
    async checkWallet(): Promise<void> {
      try { await verifyWallet(); } catch (error) {
        if (error instanceof CircleTransferError) throw error;
        throw new CircleTransferError("CIRCLE_UNAVAILABLE");
      }
    },
    async submit(raw: unknown): Promise<CircleTransferResult> {
      const supplied=raw!==null&&typeof raw==='object'&&'providerRequestId' in raw?z.uuid().safeParse(raw.providerRequestId):null;
      const requestId=supplied?.success?supplied.data:randomUUID();
      let stage:PaymentSubmissionIssue["stage"]='VALIDATION';
      try {
        const request = requestSchema.safeParse(raw);
        if (!request.success) throw new CircleTransferError("CIRCLE_TERMS_MISMATCH");
        const r = request.data;
        validateTerms({ walletId: r.walletId, recipient: r.recipient, amountMicroUsdc: r.amountMicroUsdc, chainId: r.chainId, tokenAddress: r.tokenAddress });
        const worstFee = BigInt(r.fee.gasLimit) * BigInt(r.fee.maxFeePerGasNative);
        if (BigInt(r.fee.maxPriorityFeePerGasNative) > BigInt(r.fee.maxFeePerGasNative)
          || (worstFee + 999_999_999_999n) / 1_000_000_000_000n > BigInt(r.feeAllowanceMicroUsdc)) throw new CircleTransferError("CIRCLE_FEE_LIMIT");
        stage='WALLET_CHECK';
        await verifyWallet();
        stage='TRANSFER_REQUEST';
        const response = await bounded(client.createTransaction({ walletAddress: config.walletAddress, blockchain: config.blockchain, tokenAddress: r.tokenAddress, xRequestId:requestId,
          amount: [microUsdcToUsdc(BigInt(r.amountMicroUsdc))], destinationAddress: r.recipient, idempotencyKey: r.providerIdempotencyKey,
          fee: { type: "absolute", config: { gasLimit: r.fee.gasLimit,
            maxFee: gwei(r.fee.maxFeePerGasNative), priorityFee: gwei(r.fee.maxPriorityFeePerGasNative) } } }));
        stage='TRANSFER_RESPONSE';
        const result = responseSchema.safeParse(response.data);
        if (!result.success) throw new CircleTransferError("CIRCLE_INVALID_RESPONSE");
        return { providerId: result.data.id, providerState: result.data.state };
      } catch (error) {
        // Acceptance may precede a transport error. Diagnostics never authorize release or replay.
        throw submissionError(error,stage,requestId);
      }
    },
    async getStatus(providerId: string, expected?: CircleExpectedTerms): Promise<CircleTransactionStatus> {
      if (!uuid.safeParse(providerId).success || !expected) throw new CircleTransferError("CIRCLE_TERMS_MISMATCH");
      const terms = validateTerms(expected);
      try {
        const response = await bounded(client.getTransaction({ id: providerId }));
        const result = z.object({ transaction: statusSchema }).safeParse(response.data);
        if (!result.success) throw new CircleTransferError("CIRCLE_INVALID_RESPONSE");
        const tx = result.data.transaction;
        if (tx.id !== providerId || tx.walletId !== config.walletId || tx.sourceAddress !== config.walletAddress
          || tx.destinationAddress !== terms.recipient || usdcToMicroUsdc(tx.amounts[0]!).toString() !== terms.amountMicroUsdc) {
          throw new CircleTransferError("CIRCLE_TERMS_MISMATCH");
        }
        const token = z.object({ token: z.object({ id: uuid, tokenAddress: z.literal(ARC_USDC_ADDRESS),
          blockchain: z.literal("ARC-TESTNET"), decimals: z.literal(6), isNative: z.literal(false) }) })
          .safeParse((await bounded(client.getToken({ id: tx.tokenId }))).data);
        if (!token.success || token.data.token.id !== tx.tokenId) throw new CircleTransferError("CIRCLE_TERMS_MISMATCH");
        if (tx.state === "COMPLETE" && !tx.txHash) throw new CircleTransferError("CIRCLE_INVALID_RESPONSE");
        return { providerId: tx.id, providerState: tx.state, transactionHash: tx.txHash ?? null, errorReason: null };
      } catch (error) {
        if (error instanceof CircleTransferError) throw error;
        throw new CircleTransferError("CIRCLE_UNAVAILABLE");
      }
    }
  };
}
