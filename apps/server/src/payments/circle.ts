import * as circleSdk from "@circle-fin/developer-controlled-wallets";
import type { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { z } from "zod";

const initiateDeveloperControlledWalletsClient = circleSdk.initiateDeveloperControlledWalletsClient
  ?? (circleSdk as { default?: { initiateDeveloperControlledWalletsClient?: typeof circleSdk.initiateDeveloperControlledWalletsClient } }).default?.initiateDeveloperControlledWalletsClient;
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, arcAddressSchema, microUsdcToUsdc, microUsdcStringSchema } from "@agentpay/core";

const uuid = z.uuid();
const requestSchema = z.strictObject({
  walletId: z.string().trim().min(1).max(500),
  providerIdempotencyKey: uuid,
  recipient: arcAddressSchema,
  amountMicroUsdc: microUsdcStringSchema.refine((value) => value !== "0"),
  chainId: z.literal(ARC_CHAIN_ID),
  tokenAddress: z.literal(ARC_USDC_ADDRESS)
});
const responseDataSchema = z.strictObject({ id: uuid, state: z.string().trim().min(1).max(100) });
const transactionDataSchema = responseDataSchema.extend({ txHash: z.string().regex(/^0x[0-9a-f]{64}$/).optional() });
export type CircleTransferRequest = z.infer<typeof requestSchema>;
export type CircleTransferResult = { providerId: string; providerState: string };
export type CircleTransactionStatus = { providerId: string; providerState: string; transactionHash: string | null; errorReason: string | null };
export type CircleTransferClient = {
  createTransaction: (input: Parameters<CircleDeveloperControlledWalletsClient["createTransaction"]>[0]) => Promise<{ data?: unknown }>;
  getTransaction?: (input: Parameters<NonNullable<CircleDeveloperControlledWalletsClient["getTransaction"]>>[0]) => Promise<{ data?: unknown }>;
};

export class CircleTransferError extends Error {
  constructor(readonly code: "CIRCLE_NOT_CONFIGURED" | "CIRCLE_INVALID_RESPONSE" | "CIRCLE_UNAVAILABLE") {
    super(code);
    this.name = "CircleTransferError";
  }
}

export type CircleAdapterConfig = {
  apiKey: string;
  entitySecret: string;
  walletId?: string;
  blockchain?: "ARC-TESTNET";
};

/** Sends only the exact persisted intent terms. It does not choose recipients, amounts, or keys. */
export function createCircleTransferAdapter(rawConfig: CircleAdapterConfig, injectedClient?: CircleTransferClient) {
  const config = z.object({ apiKey: z.string().trim().min(1), entitySecret: z.string().trim().min(1), walletId: z.string().trim().min(1).optional(), blockchain: z.literal("ARC-TESTNET").default("ARC-TESTNET") }).safeParse(rawConfig);
  if (!config.success) throw new CircleTransferError("CIRCLE_NOT_CONFIGURED");
  if (!injectedClient && !initiateDeveloperControlledWalletsClient) throw new CircleTransferError("CIRCLE_NOT_CONFIGURED");
  const client = injectedClient ?? initiateDeveloperControlledWalletsClient({ apiKey: config.data.apiKey, entitySecret: config.data.entitySecret });
  return {
    async submit(rawRequest: unknown): Promise<CircleTransferResult> {
      const request = requestSchema.safeParse(rawRequest);
      if (!request.success) throw new CircleTransferError("CIRCLE_NOT_CONFIGURED");
      if (config.data.walletId && request.data.walletId !== config.data.walletId) throw new CircleTransferError("CIRCLE_NOT_CONFIGURED");
      try {
        const response = await client.createTransaction({
          walletId: request.data.walletId,
          tokenAddress: request.data.tokenAddress,
          amount: [microUsdcToUsdc(BigInt(request.data.amountMicroUsdc))],
          destinationAddress: request.data.recipient,
          idempotencyKey: request.data.providerIdempotencyKey,
          fee: { type: "level", config: { feeLevel: "MEDIUM" } }
        });
        const rawData = response.data;
        const parsed = responseDataSchema.safeParse(rawData);
        if (parsed.success) return { providerId: parsed.data.id, providerState: parsed.data.state };
        const nested = z.strictObject({ data: responseDataSchema }).safeParse(rawData);
        if (nested.success) return { providerId: nested.data.data.id, providerState: nested.data.data.state };
        throw new CircleTransferError("CIRCLE_INVALID_RESPONSE");
      } catch (error) {
        if (error instanceof CircleTransferError) throw error;
        throw new CircleTransferError("CIRCLE_UNAVAILABLE");
      }
    },
    async getStatus(providerId: string): Promise<CircleTransactionStatus> {
      if (!uuid.safeParse(providerId).success || !client.getTransaction) throw new CircleTransferError("CIRCLE_NOT_CONFIGURED");
      try {
        const response = await client.getTransaction({ id: providerId });
        const rawData = response.data;
        const direct = transactionDataSchema.safeParse(rawData);
        const nested = z.object({ transaction: transactionDataSchema }).safeParse(rawData);
        const transaction = direct.success ? direct.data : nested.success ? nested.data.transaction : null;
        if (!transaction) throw new CircleTransferError("CIRCLE_INVALID_RESPONSE");
        return { providerId: transaction.id, providerState: transaction.state,
          transactionHash: transaction.txHash ?? null, errorReason: null };
      } catch (error) {
        if (error instanceof CircleTransferError) throw error;
        throw new CircleTransferError("CIRCLE_UNAVAILABLE");
      }
    }
  };
}