import type { Pool } from "pg";
import { paymentAmounts, approvalOfferSchema, approvalTermsSchema } from "@agentpay/core";
import { reservationFingerprint } from "../payments/reserve.js";

/** Read-only offer for client confirmation. Dispatch still reconstructs all terms. */
export async function readApprovalOffer(pool: Pool, businessId: string, id: string, version: number) {
  const row = (await pool.query<{ planned_amount: string | null; terms: unknown; expires_at: Date; due_date: string; verified_discount: unknown; policy: { annualCashPreservationCostBps?: number } }>(`SELECT jsonb_build_object(
    'businessId',o.business_id,'obligationId',o.id,'decisionId',d.id,'walletId',t.wallet_id,'obligationVersion',o.version,
    'vendorId',v.id,'vendorAddressVersion',v.address_version,'purchaseOrderId',p.id,'purchaseOrderVersion',p.version,
    'policyVersion',t.policy_version,'recipient',v.address,'amountMicroUsdc',o.amount_micro_usdc::text,
    'chainId',t.chain_id,'token',t.token_address) AS terms,d.evaluated_at+interval '24 hours' AS expires_at,o.due_date::text,p.verified_discount,t.policy,d.treasury_snapshot->'fee'->>'amountMicroUsdc' AS planned_amount
    FROM ap_obligations o JOIN ap_treasuries t ON t.business_id=o.business_id
    JOIN ap_vendors v ON v.business_id=o.business_id AND v.id=o.vendor_id
    JOIN ap_purchase_orders p ON p.business_id=o.business_id AND p.id=o.purchase_order_id
    JOIN LATERAL (SELECT * FROM ap_decisions WHERE business_id=o.business_id AND obligation_id=o.id ORDER BY evaluated_at DESC,id DESC LIMIT 1) d ON true
    WHERE o.business_id=$1 AND o.id=$2 AND o.version=$3 AND o.status='OPEN' AND o.lease_owner IS NULL AND o.normalized IS NOT NULL
    AND d.action='REQUIRE_APPROVAL' AND d.obligation_version=o.version AND d.policy_version=t.policy_version
    AND d.vendor_address_version=v.address_version AND d.purchase_order_version=p.version AND v.status='APPROVED' AND p.delivery_accepted
    AND d.evaluated_at+interval '24 hours'>now() AND NOT EXISTS (SELECT 1 FROM ap_approvals a WHERE a.business_id=o.business_id AND a.decision_id=d.id)
    AND NOT EXISTS (SELECT 1 FROM ap_payment_intents i WHERE i.business_id=o.business_id AND i.obligation_id=o.id
      AND i.state IN ('RESERVED','SUBMITTING','PENDING','UNKNOWN','SETTLED'))`, [businessId, id, version])).rows[0];
  if (!row) return null;
  const base = approvalTermsSchema.parse(row.terms);
  let amounts;
  try { amounts = paymentAmounts(base.amountMicroUsdc, row.due_date, row.verified_discount, new Date().toISOString(), row.policy.annualCashPreservationCostBps); }
  catch { return null; }
  if (row.planned_amount !== amounts.amountMicroUsdc) return null;
  const terms = approvalTermsSchema.parse({ ...base, ...amounts });
  return approvalOfferSchema.parse({ decisionId: terms.decisionId, expectedVersion: terms.obligationVersion,
    termsHash: reservationFingerprint(terms), expiresAt: new Date(Math.min(row.expires_at.getTime(), amounts.discountExpiresAt ? Date.parse(amounts.discountExpiresAt) : Infinity)).toISOString(), terms });
}
