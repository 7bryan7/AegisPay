import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, accountTreasury } from "@agentpay/core";
import { createArcFeeReader, type ArcFeeRequest } from "../apps/server/src/payments/arc-fees.js";
import type { ArcReaderConfig } from "../apps/server/src/payments/arc.js";

const now = new Date("2026-10-10T12:00:00.000Z");
const wallet = `0x${"1".repeat(40)}`, recipient = `0x${"2".repeat(40)}`, blockHash = `0x${"a".repeat(64)}`;
const config: ArcReaderConfig = { mode: "arc_testnet", chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS,
  walletAddress: wallet, rpcUrl: "https://rpc.testnet.arc.io" };
const buffer = { bufferBps: 2500, extraBufferMicroUsdc: "7" };
function request(): ArcFeeRequest {
  return { recipient, amountMicroUsdc: "1500000", cash: { chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS,
    walletAddress: wallet, cashMicroUsdc: "20000000", blockNumber: "100", blockHash,
    capturedAt: "2026-10-10T11:59:58.000Z", blockTimestamp: "2026-10-10T11:59:58.000Z", observedAt: now.toISOString() } };
}
function fixture(options: { chain?: number; lateChain?: number; reorg?: boolean; timestamp?: number;
  gas?: bigint; baseFee?: bigint; decimals?: number; error?: boolean; onEstimate?: () => void } = {}) {
  const requests: { method: string; params: unknown }[] = [];
  let chainReads = 0, pinnedReads = 0;
  const client = createPublicClient({ transport: custom({ request: ({ method, params }) => {
    requests.push({ method: method as string, params: params as unknown });
    if (options.error) return Promise.reject(new Error("secret-in-provider-url"));
    if (method === "eth_chainId") {
      chainReads++;
      return Promise.resolve(`0x${(chainReads > 1 ? options.lateChain ?? ARC_CHAIN_ID : options.chain ?? ARC_CHAIN_ID).toString(16)}`);
    }
    if (method === "eth_getBlockByNumber") {
      const pinned = (params as unknown[])[0] === "0x64";
      if (pinned) pinnedReads++;
      return Promise.resolve({ number: "0x64", hash: options.reorg && pinnedReads > 1 ? `0x${"b".repeat(64)}` : blockHash,
        timestamp: `0x${(BigInt(now.getTime() / 1000) - BigInt(options.timestamp ?? 2)).toString(16)}`,
        baseFeePerGas: `0x${(options.baseFee ?? 1000000001n).toString(16)}` });
    }
    if (method === "eth_call") return Promise.resolve(encodeAbiParameters([{ type: "uint8" }], [options.decimals ?? 6]));
    if (method === "eth_maxPriorityFeePerGas") return Promise.resolve("0x1");
    if (method === "eth_estimateGas") {
      options.onEstimate?.();
      return Promise.resolve(`0x${(options.gas ?? 21001n).toString(16)}`);
    }
    return Promise.reject(new Error("Unexpected RPC method"));
  } }, { retryCount: 0 }) });
  return { client, requests };
}

describe("Arc ERC-20 fee evidence", () => {
  it("encodes only exact transfer terms, pins simulation, rounds upward and feeds treasury accounting", async () => {
    const rpc = fixture(), input = request();
    const result = await createArcFeeReader(config, buffer, rpc.client, () => now).estimate(input);
    expect(result.allowanceMicroUsdc).toBe("39"); // ceil(21001 * 1200000002 * 1.25 / 1e12) + 7
    expect(result.evidence).toMatchObject({ recipient, amountMicroUsdc: "1500000", gasLimit: "21001",
      maxFeePerGasNative: "1200000002", cashBlockHash: blockHash, capturedAt: now.toISOString() });
    expect(result.evidence.evidenceReference).toMatch(/^arc-erc20-estimate:[0-9a-f]{64}$/);
    const [call, block] = rpc.requests.find((r) => r.method === "eth_estimateGas")!.params as [{ from: string; to: string; data: `0x${string}`; value?: string }, string];
    expect(block).toBe("0x64"); expect(call.from).toBe(wallet); expect(call.to).toBe(ARC_USDC_ADDRESS); expect(call.value).toBeUndefined();
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data })).toMatchObject({ functionName: "transfer", args: [recipient, 1500000n] });
    expect(rpc.requests.some((r) => /send|sign/i.test(r.method))).toBe(false);
    const accounting = accountTreasury({ businessId: "business", now: now.toISOString(), paused: false,
      policy: { autoPayMaxMicroUsdc: "2000000", hardTxMaxMicroUsdc: "5000000", dailyBudgetMicroUsdc: "10000000",
        categoryBudgetMicroUsdc: "8000000", minReserveMicroUsdc: "5000000" },
      candidate: { obligationId: "invoice", purchaseOrderId: "po", category: "office", recipient, amountMicroUsdc: "1500000" },
      cash: input.cash, fee: result.evidence, ledgerAsOf: now.toISOString(), coverageFrom: "2026-10-01T00:00:00.000Z",
      payments: [], commitments: [] });
    expect(accounting).toMatchObject({ status: "READY", availableMicroUsdc: "14999961", snapshot: { feeAllowanceMicroUsdc: "39" } });
  });
  it("preserves amounts beyond Number precision and snapshots inputs before awaiting RPC", async () => {
    const input = request(); input.amountMicroUsdc = "9007199254740993";
    const rpc = fixture({ onEstimate: () => { input.recipient = wallet; input.amountMicroUsdc = "1"; input.cash.blockHash = `0x${"c".repeat(64)}`; } });
    const result = await createArcFeeReader(config, buffer, rpc.client, () => now).estimate(input);
    expect(result.evidence).toMatchObject({ recipient, amountMicroUsdc: "9007199254740993", cashBlockHash: blockHash });
    const [call] = rpc.requests.find((r) => r.method === "eth_estimateGas")!.params as [{ data: `0x${string}` }];
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data }).args).toEqual([recipient, 9007199254740993n]);
  });
  it.each([
    [{ chain: 1 }, "ARC_FEE_NETWORK_MISMATCH"], [{ lateChain: 1 }, "ARC_FEE_NETWORK_MISMATCH"],
    [{ reorg: true }, "ARC_FEE_BLOCK_MISMATCH"], [{ timestamp: 3 }, "ARC_FEE_BLOCK_MISMATCH"],
    [{ decimals: 18 }, "ARC_FEE_TOKEN_DECIMALS"], [{ gas: 0n }, "ARC_FEE_UNAVAILABLE"],
    [{ gas: 2n ** 256n }, "ARC_FEE_UNAVAILABLE"], [{ gas: 2n ** 255n }, "ARC_FEE_UNAVAILABLE"],
    [{ error: true }, "ARC_FEE_UNAVAILABLE"]
  ] as const)("refuses invalid or unavailable RPC evidence case %#", async (options, code) => {
    await expect(createArcFeeReader(config, buffer, fixture(options).client, () => now).estimate(request()))
      .rejects.toMatchObject({ code, message: code });
  });
  it("refuses wrong wallet, self-payment, zero amount and extra transaction fields before RPC", async () => {
    for (const alter of [
      (r: ArcFeeRequest) => { r.cash.walletAddress = recipient; }, (r: ArcFeeRequest) => { r.recipient = wallet; },
      (r: ArcFeeRequest) => { r.amountMicroUsdc = "0"; }, (r: ArcFeeRequest) => { Object.assign(r, { data: "0x1234" }); }
    ]) {
      const rpc = fixture(), input = request(); alter(input);
      await expect(createArcFeeReader(config, buffer, rpc.client, () => now).estimate(input)).rejects.toMatchObject({ code: "ARC_FEE_TERMS_MISMATCH" });
      expect(rpc.requests).toHaveLength(0);
    }
  });
  it("refuses stale, future, inconsistent and mid-request expired cash evidence", async () => {
    for (const alter of [
      (r: ArcFeeRequest) => { r.cash.observedAt = "2026-10-10T12:00:01.000Z"; },
      (r: ArcFeeRequest) => { r.cash.capturedAt = "2026-10-10T11:59:59.000Z"; },
      (r: ArcFeeRequest) => { r.cash.capturedAt = r.cash.blockTimestamp = "2026-10-10T11:59:29.000Z"; },
      (r: ArcFeeRequest) => { r.cash.observedAt = "2026-10-10T11:59:57.000Z"; }
    ]) {
      const rpc = fixture(), input = request(); alter(input);
      await expect(createArcFeeReader(config, buffer, rpc.client, () => now).estimate(input)).rejects.toMatchObject({ code: "ARC_FEE_STALE_EVIDENCE" });
      expect(rpc.requests).toHaveLength(0);
    }
    let time = now;
    const rpc = fixture({ onEstimate: () => { time = new Date(now.getTime() + 31_000); } });
    await expect(createArcFeeReader(config, buffer, rpc.client, () => time).estimate(request())).rejects.toMatchObject({ code: "ARC_FEE_STALE_EVIDENCE" });
  });
  it("refuses fixture mode, unsafe endpoints and invalid buffers before any call", () => {
    const rpc = fixture();
    for (const change of [{ mode: "fixture" }, { mode: "disabled" }, { rpcUrl: "http://example.invalid" }]) {
      expect(() => createArcFeeReader({ ...config, ...change } as ArcReaderConfig, buffer, rpc.client)).toThrow();
    }
    expect(() => createArcFeeReader(config, { ...buffer, bufferBps: -1 }, rpc.client)).toThrow();
    expect(rpc.requests).toHaveLength(0);
  });
});
