import { createPublicClient, custom, encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@agentpay/core";
import { createArcCashReader, type ArcReaderConfig } from "../apps/server/src/payments/arc.js";

const time = new Date("2026-10-09T12:00:00.000Z");
const wallet = `0x${"1".repeat(40)}`;
const config: ArcReaderConfig = { mode: "arc_testnet", chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS,
  walletAddress: wallet, rpcUrl: "https://rpc.testnet.arc.io" };
const blockHash = `0x${"a".repeat(64)}`;

function rpcFixture(options: { chainId?: number; decimals?: number; balance?: bigint; age?: number; reorg?: boolean; error?: boolean } = {}) {
  const requests: { method: string; params?: unknown }[] = [];
  let blocks = 0;
  const client = createPublicClient({ transport: custom({ request: ({ method, params }) => {
    requests.push({ method: method as string, params: params as unknown });
    if (options.error) return Promise.reject(new Error("private-provider-token"));
    if (method === "eth_chainId") return Promise.resolve(`0x${(options.chainId ?? ARC_CHAIN_ID).toString(16)}`);
    if (method === "eth_getBlockByNumber") {
      blocks++;
      return Promise.resolve({ number: "0x64", hash: options.reorg && blocks > 1 ? `0x${"b".repeat(64)}` : blockHash,
        timestamp: `0x${(BigInt(time.getTime() / 1000) - BigInt(options.age ?? 2)).toString(16)}` });
    }
    if (method === "eth_call") {
      const [call] = params as [{ data: string }];
      return Promise.resolve(call.data === "0x313ce567"
        ? encodeAbiParameters([{ type: "uint8" }], [options.decimals ?? 6])
        : encodeAbiParameters([{ type: "uint256" }], [options.balance ?? 9007199254740993n]));
    }
    return Promise.reject(new Error("Unexpected RPC method"));
  } }, { retryCount: 0 }) });
  return { client, requests };
}

describe("read-only Arc cash evidence", () => {
  it("reads exact six-decimal cash at one finalized block without adding a native balance", async () => {
    const rpc = rpcFixture();
    const result = await createArcCashReader(config, rpc.client, () => time).read();
    expect(result).toMatchObject({ cashMicroUsdc: "9007199254740993", blockNumber: "100", blockHash,
      walletAddress: wallet, capturedAt: "2026-10-09T11:59:58.000Z", observedAt: time.toISOString() });
    expect(rpc.requests.filter((r) => r.method === "eth_call").every((r) => (r.params as unknown[])[1] === "0x64")).toBe(true);
    expect(rpc.requests.some((r) => ["eth_getBalance", "eth_sendTransaction", "eth_sendRawTransaction"].includes(r.method))).toBe(false);
  });
  it.each([
    [{ chainId: 1 }, "ARC_NETWORK_MISMATCH"], [{ decimals: 18 }, "ARC_TOKEN_DECIMALS"],
    [{ age: 31 }, "ARC_STALE_BLOCK"], [{ age: -1 }, "ARC_STALE_BLOCK"],
    [{ reorg: true }, "ARC_INCONSISTENT_BLOCK"], [{ error: true }, "ARC_UNAVAILABLE"]
  ] as const)("refuses inconsistent or unavailable evidence %j", async (options, code) => {
    const rpc = rpcFixture(options);
    await expect(createArcCashReader(config, rpc.client, () => time).read()).rejects.toMatchObject({ code, message: code });
  });
  it("rejects fixtures, wrong tokens and insecure endpoints before any RPC calls", () => {
    const rpc = rpcFixture();
    for (const change of [{ mode: "fixture" }, { tokenAddress: wallet }, { rpcUrl: "http://example.invalid" }]) {
      expect(() => createArcCashReader({ ...config, ...change } as typeof config, rpc.client)).toThrow();
    }
    expect(rpc.requests).toHaveLength(0);
  });
  it("refuses a balance that overflows canonical storage and evidence that ages during RPC reads", async () => {
    const overflow = rpcFixture({ balance: 100000000000000000000n });
    await expect(createArcCashReader(config, overflow.client, () => time).read()).rejects.toMatchObject({ code: "ARC_UNAVAILABLE" });
    const rpc = rpcFixture(); let reads = 0;
    await expect(createArcCashReader(config, rpc.client, () => new Date(time.getTime() + (reads++ ? 31_000 : 0))).read())
      .rejects.toMatchObject({ code: "ARC_STALE_BLOCK" });
  });
});
