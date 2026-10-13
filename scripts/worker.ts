import { createCircleAdapterFromEnvironment, dispatchNextPayment, recoverSubmittingPayments } from "../apps/server/src/payments/dispatch.js";
import { createArcReconciliationFromEnvironment, reconcileNextPayment } from "../apps/server/src/payments/reconcile.js";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import { loadApConfig } from "../apps/server/src/ap/config.js";
import { createPayableExtractor, type PayableExtractor } from "../apps/server/src/extraction/payable.js";
import { processNextObligation } from "../apps/server/src/obligations/process.js";
import { cleanupExpiredInputs } from "../apps/server/src/obligations/ingest.js";
import { createWorkerPlanning } from "../apps/server/src/treasury/runtime.js";
import { reserveNextPayment } from "../apps/server/src/payments/worker.js";
import { jsonLog, loadRootEnv } from "./shared.js";

loadRootEnv();
const config = loadApConfig();
if (!config.DATABASE_URL) throw new Error("Worker requires the configured development DATABASE_URL and AP migrations");
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
let extractor: PayableExtractor | null = null;
if (config.PAYMENT_MODE !== "fixture") {
  try { extractor = createPayableExtractor(process.env); } catch { /* Missing model setup holds invoices. */ }
}
const stop = new AbortController(), planning = createWorkerPlanning(process.env);
const circle = config.PAYMENT_MODE === "arc_testnet" ? createCircleAdapterFromEnvironment(process.env) : null;
const reconciliation = circle ? createArcReconciliationFromEnvironment(process.env) : null;
const dispatchEnabled = circle?.dispatchEnabled === true && planning !== null;
async function heartbeat(healthy:boolean) {
  await pool.query(`INSERT INTO ap_worker_status (business_id,extraction_available,payment_available,dispatch_enabled,healthy)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (business_id) DO UPDATE SET updated_at=now(),extraction_available=$2,
    payment_available=$3,dispatch_enabled=$4,healthy=$5`,
    [config.BUSINESS_ID,extractor!==null,circle!==null && reconciliation!==null && planning!==null,dispatchEnabled,healthy]);
}
process.once("SIGINT", () => stop.abort()); process.once("SIGTERM", () => stop.abort());
jsonLog({ worker: "payables", extractionAvailable: extractor !== null, planningAvailable: planning !== null, dispatchEnabled, mode: config.PAYMENT_MODE });
async function reserve() {
  if (!dispatchEnabled || !planning) return;
  const result = await reserveNextPayment(pool,config.BUSINESS_ID,new Date(),planning);
  if (result.status === "RESERVED") jsonLog({worker:"payment-reservation",status:result.status,intentId:result.intentId});
}
try {
  while (!stop.signal.aborted) {
    try {
      await recoverSubmittingPayments(pool,config.BUSINESS_ID);
      // Reconciliation runs even when paused or new dispatch is disabled.
      if (circle && reconciliation) {
        const result=await reconcileNextPayment(pool,circle,reconciliation.cashReader,reconciliation.receiptReader,config.BUSINESS_ID);
        if (result.status!=="NO_UNRESOLVED") jsonLog({worker:"payment-reconciliation",...result});
      }
      await reserve(); // Preserve exact approvals before re-evaluating other obligations.
      for (let count=0;count<10 && !stop.signal.aborted;count++) {
        if (!await processNextObligation(pool,config.BUSINESS_ID,extractor,planning)) break;
        await reserve();
      }
      if (circle && planning) {
        const result=await dispatchNextPayment(pool,circle,config.BUSINESS_ID,planning);
        if (result.status!=="NO_RESERVED" && result.status!=="DISABLED") jsonLog({worker:"payment-dispatch",...result});
      }
      await cleanupExpiredInputs(pool,config.BUSINESS_ID);
      await heartbeat(true);
    } catch {
      await heartbeat(false).catch(()=>undefined);
      jsonLog({worker:"payables",error:"PROCESSING_UNAVAILABLE",dispatchEnabled});
    }
    try { await setTimeout(30000,undefined,{signal:stop.signal}); } catch { /* Shutdown. */ }
  }
} finally { await heartbeat(false).catch(()=>undefined); await pool.end(); }
