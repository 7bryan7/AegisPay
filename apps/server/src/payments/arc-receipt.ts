import { createHash } from "node:crypto";
import { createPublicClient, decodeEventLog, encodeFunctionData, erc20Abi, http, type PublicClient } from "viem";
import { z } from "zod";
import { cashEvidenceSchema, feeEvidenceSchema, formatMicroUsdc } from "@agentpay/core";
import { arcReaderConfigSchema, type ArcReaderConfig } from "./arc.js";

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const uint = z.bigint().nonnegative().max(2n ** 256n - 1n);
const requestSchema = z.strictObject({ cash: cashEvidenceSchema, transactionHash: hash,
  ...feeEvidenceSchema.pick({ recipient: true, amountMicroUsdc: true }).shape });
type ReceiptClient = Pick<PublicClient, "getChainId" | "getBlock" | "readContract" | "getTransaction" | "getTransactionReceipt">;
export type ArcReceiptRequest = z.input<typeof requestSchema>;
export class ArcReceiptError extends Error {
  constructor(readonly code: "ARC_RECEIPT_UNAVAILABLE" | "ARC_RECEIPT_TERMS_MISMATCH" | "ARC_RECEIPT_STALE_EVIDENCE"
    | "ARC_RECEIPT_NETWORK_MISMATCH" | "ARC_RECEIPT_BLOCK_MISMATCH" | "ARC_RECEIPT_TOKEN_DECIMALS") { super(code); }
}

/** Read-only evidence for the exact EOA ERC-20 transfer path. Callers supply persisted intent terms.
 * Trusts the configured RPC's canonical/finalized chain view; not a cryptographic light client.
 * SUCCESS is chain evidence only: Circle COMPLETE and atomic settlement remain separate gates.
 */
export function createArcReceiptReader(rawConfig: ArcReaderConfig, client?: ReceiptClient, clock: () => Date = () => new Date()) {
  const config = arcReaderConfigSchema.parse(rawConfig);
  const rpc = client ?? createPublicClient({ transport: http(config.rpcUrl,
    { timeout: 8000, retryCount: 0, fetchOptions: { redirect: "error" } }) });
  return {
    async verify(raw: ArcReceiptRequest) {
      try {
        const parsed = requestSchema.safeParse(raw);
        if (!parsed.success) throw new ArcReceiptError("ARC_RECEIPT_TERMS_MISMATCH");
        const { cash, transactionHash, recipient, amountMicroUsdc } = parsed.data;
        const mismatch = () => { throw new ArcReceiptError("ARC_RECEIPT_TERMS_MISMATCH"); };
        if (cash.walletAddress !== config.walletAddress || recipient === config.walletAddress) mismatch();
        const fresh = () => {
          const now = clock().getTime();
          if (cash.capturedAt !== cash.blockTimestamp || Date.parse(cash.observedAt) < Date.parse(cash.capturedAt)
            || [cash.capturedAt, cash.observedAt].some((v) => !Number.isFinite(now - Date.parse(v))
              || now < Date.parse(v) || now - Date.parse(v) > 30_000)) throw new ArcReceiptError("ARC_RECEIPT_STALE_EVIDENCE");
        };
        const network = async () => {
          if (await rpc.getChainId() !== config.chainId) throw new ArcReceiptError("ARC_RECEIPT_NETWORK_MISMATCH");
        };
        const cashNumber = BigInt(cash.blockNumber);
        const checkCash = async () => {
          const block = await rpc.getBlock({ blockNumber: cashNumber });
          if (block.number !== cashNumber || block.hash?.toLowerCase() !== cash.blockHash
            || block.timestamp * 1000n !== BigInt(Date.parse(cash.blockTimestamp))) throw new ArcReceiptError("ARC_RECEIPT_BLOCK_MISMATCH");
        };
        fresh(); await network(); await checkCash();
        const finalized = await rpc.getBlock({ blockTag: "finalized" });
        if (uint.parse(finalized.number) < cashNumber
          || (finalized.number === cashNumber && finalized.hash?.toLowerCase() !== cash.blockHash)) {
          throw new ArcReceiptError("ARC_RECEIPT_BLOCK_MISMATCH");
        }
        if (await rpc.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: "decimals", blockNumber: cashNumber }) !== 6) {
          throw new ArcReceiptError("ARC_RECEIPT_TOKEN_DECIMALS");
        }
        const txHash = transactionHash as `0x${string}`;
        const tx = await rpc.getTransaction({ hash: txHash });
        const receipt = await rpc.getTransactionReceipt({ hash: txHash });
        const blockNumber = uint.parse(receipt.blockNumber), blockHash = hash.parse(receipt.blockHash.toLowerCase());
        if (blockNumber > cashNumber) throw new ArcReceiptError("ARC_RECEIPT_BLOCK_MISMATCH");
        const input = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient as `0x${string}`, BigInt(amountMicroUsdc)] });
        if (tx.hash.toLowerCase() !== transactionHash || receipt.transactionHash.toLowerCase() !== transactionHash
          || tx.from.toLowerCase() !== config.walletAddress || receipt.from.toLowerCase() !== config.walletAddress
          || tx.to?.toLowerCase() !== config.tokenAddress || receipt.to?.toLowerCase() !== config.tokenAddress
          || tx.value !== 0n || tx.input.toLowerCase() !== input.toLowerCase() || receipt.contractAddress !== null
          || tx.blockNumber !== blockNumber || tx.blockHash?.toLowerCase() !== blockHash
          || tx.transactionIndex !== receipt.transactionIndex || (tx.chainId !== undefined && tx.chainId !== config.chainId)) mismatch();
        const checkReceiptBlock = async () => {
          const block = await rpc.getBlock({ blockNumber });
          if (block.number !== blockNumber || block.hash?.toLowerCase() !== blockHash
            || uint.parse(block.timestamp) * 1000n > BigInt(Date.parse(cash.blockTimestamp))) throw new ArcReceiptError("ARC_RECEIPT_BLOCK_MISMATCH");
        };
        await checkReceiptBlock();
        if (receipt.status !== "success" && receipt.status !== "reverted") mismatch();
        // The native system emitter uses 18 decimals. Only the configured ERC-20 emitter counts.
        const transfers = receipt.logs.filter((log) => log.address.toLowerCase() === config.tokenAddress
          && log.topics[0]?.toLowerCase() === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
        if (receipt.status === "success") {
          if (transfers.length !== 1) mismatch();
          const log = transfers[0]!;
          if (log.removed || log.blockHash?.toLowerCase() !== blockHash || log.blockNumber !== blockNumber
            || log.transactionHash?.toLowerCase() !== transactionHash || log.transactionIndex !== receipt.transactionIndex
            || log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) mismatch();
          const decoded = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", topics: log.topics, data: log.data, strict: true });
          if (decoded.args.from.toLowerCase() !== config.walletAddress || decoded.args.to.toLowerCase() !== recipient
            || decoded.args.value !== BigInt(amountMicroUsdc)) mismatch();
        } else if (receipt.logs.length !== 0) mismatch();
        const gasUsed = uint.positive().parse(receipt.gasUsed), gasPrice = uint.parse(receipt.effectiveGasPrice);
        if (gasUsed > uint.positive().parse(tx.gas)) mismatch();
        const actualFeeNative = uint.parse(gasUsed * gasPrice);
        await checkReceiptBlock(); await checkCash(); await network(); fresh();
        const evidence = { chainId: config.chainId, tokenAddress: config.tokenAddress, walletAddress: config.walletAddress,
          transactionHash, blockNumber: blockNumber.toString(), blockHash, cashBlockHash: cash.blockHash, recipient,
          amountMicroUsdc: receipt.status === "success" ? amountMicroUsdc : "0",
          actualFeeMicroUsdc: formatMicroUsdc((actualFeeNative + 999_999_999_999n) / 1_000_000_000_000n),
          actualFeeNative: actualFeeNative.toString(), outcome: receipt.status === "success" ? "SUCCESS" as const : "REVERTED" as const };
        return { ...evidence, verificationReference: `arc-erc20-receipt:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}` };
      } catch (error) {
        if (error instanceof ArcReceiptError) throw error;
        throw new ArcReceiptError("ARC_RECEIPT_UNAVAILABLE");
      }
    }
  };
}
