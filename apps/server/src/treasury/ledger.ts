import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, arcAddressSchema, payableVendorSchema, purchaseOrderSchema,
  paymentLedgerSchema, treasuryPolicySchema } from "@agentpay/core";

export const planningStateSchema = z.object({
  treasury: z.object({ businessId: z.string(), walletId: z.string(), walletAddress: arcAddressSchema,
    chainId: z.literal(ARC_CHAIN_ID), tokenAddress: z.literal(ARC_USDC_ADDRESS),
    mode: z.enum(["disabled", "fixture", "arc_testnet"]), paused: z.boolean(),
    policy: treasuryPolicySchema, policyVersion: z.number().int().positive() }),
  vendors: z.array(payableVendorSchema).max(100000), purchaseOrders: z.array(purchaseOrderSchema).max(100000),
  payments: z.array(paymentLedgerSchema).max(100000), validBindings: z.literal(true)
});
export type PlanningState = z.infer<typeof planningStateSchema>;
export const planningFingerprint = (state: PlanningState) => createHash("sha256").update(JSON.stringify(state)).digest("hex");

/** One statement gives a consistent PostgreSQL snapshot. All holds and all settlements are
 * included, without UI pagination or period cutoffs. The 100001st record fails validation.
 * Stored receipt JSON is deliberately NOT trusted as fresh cash-inclusion verification.
 */
export async function readPlanningState(db: Pool | PoolClient, businessId: string): Promise<PlanningState> {
  const result = await db.query<{ state: unknown }>(`SELECT jsonb_build_object(
    'treasury', jsonb_build_object('businessId', t.business_id, 'walletId', t.wallet_id,
      'walletAddress', t.wallet_address, 'chainId', t.chain_id, 'tokenAddress', t.token_address,
      'mode', t.payment_mode, 'paused', t.paused, 'policy', t.policy, 'policyVersion', t.policy_version),
    'vendors', COALESCE((SELECT jsonb_agg(x.data ORDER BY x.id) FROM (SELECT v.id,
      jsonb_build_object('businessId', v.business_id, 'id', v.id, 'name', v.name, 'aliases', v.aliases,
        'status', v.status, 'address', v.address, 'addressVersion', v.address_version, 'chainId', v.chain_id,
        'category', v.category, 'settlementCurrency', v.settlement_currency,
        'settlementAgreementReference', v.settlement_agreement_reference, 'verificationReference', v.verification_reference) AS data
      FROM ap_vendors v WHERE v.business_id = $1 ORDER BY v.id LIMIT 100001) x), '[]'::jsonb),
    'purchaseOrders', COALESCE((SELECT jsonb_agg(x.data ORDER BY x.id) FROM (SELECT p.id,
      jsonb_build_object('businessId', p.business_id, 'id', p.id, 'vendorId', p.vendor_id, 'version', p.version,
        'amountMicroUsdc', p.amount_micro_usdc::text, 'outstandingMicroUsdc', p.outstanding_micro_usdc::text,
        'deliveryAccepted', p.delivery_accepted, 'acceptanceReference', p.acceptance_reference,
        'description', p.description, 'dueDate', p.due_date::text,
        'activeObligationId', (SELECT o.id FROM ap_obligations o WHERE o.business_id = p.business_id
          AND o.purchase_order_id = p.id AND o.status <> 'REJECTED' LIMIT 1)) AS data
      FROM ap_purchase_orders p WHERE p.business_id = $1 ORDER BY p.id LIMIT 100001) x), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(x.data ORDER BY x.id) FROM (SELECT i.id,
      jsonb_build_object('businessId', i.business_id, 'intentId', i.id, 'obligationId', i.obligation_id,
        'purchaseOrderId', i.terms->>'purchaseOrderId', 'category', r.category,
        'recipient', i.terms->>'recipient', 'amountMicroUsdc', i.amount_micro_usdc::text,
        'feeAllowanceMicroUsdc', i.fee_allowance_micro_usdc::text, 'state', i.state,
        'reservationState', r.status,
        'reservedAt', to_char(r.reserved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'settledAt', to_char(i.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'transactionHash', i.transaction_hash, 'providerId', i.provider_id, 'providerState', i.provider_state,
        'terminalEvidenceReference', NULL, 'receipt', NULL) AS data
      FROM ap_payment_intents i LEFT JOIN ap_reservations r ON r.business_id = i.business_id AND r.intent_id = i.id
      WHERE i.business_id = $1 ORDER BY i.id LIMIT 100001) x), '[]'::jsonb),
    'validBindings', NOT EXISTS (SELECT 1 FROM ap_payment_intents i
      LEFT JOIN ap_reservations r ON r.business_id = i.business_id AND r.intent_id = i.id
      WHERE i.business_id = $1 AND (r.intent_id IS NULL OR r.amount_micro_usdc <> i.amount_micro_usdc
        OR r.fee_micro_usdc <> i.fee_allowance_micro_usdc
        OR (i.terms->>'businessId') IS DISTINCT FROM i.business_id
        OR (i.terms->>'obligationId') IS DISTINCT FROM i.obligation_id::text
        OR (i.terms->>'amountMicroUsdc') IS DISTINCT FROM i.amount_micro_usdc::text
        OR (i.terms->>'walletId') IS DISTINCT FROM t.wallet_id
        OR (i.terms->>'chainId') IS DISTINCT FROM t.chain_id::text
        OR (i.terms->>'token') IS DISTINCT FROM t.token_address))) AS state
    FROM ap_treasuries t WHERE t.business_id = $1`, [businessId]);
  return planningStateSchema.parse(result.rows[0]?.state);
}
