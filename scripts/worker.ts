import { createCircleAdapterFromEnvironment, dispatchNextPayment } from "../apps/server/src/payments/dispatch.js";
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
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 3, connectionTimeoutMillis: 5000,
  statement_timeout: 10000 });
let extractor: PayableExtractor | null = null;
// Fixture mode never falls through to a real model, even with credentials present.
if (config.PAYMENT_MODE !== "fixture") {
  try { extractor = createPayableExtractor(process.env); } catch { /* Missing/invalid model setup holds invoices. */ }
}
const stop = new AbortController();
const planning = createWorkerPlanning(process.env);
const circle = config.PAYMENT_MODE === "arc_testnet" ? createCircleAdapterFromEnvironment(process.env) : null;
const reconciliation = circle ? createArcReconciliationFromEnvironment(process.env) : null;
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
jsonLog({ worker: "extraction-planning-and-retention", extractionAvailable: extractor !== null, planningAvailable: planning !== null,
  dispatchAvailable: circle !== null, dispatchEnabled: false, mode: config.PAYMENT_MODE });
try {
  while (!stop.signal.aborted) {
    try {
      // Bounded batch, no overlapping model calls. Payment heartbeat remains unset.
      for (let count = 0; count < 10 && !stop.signal.aborted; count++) {
        if (!await processNextObligation(pool, config.BUSINESS_ID, extractor, planning)) break;
      }
      if (planning) {
        for (let count = 0; count < 10 && !stop.signal.aborted; count++) {
          const reservation = await reserveNextPayment(pool, config.BUSINESS_ID);
          if (reservation.status !== "RESERVED") break;
          jsonLog({ worker: "payment-reservation", status: reservation.status, intentId: reservation.intentId, dispatchEnabled: false });
        }
      }
      if (circle) {
              if (circle && reconciliation) {
                const settled = await reconcileNextPayment(pool, circle, reconciliation.cashReader, reconciliation.receiptReader, config.BUSINESS_ID);
                if (settled.status !== "NO_UNRESOLVED") jsonLog({ worker: "payment-reconciliation", status: settled.status,
                  intentId: settled.intentId, dispatchEnabled: false });
              }
        const dispatch = await dispatchNextPayment(pool, circle, config.BUSINESS_ID);
        if (dispatch.status !== "NO_RESERVED") jsonLog({ worker: "payment-dispatch", status: dispatch.status,
          intentId: dispatch.intentId, dispatchEnabled: false });
      }
      await cleanupExpiredInputs(pool, config.BUSINESS_ID);
    } catch { jsonLog({ worker: "extraction-planning-and-retention", error: "PROCESSING_UNAVAILABLE", dispatchEnabled: false }); }
    try { await setTimeout(30_000, undefined, { signal: stop.signal }); } catch { /* Shutdown. */ }
  }
} finally { await pool.end(); }
