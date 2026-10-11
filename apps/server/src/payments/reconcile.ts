import type { Pool } from "pg";
import { z } from "zod";
import type { cashEvidenceSchema } from "@agentpay/core";
import type { CircleTransactionStatus } from "./circle.js";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@agentpay/core";
import { createArcCashReader } from "./arc.js";
import { createArcReceiptReader } from "./arc-receipt.js";

export type CircleStatusReader = { getStatus(providerId: string): Promise<CircleTransactionStatus> };
export type ArcCashReader = { read(): Promise<z.infer<typeof cashEvidenceSchema>> };
export type ArcReceiptVerifier = { verify(request: unknown): Promise<unknown> };
type UnresolvedIntent = { business_id: string; id: string; obligation_id: string; provider_id: string | null; provider_state: string | null; wallet_id: string; recipient: string; amount_micro_usdc: string };
const receiptEvidenceSchema = z.object({ transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/), amountMicroUsdc: z.string(), actualFeeMicroUsdc: z.string(), outcome: z.literal("SUCCESS"), verificationReference: z.string().min(1) });

export type ReconcileResult =
  | { status: "NO_UNRESOLVED" }
  | { status: "WAITING"; intentId: string; reason: string }
  | { status: "FAILED"; intentId: string; providerState: string }
  | { status: "SETTLED"; intentId: string; transactionHash: string };

export function createArcReconciliationFromEnvironment(environment: NodeJS.ProcessEnv): { cashReader: ArcCashReader; receiptReader: ArcReceiptVerifier } | null {
  if (!environment.ARC_RPC_URL || !environment.CIRCLE_WALLET_ID) return null;
  try {
    const config = { mode: "arc_testnet" as const, chainId: ARC_CHAIN_ID, tokenAddress: ARC_USDC_ADDRESS,
      walletAddress: environment.ARC_WALLET_ADDRESS ?? "", rpcUrl: environment.ARC_RPC_URL } as const;
    return { cashReader: createArcCashReader(config), receiptReader: createArcReceiptReader(config) };
  } catch { return null; }
}

async function markProviderFailure(pool: Pool, intent: UnresolvedIntent, providerState: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE ap_payment_intents SET state = 'FAILED', provider_state = $3, failure_evidence = $4::jsonb,
      lease_owner = NULL, lease_expires_at = NULL WHERE business_id = $1 AND id = $2 AND state IN ('PENDING','UNKNOWN')`,
      [intent.business_id, intent.id, providerState, JSON.stringify({ code: "CIRCLE_TERMINAL_FAILURE", providerState })]);
    await client.query("UPDATE ap_reservations SET status = 'RELEASED', finished_at = now() WHERE business_id = $1 AND intent_id = $2 AND status = 'HELD'", [intent.business_id, intent.id]);
    await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      VALUES ($1,$2,'payment-worker',$3,1,'PAYMENT_FAILED',$4::jsonb)`,
      [intent.business_id, `failed:${intent.id}:${providerState}`, intent.id, JSON.stringify({ providerState })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function settle(pool: Pool, intent: UnresolvedIntent, provider: CircleTransactionStatus, receipt: z.infer<typeof receiptEvidenceSchema>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ approval_id: string | null; purchase_order_id: string; amount: string }>(`SELECT i.approval_id,
        o.purchase_order_id, i.amount_micro_usdc::text AS amount
      FROM ap_payment_intents i JOIN ap_obligations o ON o.business_id = i.business_id AND o.id = i.obligation_id
      WHERE i.business_id = $1 AND i.id = $2 AND i.state IN ('PENDING','UNKNOWN') FOR UPDATE OF i, o`, [intent.business_id, intent.id]);
    const row = current.rows[0];
    if (!row || provider.providerState !== "COMPLETE" || provider.transactionHash !== receipt.transactionHash || receipt.amountMicroUsdc !== row.amount) {
      await client.query("ROLLBACK"); return;
    }
    await client.query(`UPDATE ap_payment_intents SET state = 'SETTLED', provider_state = 'COMPLETE', transaction_hash = $3,
      receipt_evidence = $4::jsonb, actual_fee_micro_usdc = $5, settled_at = now(), lease_owner = NULL, lease_expires_at = NULL
      WHERE business_id = $1 AND id = $2 AND state IN ('PENDING','UNKNOWN')`,
      [intent.business_id, intent.id, receipt.transactionHash, JSON.stringify(receipt), receipt.actualFeeMicroUsdc]);
    await client.query(`UPDATE ap_reservations SET status = 'CONSUMED', finished_at = now()
      WHERE business_id = $1 AND intent_id = $2 AND status = 'HELD'`, [intent.business_id, intent.id]);
    await client.query(`UPDATE ap_purchase_orders SET outstanding_micro_usdc = 0
      WHERE business_id = $1 AND id = $2 AND outstanding_micro_usdc >= $3::ap_micro_usdc`, [intent.business_id, row.purchase_order_id, row.amount]);
    await client.query("UPDATE ap_obligations SET status = 'SETTLED', next_evaluation_at = now() WHERE business_id = $1 AND id = $2", [intent.business_id, intent.obligation_id]);
    if (row.approval_id) await client.query("UPDATE ap_approvals SET consumed_at = now() WHERE business_id = $1 AND id = $2 AND consumed_at IS NULL", [intent.business_id, row.approval_id]);
    await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      VALUES ($1,$2,'payment-worker',$3,1,'PAYMENT_SETTLED',$4::jsonb)`,
      [intent.business_id, `settled:${intent.id}`, intent.id, JSON.stringify({ providerId: provider.providerId, transactionHash: receipt.transactionHash, verificationReference: receipt.verificationReference })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/** Provider COMPLETE plus independently matched Arc receipt is the only settlement gate. */
export async function reconcileNextPayment(pool: Pool, circle: CircleStatusReader, cashReader: ArcCashReader,
  receiptReader: ArcReceiptVerifier, businessId: string): Promise<ReconcileResult> {
  const row = (await pool.query<UnresolvedIntent>(`SELECT i.business_id, i.id, i.obligation_id, i.provider_id, i.provider_state,
      i.terms->>'walletId' AS wallet_id, i.terms->>'recipient' AS recipient, i.amount_micro_usdc::text AS amount_micro_usdc
    FROM ap_payment_intents i WHERE i.business_id = $1 AND i.state IN ('PENDING','UNKNOWN')
    ORDER BY i.created_at, i.id LIMIT 1`, [businessId])).rows[0];
  if (!row) return { status: "NO_UNRESOLVED" };
  if (!row.provider_id) return { status: "WAITING", intentId: row.id, reason: "PROVIDER_ID_UNAVAILABLE" };
  let provider: CircleTransactionStatus;
  try { provider = await circle.getStatus(row.provider_id); }
  catch { return { status: "WAITING", intentId: row.id, reason: "CIRCLE_UNAVAILABLE" }; }
  if (["FAILED", "CANCELLED", "DENIED", "STUCK"].includes(provider.providerState.toUpperCase())) {
    await markProviderFailure(pool, row, provider.providerState);
    return { status: "FAILED", intentId: row.id, providerState: provider.providerState };
  }
  if (provider.providerState.toUpperCase() !== "COMPLETE" || !provider.transactionHash) {
    await pool.query("UPDATE ap_payment_intents SET provider_state = $3, state = CASE WHEN state = 'UNKNOWN' THEN 'PENDING' ELSE state END WHERE business_id = $1 AND id = $2 AND state IN ('PENDING','UNKNOWN')", [businessId, row.id, provider.providerState]);
    return { status: "WAITING", intentId: row.id, reason: "PROVIDER_PENDING" };
  }
  try {
    const cash = await cashReader.read();
    const rawReceipt = await receiptReader.verify({ cash, transactionHash: provider.transactionHash, recipient: row.recipient, amountMicroUsdc: row.amount_micro_usdc });
    const receipt = receiptEvidenceSchema.parse(rawReceipt);
    await settle(pool, row, provider, receipt);
    return { status: "SETTLED", intentId: row.id, transactionHash: receipt.transactionHash };
  } catch (error) {
    return { status: "WAITING", intentId: row.id, reason: error instanceof Error ? error.name : "ARC_RECEIPT_UNAVAILABLE" };
  }
}