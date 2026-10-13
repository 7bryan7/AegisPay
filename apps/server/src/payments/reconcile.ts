import type { Pool } from "pg";
import type { z } from "zod";
import { cashEvidenceSchema, paymentLedgerSchema, ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@agentpay/core";
import type { CircleExpectedTerms, CircleTransactionStatus } from "./circle.js";
import { createArcCashReader } from "./arc.js";
import { createArcReceiptReader } from "./arc-receipt.js";
import { storedPaymentTermsSchema } from "./dispatch.js";
import { reservationFingerprint } from "./reserve.js";

export type CircleStatusReader = { getStatus(providerId: string, expected?: CircleExpectedTerms): Promise<CircleTransactionStatus> };
export type ArcCashReader = { read(): Promise<z.infer<typeof cashEvidenceSchema>> };
export type ArcReceiptVerifier = { verify(request: unknown): Promise<unknown> };
type UnresolvedIntent = { business_id: string; id: string; obligation_id: string; provider_id: string | null;
  provider_state: string | null; terms: unknown; request_fingerprint: string; amount_micro_usdc: string };
const receiptEvidenceSchema = paymentLedgerSchema.shape.receipt.unwrap();
export type ReconcileResult = { status: "NO_UNRESOLVED" }
  | { status: "WAITING"; intentId: string; reason: string }
  | { status: "FAILED"; intentId: string; providerState: string }
  | { status: "SETTLED"; intentId: string; transactionHash: string };

export function createArcReconciliationFromEnvironment(environment: NodeJS.ProcessEnv): { cashReader: ArcCashReader; receiptReader: ArcReceiptVerifier } | null {
  if (environment.PAYMENT_MODE !== "arc_testnet" || !environment.ARC_RPC_URL || !environment.CIRCLE_WALLET_ID) return null;
  try {
    const config = { mode: "arc_testnet" as const, chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS,
      walletAddress: environment.ARC_WALLET_ADDRESS ?? "", rpcUrl: environment.ARC_RPC_URL } as const;
    return { cashReader: createArcCashReader(config), receiptReader: createArcReceiptReader(config) };
  } catch { return null; }
}

async function finish(pool: Pool, intent: UnresolvedIntent, receipt: z.infer<typeof receiptEvidenceSchema>, success: boolean): Promise<boolean> {
  const client = await pool.connect();
  const terms = storedPaymentTermsSchema.parse(intent.terms);
  const requireOne = (count: number | null) => { if (count !== 1) throw new Error("SETTLEMENT_CONFLICT"); };
  try {
    await client.query("BEGIN");
    await client.query("SELECT business_id FROM ap_treasuries WHERE business_id=$1 FOR UPDATE", [intent.business_id]);
    const current = (await client.query<{ approval_id: string | null; state: string; version: number }>(`SELECT i.approval_id,i.state,o.version
      FROM ap_payment_intents i JOIN ap_obligations o ON o.business_id=i.business_id AND o.id=i.obligation_id
      WHERE i.business_id=$1 AND i.id=$2 AND i.provider_id=$3 AND i.request_fingerprint=$4 FOR UPDATE OF i,o`,
      [intent.business_id,intent.id,intent.provider_id,intent.request_fingerprint])).rows[0];
    if (!current || !["PENDING","UNKNOWN"].includes(current.state)) { await client.query("ROLLBACK"); return false; }
    if (success) {
      requireOne((await client.query(`UPDATE ap_purchase_orders SET outstanding_micro_usdc=outstanding_micro_usdc-$3::numeric
        WHERE business_id=$1 AND id=$2 AND outstanding_micro_usdc=$3::numeric`,
        [intent.business_id,terms.purchaseOrderId,terms.amountMicroUsdc])).rowCount);
      requireOne((await client.query("UPDATE ap_obligations SET status='SETTLED',next_evaluation_at=now() WHERE business_id=$1 AND id=$2 AND status='OPEN'",
        [intent.business_id,intent.obligation_id])).rowCount);
      if (current.approval_id) requireOne((await client.query("UPDATE ap_approvals SET consumed_at=now() WHERE business_id=$1 AND id=$2 AND consumed_at IS NULL",
        [intent.business_id,current.approval_id])).rowCount);
    } else {
      await client.query("UPDATE ap_obligations SET next_evaluation_at=now()+interval '5 minutes' WHERE business_id=$1 AND id=$2",[intent.business_id,intent.obligation_id]);
    }
    requireOne((await client.query(`UPDATE ap_reservations SET status=$3,finished_at=now() WHERE business_id=$1 AND intent_id=$2 AND status='HELD'`,
      [intent.business_id,intent.id,success?"CONSUMED":"RELEASED"])).rowCount);
    requireOne((await client.query(`UPDATE ap_payment_intents SET state=$3,provider_state=$4,transaction_hash=$5,receipt_evidence=$6::jsonb,
      actual_fee_micro_usdc=$7,settled_at=CASE WHEN $3='SETTLED' THEN now() ELSE NULL END,
      failure_evidence=CASE WHEN $3='FAILED' THEN $6::jsonb ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL
      WHERE business_id=$1 AND id=$2 AND state IN ('PENDING','UNKNOWN')`,
      [intent.business_id,intent.id,success?"SETTLED":"FAILED",success?"COMPLETE":"FAILED",receipt.transactionHash,JSON.stringify(receipt),receipt.actualFeeMicroUsdc])).rowCount);
    await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      VALUES ($1,$2,'payment-worker',$3,$4,$5,$6::jsonb)`,[intent.business_id,"terminal:"+intent.id,intent.obligation_id,current.version,
      success?"PAYMENT_SETTLED":"PAYMENT_FAILED",JSON.stringify({intentId:intent.id,providerId:intent.provider_id,transactionHash:receipt.transactionHash,
        actualFeeMicroUsdc:receipt.actualFeeMicroUsdc,verificationReference:receipt.verificationReference})]);
    await client.query("COMMIT"); return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

/** A provider terminal result plus a fresh, independently matched finalized receipt is required. */
export async function reconcileNextPayment(pool: Pool, circle: CircleStatusReader, cashReader: ArcCashReader,
  receiptReader: ArcReceiptVerifier, businessId: string): Promise<ReconcileResult> {
  const row = (await pool.query<UnresolvedIntent>(`SELECT i.business_id,i.id,i.obligation_id,i.provider_id,i.provider_state,
    i.terms,i.request_fingerprint,i.amount_micro_usdc::text FROM ap_payment_intents i
    WHERE i.business_id=$1 AND i.state IN ('PENDING','UNKNOWN') ORDER BY i.created_at,i.id LIMIT 1`,[businessId])).rows[0];
  if (!row) return {status:"NO_UNRESOLVED"};
  const waiting = (reason: string): ReconcileResult => ({status:"WAITING",intentId:row.id,reason});
  if (!row.provider_id) return waiting("PROVIDER_ID_UNAVAILABLE");
  const parsed = storedPaymentTermsSchema.safeParse(row.terms);
  if (!parsed.success || reservationFingerprint(row.terms)!==row.request_fingerprint) return waiting("INTENT_TERMS_REQUIRE_REVIEW");
  const terms = parsed.data;
  if (terms.businessId!==businessId || terms.obligationId!==row.obligation_id || terms.amountMicroUsdc!==row.amount_micro_usdc) return waiting("INTENT_TERMS_MISMATCH");
  let provider: CircleTransactionStatus;
  try { provider=await circle.getStatus(row.provider_id,{walletId:terms.walletId,recipient:terms.recipient,
    amountMicroUsdc:terms.amountMicroUsdc,chainId:terms.chainId,tokenAddress:terms.token}); }
  catch { return waiting("CIRCLE_UNAVAILABLE"); }
  if (provider.providerId!==row.provider_id) return waiting("PROVIDER_ID_MISMATCH");
  const success=provider.providerState==="COMPLETE", failed=provider.providerState==="FAILED";
  if (!success && !failed) return waiting(["DENIED","CANCELLED"].includes(provider.providerState)?"FAILURE_EVIDENCE_REQUIRED":"PROVIDER_PENDING");
  if (!provider.transactionHash) return waiting(failed?"FAILURE_EVIDENCE_REQUIRED":"ARC_RECEIPT_UNAVAILABLE");
  try {
    const cash=cashEvidenceSchema.parse(await cashReader.read());
    const receipt=receiptEvidenceSchema.parse(await receiptReader.verify({cash,transactionHash:provider.transactionHash,
      recipient:terms.recipient,amountMicroUsdc:terms.amountMicroUsdc}));
    const age=Date.now()-Date.parse(cash.capturedAt);
    if (age<0 || age>30000 || cash.walletAddress!==terms.walletAddress || receipt.walletAddress!==terms.walletAddress
      || receipt.cashBlockHash!==cash.blockHash || receipt.transactionHash!==provider.transactionHash || receipt.recipient!==terms.recipient
      || receipt.amountMicroUsdc!==(success?terms.amountMicroUsdc:"0") || receipt.outcome!==(success?"SUCCESS":"REVERTED")
      || BigInt(receipt.blockNumber)>BigInt(cash.blockNumber) || (receipt.blockNumber===cash.blockNumber && receipt.blockHash!==cash.blockHash)
      || (receipt.actualFeeNative!==undefined && (BigInt(receipt.actualFeeNative)+999_999_999_999n)/1_000_000_000_000n!==BigInt(receipt.actualFeeMicroUsdc))) {
      return waiting("ARC_RECEIPT_TERMS_MISMATCH");
    }
    if (!await finish(pool,row,receipt,success)) return waiting("SETTLEMENT_STATE_CHANGED");
    return success?{status:"SETTLED",intentId:row.id,transactionHash:receipt.transactionHash}:{status:"FAILED",intentId:row.id,providerState:"FAILED"};
  } catch { return waiting("ARC_RECEIPT_OR_SETTLEMENT_UNAVAILABLE"); }
}
