import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import { z } from "zod";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, microUsdcStringSchema } from "@agentpay/core";
import { createArcCashReader } from "../apps/server/src/payments/arc.js";
import { createCircleAdapterFromEnvironment, dispatchNextPayment, recoverSubmittingPayments } from "../apps/server/src/payments/dispatch.js";
import { createArcReconciliationFromEnvironment, reconcileNextPayment } from "../apps/server/src/payments/reconcile.js";
import { createWorkerPlanning } from "../apps/server/src/treasury/runtime.js";
import { loadApConfig } from "../apps/server/src/ap/config.js";
import { jsonLog, loadRootEnv, requiredValue } from "./shared.js";

// This command never creates an obligation, recipient, intent or idempotency key.
async function main() {
  const {values}=parseArgs({options:{"dry-run":{type:"boolean"},pay:{type:"boolean"},"intent-id":{type:"string"},"max-amount-micro-usdc":{type:"string"}}});
  if (!!values.pay===!!values["dry-run"]) throw new Error("SMOKE_MODE_REQUIRED");
  loadRootEnv();
  const config=loadApConfig();
  if(config.PAYMENT_MODE!=="arc_testnet") throw new Error("ARC_TESTNET_REQUIRED");
  if(values["dry-run"]) {
    const cash=await createArcCashReader({mode:"arc_testnet",chainId:ARC_CHAIN_ID,tokenAddress:ARC_USDC_ADDRESS,
      walletAddress:requiredValue("ARC_WALLET_ADDRESS"),rpcUrl:requiredValue("ARC_RPC_URL")}).read();
    jsonLog({stage:"arc-read-only",cashMicroUsdc:cash.cashMicroUsdc,blockNumber:cash.blockNumber,blockHash:cash.blockHash,valueMoving:false});return;
  }
  const intentId=z.uuid().parse(values["intent-id"]), limit=microUsdcStringSchema.parse(values["max-amount-micro-usdc"]);
  if(BigInt(limit)<1n || BigInt(limit)>1000000n) throw new Error("SMOKE_LIMIT_ONE_USDC");
  const circle=createCircleAdapterFromEnvironment(process.env), readers=createArcReconciliationFromEnvironment(process.env), planning=createWorkerPlanning(process.env);
  if(!config.DATABASE_URL || !circle?.dispatchEnabled || !readers || !planning) throw new Error("LIVE_CONFIGURATION_REQUIRED");
  const pool=new Pool({connectionString:config.DATABASE_URL,max:2,connectionTimeoutMillis:5000,statement_timeout:10000});
  try {
    const row=(await pool.query<{amount:string;state:string}>("SELECT amount_micro_usdc::text AS amount,state FROM ap_payment_intents WHERE business_id=$1 AND id=$2",[config.BUSINESS_ID,intentId])).rows[0];
    if(!row || BigInt(row.amount)>BigInt(limit)) throw new Error("SMOKE_INTENT_OR_LIMIT_MISMATCH");
    if(row.state==="SETTLED") {jsonLog({stage:"already-settled",intentId,resubmitted:false});return;}
    await recoverSubmittingPayments(pool,config.BUSINESS_ID);
    const dispatch=await dispatchNextPayment(pool,circle,config.BUSINESS_ID,planning,intentId);
    jsonLog({stage:"durable-dispatch",...dispatch});
    for(let count=0;count<12;count++) {
      const result=await reconcileNextPayment(pool,circle,readers.cashReader,readers.receiptReader,config.BUSINESS_ID);
      jsonLog({stage:"durable-reconciliation",...result});
      if(result.status==="SETTLED" || result.status==="FAILED") return;
      if(result.status==="NO_UNRESOLVED" || (result.status==="WAITING" && result.reason==="PROVIDER_ID_UNAVAILABLE")) break;
      await setTimeout(5000);
    }
    jsonLog({stage:"unresolved",intentId,message:"No settlement confirmed. Holds remain durable; do not create a replacement payment."});
    process.exitCode=2;
  } finally {await pool.end();}
}
try {await main();} catch {jsonLog({ok:false,error:"SMOKE_NOT_COMPLETED",message:"Check explicit testnet setup, durable intent, dispatch setting and a maximum amount of 1 USDC. No automatic retry."});process.exitCode=1;}
