import { z } from "zod";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, feeEvidenceSchema } from "@agentpay/core";
import { createGeminiPayablePlanner } from "../agent/planner.js";
import { arcReaderConfigSchema, createArcCashReader } from "../payments/arc.js";
import { createArcFeeReader } from "../payments/arc-fees.js";
import type { PlanningAdapters } from "./prepare.js";

/** Construction performs no network calls. Fixture/disabled modes cannot construct live readers. */
export function createWorkerPlanning(environment: NodeJS.ProcessEnv): PlanningAdapters | null {
  if (environment.PAYMENT_MODE !== "arc_testnet") return null;
  try {
    const config = z.object({ CIRCLE_WALLET_ID: z.string().trim().min(1),
      ARC_RPC_URL: arcReaderConfigSchema.shape.rpcUrl,
      ARC_CHAIN_ID: z.coerce.number().pipe(z.literal(ARC_CHAIN_ID)), ARC_USDC_ADDRESS: z.literal(ARC_USDC_ADDRESS),
      SCREENING_MODE: z.literal("local_registry"),
      FEE_BUFFER_BPS: z.coerce.number().pipe(feeEvidenceSchema.shape.bufferBps),
      FEE_EXTRA_BUFFER_MICRO_USDC: feeEvidenceSchema.shape.extraBufferMicroUsdc }).parse(environment);
    const readerConfig = (walletAddress: string) => ({ mode: "arc_testnet" as const, chainId: config.ARC_CHAIN_ID,
      tokenAddress: config.ARC_USDC_ADDRESS, rpcUrl: config.ARC_RPC_URL, walletAddress });
    let planner = null;
    try { planner = createGeminiPayablePlanner(environment); } catch { /* Valid evidence can still produce deterministic holds/approval requests. */ }
    return { mode: "arc_testnet", planner,
      readCash: (treasury) => {
        if (treasury.walletId !== config.CIRCLE_WALLET_ID || treasury.mode !== "arc_testnet") throw new Error("PLANNING_WALLET_MISMATCH");
        return createArcCashReader(readerConfig(treasury.walletAddress)).read();
      },
      estimateFee: async (cash, recipient, amount) => (await createArcFeeReader(readerConfig(cash.walletAddress),
        { bufferBps: config.FEE_BUFFER_BPS, extraBufferMicroUsdc: config.FEE_EXTRA_BUFFER_MICRO_USDC })
        .estimate({ cash, recipient, amountMicroUsdc: amount })).evidence
    };
  } catch { return null; }
}
