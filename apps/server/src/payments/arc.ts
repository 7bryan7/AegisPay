import { createPublicClient, erc20Abi, http, type PublicClient } from "viem";
import { z } from "zod";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, arcAddressSchema, formatMicroUsdc } from "@agentpay/core";

export const arcReaderConfigSchema = z.strictObject({
  mode: z.literal("arc_testnet"), chainId: z.literal(ARC_CHAIN_ID),
  tokenAddress: z.literal(ARC_USDC_ADDRESS), walletAddress: arcAddressSchema,
  // Only a server-configured endpoint; no URL from an invoice/browser/model is accepted.
  rpcUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  }, "RPC must use HTTPS without embedded credentials or fragments")
});
export type ArcReaderConfig = z.input<typeof arcReaderConfigSchema>;
export type ArcCashEvidence = {
  chainId: typeof ARC_CHAIN_ID; tokenAddress: typeof ARC_USDC_ADDRESS; walletAddress: string;
  cashMicroUsdc: string; blockNumber: string; blockHash: string; blockTimestamp: string; capturedAt: string; observedAt: string;
};
type ReaderClient = Pick<PublicClient, "getChainId" | "getBlock" | "readContract">;
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export class ArcReadError extends Error {
  constructor(readonly code: "ARC_UNAVAILABLE" | "ARC_NETWORK_MISMATCH" | "ARC_TOKEN_DECIMALS" | "ARC_STALE_BLOCK" | "ARC_INCONSISTENT_BLOCK") {
    super(code);
  }
}

/** One six-decimal USDC balance at a pinned finalized block. Never signs or estimates a payment as settled. */
export function createArcCashReader(rawConfig: ArcReaderConfig, client?: ReaderClient, clock: () => Date = () => new Date()) {
  const config = arcReaderConfigSchema.parse(rawConfig);
  const rpc = client ?? createPublicClient({ transport: http(config.rpcUrl,
    { timeout: 8000, retryCount: 0, fetchOptions: { redirect: "error" } }) });
  return {
    async read(): Promise<ArcCashEvidence> {
      try {
        if (await rpc.getChainId() !== config.chainId) throw new ArcReadError("ARC_NETWORK_MISMATCH");
        const block = await rpc.getBlock({ blockTag: "finalized" });
        const number = z.bigint().nonnegative().parse(block.number);
        const hash = hashSchema.parse(block.hash).toLowerCase();
        const timestamp = z.bigint().nonnegative().max(BigInt(Number.MAX_SAFE_INTEGER)).parse(block.timestamp);
        const blockTime = Number(timestamp) * 1000;
        const fresh = () => {
          const age = clock().getTime() - blockTime;
          if (!Number.isFinite(age) || age < 0 || age > 30_000) throw new ArcReadError("ARC_STALE_BLOCK");
        };
        fresh();
        const decimals = await rpc.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: "decimals", blockNumber: number });
        if (decimals !== 6) throw new ArcReadError("ARC_TOKEN_DECIMALS");
        const balance = await rpc.readContract({ address: config.tokenAddress, abi: erc20Abi,
          functionName: "balanceOf", args: [config.walletAddress as `0x${string}`], blockNumber: number });
        const cashMicroUsdc = formatMicroUsdc(z.bigint().nonnegative().parse(balance));
        // Number-pinned reads must not be accepted if the canonical hash changed while reading.
        const check = await rpc.getBlock({ blockNumber: number });
        if (check.hash?.toLowerCase() !== hash || check.number !== number || check.timestamp !== timestamp) {
          throw new ArcReadError("ARC_INCONSISTENT_BLOCK");
        }
        if (await rpc.getChainId() !== config.chainId) throw new ArcReadError("ARC_NETWORK_MISMATCH");
        fresh();
        return { chainId: config.chainId, tokenAddress: config.tokenAddress, walletAddress: config.walletAddress,
          cashMicroUsdc, blockNumber: number.toString(), blockHash: hash,
          blockTimestamp: new Date(blockTime).toISOString(), capturedAt: new Date(blockTime).toISOString(), observedAt: clock().toISOString() };
      } catch (error) {
        if (error instanceof ArcReadError) throw error;
        // RPC errors may embed credential-bearing URLs or private provider responses.
        throw new ArcReadError("ARC_UNAVAILABLE");
      }
    }
  };
}
