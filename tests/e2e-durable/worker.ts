// Explicit fixture worker. All persistence/services are real; model/provider/Arc
// boundaries are synthetic. This file is never imported by production.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import { processNextObligation } from "../../apps/server/src/obligations/process.js";
import { reserveNextPayment } from "../../apps/server/src/payments/worker.js";
import { dispatchNextPayment } from "../../apps/server/src/payments/dispatch.js";
import { reconcileNextPayment } from "../../apps/server/src/payments/reconcile.js";
import { readPlanningState } from "../../apps/server/src/treasury/ledger.js";
import { syntheticPlanning } from "../support/planning.js";
import { syntheticPayable } from "../support/payable.js";
import { fixtureConfig } from "../support/ap-fixture.js";

const connectionString = process.env.AP_TEST_DATABASE_URL;
if (!connectionString || connectionString === process.env.DATABASE_URL) throw new Error("DISPOSABLE_TEST_DATABASE_REQUIRED");
const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 }), businessId = fixtureConfig.BUSINESS_ID;
const secondHash = createHash("sha256").update(await readFile(new URL("../../fixtures/synthetic-invoice-2.png", import.meta.url))).digest("hex");
const planning = syntheticPlanning();
planning.verifyPayments = (cash, payments) => Promise.resolve(payments.map((payment) => payment.state === "SETTLED" ? { ...payment,
  receipt: { chainId: 5042002 as const, tokenAddress: cash.tokenAddress, walletAddress: cash.walletAddress,
    recipient: payment.recipient, amountMicroUsdc: payment.amountMicroUsdc, transactionHash: payment.transactionHash!,
    blockNumber: "99", blockHash: `0x${"c".repeat(64)}`, cashBlockHash: cash.blockHash, actualFeeMicroUsdc: "21",
    actualFeeNative: "21000000000000", outcome: "SUCCESS" as const, verificationReference: "synthetic-durable-receipt" }
} : payment));
let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { running = false; });
while (running) {
  await processNextObligation(pool, businessId, { modelId: "synthetic-durable-test", extract(image) {
    const raw = syntheticPayable();
    if (createHash("sha256").update(image.bytes).digest("hex") === secondHash) {
      raw.invoiceNumber = { value: "FUTURE-2", sourceText: "FUTURE-2", status: "EXTRACTED" };
      raw.purchaseOrderReference = { value: "future-po", sourceText: "future-po", status: "EXTRACTED" };
      raw.dueDate = { value: "2099-01-01", sourceText: "2099-01-01", status: "EXTRACTED" };
    }
    return Promise.resolve(raw);
  } }, planning);
  await reserveNextPayment(pool, businessId, new Date(), planning);
  await dispatchNextPayment(pool, { dispatchEnabled: true, submit: () => Promise.resolve({ providerId: `synthetic-${Date.now()}`, providerState: "INITIATED" }) }, businessId, planning);
  const state = await readPlanningState(pool, businessId), pending = state.payments.find((payment) => payment.state === "PENDING");
  if (pending) {
    const cash = await planning.readCash(state.treasury), hash = `0x${createHash("sha256").update(pending.intentId).digest("hex")}`;
    await reconcileNextPayment(pool, { getStatus: () => Promise.resolve({ providerId: pending.providerId!, providerState: "COMPLETE", transactionHash: hash, errorReason: null }) },
      { read: () => Promise.resolve(cash) }, { verify: () => Promise.resolve({ chainId: 5042002, tokenAddress: state.treasury.tokenAddress,
        walletAddress: state.treasury.walletAddress, recipient: pending.recipient, amountMicroUsdc: pending.amountMicroUsdc,
        blockNumber: "99", blockHash: `0x${"c".repeat(64)}`, cashBlockHash: cash.blockHash, transactionHash: hash,
        actualFeeMicroUsdc: "21", actualFeeNative: "21000000000000", outcome: "SUCCESS", verificationReference: "synthetic-durable-receipt" }) }, businessId);
  }
  await setTimeout(200);
}
await pool.end();
