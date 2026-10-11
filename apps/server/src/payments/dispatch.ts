import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import type { CircleTransactionStatus, CircleTransferResult } from "./circle.js";
import { createCircleTransferAdapter } from "./circle.js";

export type CircleTransferAdapter = { submit(request: unknown): Promise<CircleTransferResult> };
export type CircleProvider = CircleTransferAdapter & { getStatus(providerId: string): Promise<CircleTransactionStatus> };
type ClaimedIntent = {
  business_id: string; id: string; obligation_id: string; decision_id: string; provider_idempotency_key: string;
  wallet_id: string; recipient: string; amount_micro_usdc: string; chain_id: number; token_address: string;
};
const termsSchema = z.strictObject({
  businessId: z.string(), obligationId: z.string(), decisionId: z.string(), walletId: z.string(), recipient: z.string(),
  amountMicroUsdc: z.string(), chainId: z.number(), token: z.string(), feeAllowanceMicroUsdc: z.string(),
  vendorId: z.string(), vendorAddressVersion: z.number(), purchaseOrderId: z.string(), purchaseOrderVersion: z.number(),
  obligationVersion: z.number(), policyVersion: z.number(), evidence: z.record(z.string(), z.unknown())
});

export type DispatchResult =
  | { status: "NO_RESERVED" }
  | { status: "PENDING"; intentId: string; providerId: string; providerState: string }
  | { status: "FAILED"; intentId: string; providerState: string }
  | { status: "UNKNOWN"; intentId: string; reason: string };

async function markUnknown(pool: Pool, intent: ClaimedIntent, leaseOwner: string, reason: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE ap_payment_intents SET state = 'UNKNOWN', provider_state = NULL,
      lease_owner = NULL, lease_expires_at = NULL, failure_evidence = $4::jsonb
      WHERE business_id = $1 AND id = $2 AND state = 'SUBMITTING' AND lease_owner = $3`,
      [intent.business_id, intent.id, leaseOwner, JSON.stringify({ code: reason })]);
    await client.query(`INSERT INTO ap_events (business_id, event_key, actor_id, entity_id, entity_version, event_type, payload)
      VALUES ($1,$2,'payment-worker',$3,1,'PAYMENT_UNKNOWN',$4::jsonb)`,
      [intent.business_id, `unknown:${intent.id}:${leaseOwner}`, intent.id, JSON.stringify({ reason })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/** Marks SUBMITTING before calling Circle. Provider uncertainty never releases the reservation. */
export async function dispatchNextPayment(pool: Pool, adapter: CircleTransferAdapter, businessId: string): Promise<DispatchResult> {
  const leaseOwner = randomUUID();
  const client = await pool.connect();
  let intent: ClaimedIntent;
  try {
    await client.query("BEGIN");
    const result = await client.query<ClaimedIntent>(`SELECT i.business_id, i.id, i.obligation_id, i.decision_id,
        i.provider_idempotency_key::text AS provider_idempotency_key,
        i.terms->>'walletId' AS wallet_id, i.terms->>'recipient' AS recipient,
        i.amount_micro_usdc::text AS amount_micro_usdc, i.terms->>'chainId' AS chain_id,
        i.terms->>'token' AS token_address
      FROM ap_payment_intents i
      WHERE i.business_id = $1 AND i.state = 'RESERVED'
        AND (i.lease_expires_at IS NULL OR i.lease_expires_at <= now())
      ORDER BY i.created_at, i.id FOR UPDATE SKIP LOCKED LIMIT 1`, [businessId]);
    const claimed = result.rows[0];
    if (!claimed) { await client.query("ROLLBACK"); return { status: "NO_RESERVED" }; }
    intent = claimed;
    await client.query(`UPDATE ap_payment_intents SET state = 'SUBMITTING', submitted_at = COALESCE(submitted_at, now()),
      lease_owner = $3, lease_expires_at = now() + interval '2 minutes'
      WHERE business_id = $1 AND id = $2 AND state = 'RESERVED'`, [businessId, intent.id, leaseOwner]);
    await client.query(`INSERT INTO ap_events (business_id, event_key, actor_id, entity_id, entity_version, event_type, payload)
      VALUES ($1,$2,'payment-worker',$3,1,'PAYMENT_SUBMITTING',$4::jsonb)`,
      [businessId, `submitting:${intent.id}:${leaseOwner}`, intent.id, JSON.stringify({ intentId: intent.id })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  try {
    const terms = termsSchema.parse({ businessId, obligationId: intent.obligation_id, decisionId: intent.decision_id,
      walletId: intent.wallet_id, recipient: intent.recipient, amountMicroUsdc: intent.amount_micro_usdc,
      chainId: Number(intent.chain_id), token: intent.token_address, feeAllowanceMicroUsdc: "0",
      vendorId: "stored", vendorAddressVersion: 1, purchaseOrderId: "stored", purchaseOrderVersion: 1,
      obligationVersion: 1, policyVersion: 1, evidence: {} });
    const response = await adapter.submit({ walletId: terms.walletId, providerIdempotencyKey: intent.provider_idempotency_key,
      recipient: terms.recipient, amountMicroUsdc: terms.amountMicroUsdc, chainId: terms.chainId, tokenAddress: terms.token });
    const terminalFailure = ["FAILED", "CANCELLED"].includes(response.providerState.toUpperCase());
    const update = await pool.query(`UPDATE ap_payment_intents SET state = $4, provider_id = $3, provider_state = $5,
      lease_owner = NULL, lease_expires_at = NULL, failure_evidence = CASE WHEN $4 = 'FAILED' THEN $6::jsonb ELSE NULL END
      WHERE business_id = $1 AND id = $2 AND state = 'SUBMITTING' AND lease_owner = $7`,
      [businessId, intent.id, response.providerId, terminalFailure ? "FAILED" : "PENDING", response.providerState,
        JSON.stringify({ code: "CIRCLE_TERMINAL_FAILURE", providerState: response.providerState }), leaseOwner]);
    if (update.rowCount !== 1) return { status: "UNKNOWN", intentId: intent.id, reason: "DISPATCH_LEASE_LOST" };
    if (terminalFailure) {
      await pool.query("UPDATE ap_reservations SET status = 'RELEASED', finished_at = now() WHERE business_id = $1 AND intent_id = $2 AND status = 'HELD'", [businessId, intent.id]);
    }
    return terminalFailure ? { status: "FAILED", intentId: intent.id, providerState: response.providerState }
      : { status: "PENDING", intentId: intent.id, providerId: response.providerId, providerState: response.providerState };
  } catch (error) {
    const reason = error instanceof Error && error.name === "CircleTransferError" ? error.message : "CIRCLE_UNAVAILABLE";
    await markUnknown(pool, intent, leaseOwner, reason);
    return { status: "UNKNOWN", intentId: intent.id, reason };
  }
}

export function createCircleAdapterFromEnvironment(environment: NodeJS.ProcessEnv): CircleProvider | null {
  if (!environment.CIRCLE_API_KEY || !environment.CIRCLE_ENTITY_SECRET || !environment.CIRCLE_WALLET_ID) return null;
  try { return createCircleTransferAdapter({ apiKey: environment.CIRCLE_API_KEY, entitySecret: environment.CIRCLE_ENTITY_SECRET, walletId: environment.CIRCLE_WALLET_ID }); }
  catch { return null; }
}