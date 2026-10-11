import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@agentpay/core";
import { createArcReceiptReader, type ArcReceiptRequest } from "../apps/server/src/payments/arc-receipt.js";
import type { ArcReaderConfig } from "../apps/server/src/payments/arc.js";

const time = new Date("2026-10-10T12:00:00.000Z");
const wallet = `0x${"1".repeat(40)}` as const, recipient = `0x${"2".repeat(40)}` as const;
const cashHash = `0x${"a".repeat(64)}`, blockHash = `0x${"b".repeat(64)}`, transactionHash = `0x${"c".repeat(64)}`;
const amount = 9007199254740993n;
const config: ArcReaderConfig = { mode: "arc_testnet", chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS,
  walletAddress: wallet, rpcUrl: "https://rpc.testnet.arc.io" };
function request(): ArcReceiptRequest {
  return { transactionHash, recipient, amountMicroUsdc: amount.toString(), cash: {
    chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS, walletAddress: wallet, cashMicroUsdc: "20000000",
    blockNumber: "100", blockHash: cashHash, blockTimestamp: "2026-10-10T11:59:58.000Z",
    capturedAt: "2026-10-10T11:59:58.000Z", observedAt: time.toISOString() } };
}
function fixture() {
  const log = { address: ARC_USDC_ADDRESS, blockHash, blockNumber: "0x63", transactionHash, transactionIndex: "0x0",
    logIndex: "0x0", removed: false,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: wallet, to: recipient } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]) };
  const tx = { hash: transactionHash, blockHash, blockNumber: "0x63", transactionIndex: "0x0", from: wallet,
    to: ARC_USDC_ADDRESS as string, value: "0x0", gas: "0x186a0", chainId: `0x${ARC_CHAIN_ID.toString(16)}`,
    input: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, amount] }) as string };
  const receipt = { transactionHash, blockHash, blockNumber: "0x63", transactionIndex: "0x0", from: wallet as string,
    to: ARC_USDC_ADDRESS as string, contractAddress: null, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca01",
    logs: [log] };
  const state = { chain: ARC_CHAIN_ID as number, decimals: 6, finalized: "0x64", reorgCash: false, reorgReceipt: false,
    unavailable: false, missing: false, afterRead: () => {} };
  const calls: string[] = []; let cashReads = 0, receiptBlocks = 0;
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    await Promise.resolve(); // Preserve an asynchronous transport boundary for mutation/freshness tests.
    calls.push(method as string); state.afterRead();
    if (state.unavailable) throw new Error("secret-provider-url-and-key");
    if (method === "eth_chainId") return `0x${state.chain.toString(16)}`;
    if (method === "eth_call") return encodeAbiParameters([{ type: "uint8" }], [state.decimals]);
    if (method === "eth_getTransactionByHash") return tx;
    if (method === "eth_getTransactionReceipt") return state.missing ? null : receipt;
    if (method === "eth_getBlockByNumber") {
      const [number] = params as [string];
      if (number === "finalized") return { number: state.finalized, hash: cashHash, timestamp: "0x0" };
      if (number === "0x64") return { number, hash: state.reorgCash && ++cashReads > 1 ? blockHash : cashHash,
        timestamp: `0x${(BigInt(time.getTime() / 1000) - 2n).toString(16)}` };
      return { number, hash: state.reorgReceipt && ++receiptBlocks > 1 ? cashHash : blockHash,
        timestamp: `0x${(BigInt(time.getTime() / 1000) - 3n).toString(16)}` };
    }
    throw new Error("Unexpected RPC method");
  } }, { retryCount: 0 }) });
  return { log, tx, receipt, state, calls, client };
}
describe("Arc receipt evidence", () => {
  it("matches exact calldata and the six-decimal event, ignoring the native duplicate", async () => {
    const f = fixture();
    f.receipt.logs.push({ ...f.log, address: "0xfffffffffffffffffffffffffffffffffffffffe",
      data: encodeAbiParameters([{ type: "uint256" }], [amount * 1_000_000_000_000n]) });
    const result = await createArcReceiptReader(config, f.client, () => time).verify(request());
    expect(result).toMatchObject({ outcome: "SUCCESS", amountMicroUsdc: amount.toString(), actualFeeMicroUsdc: "22",
      actualFeeNative: "21000000021000", cashBlockHash: cashHash, blockHash, blockNumber: "99" });
    expect(result.verificationReference).toMatch(/^arc-erc20-receipt:[a-f0-9]{64}$/);
    expect(f.calls.some((m) => m.startsWith("eth_send"))).toBe(false);
  });
  it("returns zero payout plus gas for a reverted exact call without claiming provider failure", async () => {
    const f = fixture(); f.receipt.status = "0x0"; f.receipt.logs = [];
    expect(await createArcReceiptReader(config, f.client, () => time).verify(request()))
      .toMatchObject({ outcome: "REVERTED", amountMicroUsdc: "0", actualFeeMicroUsdc: "22" });
  });
  const mismatches: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ["sender", (f) => { f.receipt.from = recipient; }],
    ["token", (f) => { f.tx.to = recipient; }],
    ["native payment", (f) => { f.tx.value = "0x1"; }],
    ["wrong call amount", (f) => { f.tx.input = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, amount + 1n] }); }],
    ["extra calldata", (f) => { f.tx.input += "00"; }],
    ["wrong event amount", (f) => { f.log.data = encodeAbiParameters([{ type: "uint256" }], [amount + 1n]); }],
    ["wrong event recipient", (f) => { f.log.topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: wallet, to: wallet } }); }],
    ["missing event", (f) => { f.receipt.logs = []; }],
    ["duplicate event", (f) => { f.receipt.logs.push({ ...f.log }); }],
    ["removed event", (f) => { f.log.removed = true; }],
    ["wrong log hash", (f) => { f.log.transactionHash = cashHash; }],
    ["transaction index", (f) => { f.tx.transactionIndex = "0x1"; }],
    ["reverted with logs", (f) => { f.receipt.status = "0x0"; }],
    ["excess gas used", (f) => { f.receipt.gasUsed = "0xffffff"; }]
  ];
  it.each(mismatches)("refuses %s", async (_, mutate) => {
    const f = fixture(); mutate(f);
    await expect(createArcReceiptReader(config, f.client, () => time).verify(request()))
      .rejects.toMatchObject({ code: "ARC_RECEIPT_TERMS_MISMATCH" });
  });
  it.each([
    ["chain", { chain: 1 }, "ARC_RECEIPT_NETWORK_MISMATCH"],
    ["decimals", { decimals: 18 }, "ARC_RECEIPT_TOKEN_DECIMALS"],
    ["finality", { finalized: "0x62" }, "ARC_RECEIPT_BLOCK_MISMATCH"],
    ["cash reorg", { reorgCash: true }, "ARC_RECEIPT_BLOCK_MISMATCH"],
    ["receipt reorg", { reorgReceipt: true }, "ARC_RECEIPT_BLOCK_MISMATCH"],
    ["provider error", { unavailable: true }, "ARC_RECEIPT_UNAVAILABLE"],
    ["missing receipt", { missing: true }, "ARC_RECEIPT_UNAVAILABLE"]
  ] as const)("refuses %s without exposing provider data", async (_, state, code) => {
    const f = fixture(); Object.assign(f.state, state);
    await expect(createArcReceiptReader(config, f.client, () => time).verify(request())).rejects.toMatchObject({ code, message: code });
  });
  it("rejects a receipt newer than cash and stale/future cash", async () => {
    const f = fixture(); f.receipt.blockNumber = "0x65";
    await expect(createArcReceiptReader(config, f.client, () => time).verify(request())).rejects.toMatchObject({ code: "ARC_RECEIPT_BLOCK_MISMATCH" });
    for (const offset of [-4000, 31_000]) {
      await expect(createArcReceiptReader(config, fixture().client, () => new Date(time.getTime() + offset)).verify(request()))
        .rejects.toMatchObject({ code: "ARC_RECEIPT_STALE_EVIDENCE" });
    }
  });
  it("copies terms before network reads and rechecks freshness after reads", async () => {
    const f = fixture(), req = request();
    f.state.afterRead = () => { req.amountMicroUsdc = "1"; };
    expect((await createArcReceiptReader(config, f.client, () => time).verify(req)).amountMicroUsdc).toBe(amount.toString());
    const slow = fixture(); let elapsed = 0;
    slow.state.afterRead = () => { elapsed += 4000; };
    await expect(createArcReceiptReader(config, slow.client, () => new Date(time.getTime() + elapsed)).verify(request()))
      .rejects.toMatchObject({ code: "ARC_RECEIPT_STALE_EVIDENCE" });
  });
  it("refuses fixture mode and invalid terms before RPC", async () => {
    const f = fixture();
    expect(() => createArcReceiptReader({ ...config, mode: "fixture" } as unknown as ArcReaderConfig, f.client)).toThrow();
    await expect(createArcReceiptReader(config, f.client, () => time).verify({ ...request(), recipient: wallet }))
      .rejects.toMatchObject({ code: "ARC_RECEIPT_TERMS_MISMATCH" });
    expect(f.calls).toEqual([]);
  });
  it("rejects fee overflow and a network switch during receipt reads", async () => {
    const f = fixture(); f.receipt.effectiveGasPrice = `0x${(2n ** 256n - 1n).toString(16)}`;
    await expect(createArcReceiptReader(config, f.client, () => time).verify(request()))
      .rejects.toMatchObject({ code: "ARC_RECEIPT_UNAVAILABLE" });
    const switched = fixture();
    switched.state.afterRead = () => { if (switched.calls.includes("eth_getTransactionReceipt")) switched.state.chain = 1; };
    await expect(createArcReceiptReader(config, switched.client, () => time).verify(request()))
      .rejects.toMatchObject({ code: "ARC_RECEIPT_NETWORK_MISMATCH" });
  });
});
