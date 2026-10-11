import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@agentpay/core";
import type { PlanningAdapters } from "../../apps/server/src/treasury/prepare.js";

/** Explicit synthetic adapters for database tests only; never loaded by the worker runtime. */
export function syntheticPlanning(beforeProposal?: () => Promise<void>): PlanningAdapters {
  return { mode: "fixture", planner: { modelId: "synthetic-planner", async propose(_context, candidates) {
    await beforeProposal?.();
    return { candidateId: candidates[0]!.id, reason: "Synthetic evidence fits policy.", evidenceIds: candidates[0]!.evidenceIds,
      assumptions: [], alternativeConsidered: "Hold for more cash." };
  } },
  readCash: (treasury) => {
    const now = new Date().toISOString();
    return Promise.resolve({ chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS, walletAddress: treasury.walletAddress,
      cashMicroUsdc: "20000000", blockNumber: "100", blockHash: `0x${"a".repeat(64)}`,
      capturedAt: now, blockTimestamp: now, observedAt: now });
  },
  estimateFee: (cash, recipient, amountMicroUsdc) => Promise.resolve({ chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS,
    walletAddress: cash.walletAddress, recipient, amountMicroUsdc, cashBlockHash: cash.blockHash,
    capturedAt: new Date().toISOString(), evidenceReference: "synthetic-fee", gasLimit: "21000",
    maxFeePerGasNative: "1000000000", bufferBps: 0, extraBufferMicroUsdc: "0" }) };
}
