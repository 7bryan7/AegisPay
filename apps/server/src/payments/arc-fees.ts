import { createHash } from "node:crypto";
import { createPublicClient, erc20Abi, http, type PublicClient } from "viem";
import { z } from "zod";
import { cashEvidenceSchema, feeEvidenceSchema, feeAllowanceFromEvidence } from "@agentpay/core";
import { arcReaderConfigSchema, type ArcReaderConfig } from "./arc.js";

const requestSchema = z.strictObject({ cash: cashEvidenceSchema,
  ...feeEvidenceSchema.pick({ recipient: true, amountMicroUsdc: true }).shape });
const bufferSchema = feeEvidenceSchema.pick({ bufferBps: true, extraBufferMicroUsdc: true });
const uint256 = z.bigint().nonnegative().max(2n ** 256n - 1n);
type FeeClient = Pick<PublicClient, "getChainId" | "getBlock" | "readContract" | "estimateContractGas" | "estimateFeesPerGas">;
export type ArcFeeRequest = z.input<typeof requestSchema>;
export type ArcFeeBuffer = z.input<typeof bufferSchema>;
export class ArcFeeError extends Error {
  constructor(readonly code: "ARC_FEE_UNAVAILABLE" | "ARC_FEE_TERMS_MISMATCH" | "ARC_FEE_STALE_EVIDENCE"
    | "ARC_FEE_NETWORK_MISMATCH" | "ARC_FEE_BLOCK_MISMATCH" | "ARC_FEE_TOKEN_DECIMALS") { super(code); }
}

/** Trusted server callers only: recipient/amount must come from the verified registry/obligation.
 * Estimates only an EOA ERC-20 transfer. This is not a Circle quote, fee guarantee, or dispatch
 * authorization. The eventual sender must match this path and enforce the reserved fee ceiling.
 */
export function createArcFeeReader(rawConfig: ArcReaderConfig, rawBuffer: ArcFeeBuffer,
  client?: FeeClient, clock: () => Date = () => new Date()) {
  const config = arcReaderConfigSchema.parse(rawConfig), buffer = bufferSchema.parse(rawBuffer);
  const rpc = client ?? createPublicClient({ transport: http(config.rpcUrl,
    { timeout: 8000, retryCount: 0, fetchOptions: { redirect: "error" } }) });
  return {
    async estimate(raw: ArcFeeRequest): Promise<{ evidence: z.infer<typeof feeEvidenceSchema>; allowanceMicroUsdc: string }> {
      try {
        const parsed = requestSchema.safeParse(raw);
        if (!parsed.success) throw new ArcFeeError("ARC_FEE_TERMS_MISMATCH");
        // Parsing copies inputs so callers cannot change terms while an RPC request is in flight.
        const { cash, recipient, amountMicroUsdc } = parsed.data;
        if (cash.chainId !== config.chainId || cash.tokenAddress !== config.tokenAddress
          || cash.walletAddress !== config.walletAddress || recipient === config.walletAddress) {
          throw new ArcFeeError("ARC_FEE_TERMS_MISMATCH");
        }
        const startedAt = clock().toISOString();
        const fresh = () => {
          const now = clock().getTime();
          if (cash.capturedAt !== cash.blockTimestamp || Date.parse(cash.observedAt) < Date.parse(cash.capturedAt)
            || [cash.capturedAt, cash.observedAt, startedAt].some((value) => {
              const age = now - Date.parse(value); return !Number.isFinite(age) || age < 0 || age > 30_000;
            })) throw new ArcFeeError("ARC_FEE_STALE_EVIDENCE");
        };
        const blockNumber = BigInt(cash.blockNumber);
        const checkBlock = async () => {
          const block = await rpc.getBlock({ blockNumber });
          if (block.number !== blockNumber || block.hash?.toLowerCase() !== cash.blockHash
            || block.timestamp * 1000n !== BigInt(Date.parse(cash.blockTimestamp))) {
            throw new ArcFeeError("ARC_FEE_BLOCK_MISMATCH");
          }
        };
        fresh();
        if (await rpc.getChainId() !== config.chainId) throw new ArcFeeError("ARC_FEE_NETWORK_MISMATCH");
        await checkBlock();
        if (await rpc.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: "decimals", blockNumber }) !== 6) {
          throw new ArcFeeError("ARC_FEE_TOKEN_DECIMALS");
        }
        // The fee market estimate is current; gas simulation is pinned to the cash block.
        const fees = await rpc.estimateFeesPerGas({ type: "eip1559", chain: null });
        const maxFeePerGas = uint256.positive().parse(fees.maxFeePerGas);
        const maxPriorityFeePerGas = uint256.parse(fees.maxPriorityFeePerGas);
        if (maxPriorityFeePerGas > maxFeePerGas) throw new ArcFeeError("ARC_FEE_UNAVAILABLE");
        const gasLimit = uint256.positive().parse(await rpc.estimateContractGas({
          address: config.tokenAddress, abi: erc20Abi, functionName: "transfer",
          args: [recipient as `0x${string}`, BigInt(amountMicroUsdc)], account: config.walletAddress as `0x${string}`,
          blockNumber, maxFeePerGas, maxPriorityFeePerGas
        }));
        await checkBlock();
        if (await rpc.getChainId() !== config.chainId) throw new ArcFeeError("ARC_FEE_NETWORK_MISMATCH");
        fresh();
        const terms = { chainId: config.chainId, tokenAddress: config.tokenAddress, walletAddress: config.walletAddress,
          recipient, amountMicroUsdc, cashBlockHash: cash.blockHash, capturedAt: startedAt,
          gasLimit: gasLimit.toString(), maxFeePerGasNative: maxFeePerGas.toString(), ...buffer };
        const evidence = feeEvidenceSchema.parse({ ...terms,
          evidenceReference: `arc-erc20-estimate:${createHash("sha256").update(JSON.stringify(terms)).digest("hex")}` });
        return { evidence, allowanceMicroUsdc: feeAllowanceFromEvidence(evidence) };
      } catch (error) {
        if (error instanceof ArcFeeError) throw error;
        throw new ArcFeeError("ARC_FEE_UNAVAILABLE"); // Provider errors can contain private URLs or payloads.
      }
    }
  };
}
