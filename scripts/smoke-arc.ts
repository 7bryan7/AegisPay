import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, microUsdcToUsdc } from "@agentpay/core";
import { createArcCashReader } from "../apps/server/src/payments/arc.js";
import { createArcReceiptReader } from "../apps/server/src/payments/arc-receipt.js";
import { createCircleTransferAdapter, type CircleTransactionStatus } from "../apps/server/src/payments/circle.js";
import { hasPlaceholder, jsonLog, loadRootEnv, requiredValue, safeErrorDetail } from "./shared.js";

loadRootEnv();

const pay = process.argv.includes("--pay");
const dryRun = process.argv.includes("--dry-run");

if (pay === dryRun) {
  process.stderr.write("Usage: npm run smoke:arc -- [--dry-run | --pay] [--recipient 0x...] [--amount-micro-usdc 1000000]\n");
  throw new Error("Choose exactly one of --dry-run or --pay");
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (index >= 0 && !value) throw new Error(`${name} requires a value`);
  return value;
}

const mode = process.env.PAYMENT_MODE;
if (mode !== "arc_testnet") {
  throw new Error(`PAYMENT_MODE must be 'arc_testnet' (currently '${mode ?? "undefined"}')`);
}

const rpcUrl = requiredValue("ARC_RPC_URL");
const walletAddress = requiredValue("ARC_WALLET_ADDRESS");
const circleWalletId = requiredValue("CIRCLE_WALLET_ID");

jsonLog({
  stage: "smoke-arc-init",
  mode,
  rpcUrl: new URL(rpcUrl).origin,
  walletAddress,
  circleWalletId,
  dryRun,
  valueMoving: pay
});

// Step 1: Read-only Arc Testnet cash inspection
const cashReader = createArcCashReader({
  mode: "arc_testnet",
  chainId: ARC_CHAIN_ID,
  tokenAddress: ARC_USDC_ADDRESS,
  walletAddress,
  rpcUrl
});

let cashSnapshot: Awaited<ReturnType<typeof cashReader.read>>;
try {
  cashSnapshot = await cashReader.read();
  jsonLog({
    stage: "arc-cash-read",
    ok: true,
    blockNumber: cashSnapshot.blockNumber,
    blockHash: cashSnapshot.blockHash,
    cashUsdc: `${microUsdcToUsdc(BigInt(cashSnapshot.cashMicroUsdc))} USDC`,
    cashMicroUsdc: cashSnapshot.cashMicroUsdc,
    blockTimestamp: cashSnapshot.blockTimestamp
  });
} catch (error) {
  jsonLog({ stage: "arc-cash-read", ok: false, error: safeErrorDetail("arc-cash", error) });
  throw error;
}

if (dryRun) {
  // Dry run verifies RPC connectivity, token balance reading, and Circle configuration presence
  const circleConfigured = !hasPlaceholder(process.env.CIRCLE_API_KEY) && !hasPlaceholder(process.env.CIRCLE_ENTITY_SECRET);
  jsonLog({
    stage: "smoke-arc-dry-run-complete",
    ok: true,
    circleConfigured,
    message: "Arc Testnet cash reader and network verification passed. Dry run complete."
  });
  process.exit(0);
}

// Step 2: Live bounded Circle transfer on Arc Testnet (--pay)
const apiKey = requiredValue("CIRCLE_API_KEY");
const entitySecret = requiredValue("CIRCLE_ENTITY_SECRET");

const recipient = optionalArgument("--recipient") ?? walletAddress; // default to self/treasury address for non-destructive testnet smoke
const amountMicroUsdc = optionalArgument("--amount-micro-usdc") ?? "1000000"; // 1.00 USDC

const maxSmokeAmount = 5_000_000n; // 5.00 USDC safety cap for smoke tests
const parsedAmount = BigInt(amountMicroUsdc);
if (parsedAmount <= 0n || parsedAmount > maxSmokeAmount) {
  throw new Error(`Smoke amount must be between 1 and ${maxSmokeAmount} micro-USDC (<= 5 USDC)`);
}

const circle = createCircleTransferAdapter({
  apiKey,
  entitySecret,
  walletId: circleWalletId,
  blockchain: "ARC-TESTNET"
});

const idempotencyKey = randomUUID();
jsonLog({
  stage: "circle-submitting",
  walletId: circleWalletId,
  recipient,
  amountUsdc: `${microUsdcToUsdc(parsedAmount)} USDC`,
  idempotencyKey
});

const submission = await circle.submit({
  walletId: circleWalletId,
  providerIdempotencyKey: idempotencyKey,
  recipient,
  amountMicroUsdc,
  chainId: ARC_CHAIN_ID,
  tokenAddress: ARC_USDC_ADDRESS
});

jsonLog({ stage: "circle-submitted", providerId: submission.providerId, providerState: submission.providerState });

// Step 3: Poll Circle transaction status until terminal
let status: CircleTransactionStatus | null = null;
const deadline = Date.now() + 120_000; // 2 minutes

while (Date.now() < deadline) {
  await setTimeout(5_000);
  status = await circle.getStatus(submission.providerId);
  jsonLog({ stage: "circle-poll", providerState: status.providerState, txHash: status.transactionHash });
  if (status.providerState === "COMPLETE" || status.providerState === "FAILED" || status.providerState === "CANCELLED") {
    break;
  }
}

if (!status || status.providerState !== "COMPLETE" || !status.transactionHash) {
  jsonLog({ stage: "circle-terminal-failure", status });
  throw new Error(`Circle transfer did not complete successfully (state: ${status?.providerState ?? "TIMEOUT"})`);
}

// Step 4: Independently verify settlement on Arc Testnet via Arc Receipt Reader
const receiptReader = createArcReceiptReader({
  mode: "arc_testnet",
  chainId: ARC_CHAIN_ID,
  tokenAddress: ARC_USDC_ADDRESS,
  walletAddress,
  rpcUrl
});

const verified = await receiptReader.verify({
  transactionHash: status.transactionHash,
  recipient,
  amountMicroUsdc,
  cash: cashSnapshot
});

jsonLog({
  stage: "smoke-arc-live-complete",
  ok: true,
  providerId: status.providerId,
  transactionHash: status.transactionHash,
  receiptVerification: verified,
  message: "Live Arc Testnet transfer submitted via Circle and independently verified on chain."
});
