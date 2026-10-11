import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { isExactApprovalValid, microUsdcStringSchema, treasuryPolicySchema, ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "@agentpay/core";

const reservationEvidenceSchema = z.strictObject({
  cashBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  capturedAt: z.iso.datetime(),
  ledgerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  feeEvidenceReference: z.string().trim().min(1).max(500)
});
const reservationRequestSchema = z.strictObject({
  businessId: z.string().trim().min(1).max(500),
  obligationId: z.uuid(),
  decisionId: z.uuid(),
  actorId: z.string().trim().min(1).max(500),
  feeAllowanceMicroUsdc: microUsdcStringSchema,
  evidence: reservationEvidenceSchema,
  now: z.iso.datetime()
});
export type ReservationRequest = z.infer<typeof reservationRequestSchema>;

export class ReservationConflict extends Error {
  constructor(readonly code:
    | "RESERVATION_INVALID_REQUEST"
    | "RESERVATION_STALE_EVIDENCE"
    | "RESERVATION_NOT_ELIGIBLE"
    | "RESERVATION_APPROVAL_REQUIRED"
    | "RESERVATION_APPROVAL_INVALID"
    | "RESERVATION_ALREADY_ACTIVE"
    | "RESERVATION_TREASURY_BUSY") {
    super(code);
    this.name = "ReservationConflict";
  }
}

const freshEvidence = (capturedAt: string, now: string) => {
  const age = Date.parse(now) - Date.parse(capturedAt);
  return age >= 0 && age <= 30_000;
};

export function reservationFingerprint(terms: unknown): string {
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex");
}

/** Creates one immutable intent and its held payout/fee reservation. This function never calls a provider. */
export async function reservePayment(pool: Pool, rawRequest: unknown): Promise<{ intentId: string; reservationId: string; providerIdempotencyKey: string }> {
  const request = reservationRequestSchema.safeParse(rawRequest);
  if (!request.success) throw new ReservationConflict("RESERVATION_INVALID_REQUEST");
  const input = request.data;
  if (!freshEvidence(input.evidence.capturedAt, input.now)) throw new ReservationConflict("RESERVATION_STALE_EVIDENCE");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const treasury = await client.query<{ wallet_id: string; chain_id: number; token_address: string; paused: boolean; policy: unknown }>(
      `SELECT wallet_id, chain_id, token_address, paused, policy
       FROM ap_treasuries WHERE business_id = $1 FOR UPDATE`, [input.businessId]);
    const treasuryRow = treasury.rows[0];
    if (!treasuryRow) throw new ReservationConflict("RESERVATION_NOT_ELIGIBLE");
    if (treasuryRow.paused) throw new ReservationConflict("RESERVATION_NOT_ELIGIBLE");
    if (treasuryRow.chain_id !== ARC_CHAIN_ID || treasuryRow.token_address !== ARC_USDC_ADDRESS) {
      throw new ReservationConflict("RESERVATION_NOT_ELIGIBLE");
    }

    const obligation = await client.query<{
      version: number; status: string; amount: string; vendor_id: string; purchase_order_id: string;
      vendor_address: string; vendor_address_version: number; purchase_order_version: number; category: string;
      decision_id: string; action: string; candidate: unknown; decision_expires_at: Date; policy_version: number;
    }>(`SELECT o.version, o.status, o.amount_micro_usdc::text AS amount, o.vendor_id, o.purchase_order_id,
        v.address AS vendor_address, v.address_version AS vendor_address_version, po.version AS purchase_order_version, v.category,
        d.id AS decision_id, d.action, d.candidate, d.expires_at AS decision_expires_at, d.policy_version
      FROM ap_obligations o
      JOIN ap_vendors v ON v.business_id = o.business_id AND v.id = o.vendor_id
      JOIN ap_purchase_orders po ON po.business_id = o.business_id AND po.id = o.purchase_order_id
      JOIN ap_decisions d ON d.business_id = o.business_id AND d.obligation_id = o.id
      WHERE o.business_id = $1 AND o.id = $2 AND d.id = $3
      FOR UPDATE OF o, v, po, d`, [input.businessId, input.obligationId, input.decisionId]);
    const row = obligation.rows[0];
    if (!row || row.status !== "OPEN" || row.decision_id !== input.decisionId || Date.parse(row.decision_expires_at.toISOString()) <= Date.parse(input.now)) {
      throw new ReservationConflict("RESERVATION_NOT_ELIGIBLE");
    }
    const candidate = z.strictObject({ id: z.string(), action: z.enum(["PAY_NOW", "SCHEDULE", "HOLD", "REQUIRE_APPROVAL", "REJECT"]), amountMicroUsdc: microUsdcStringSchema, executeAt: z.iso.datetime().nullable(), evidenceIds: z.array(z.string()) }).safeParse(row.candidate);
    if ((!candidate.success && row.action !== "REQUIRE_APPROVAL")
      || !["PAY_NOW", "SCHEDULE", "REQUIRE_APPROVAL"].includes(row.action)
      || (candidate.success && (candidate.data.amountMicroUsdc !== row.amount || candidate.data.action !== row.action
        || (candidate.data.executeAt !== null && Date.parse(candidate.data.executeAt) > Date.parse(input.now))))) {
      throw new ReservationConflict("RESERVATION_NOT_ELIGIBLE");
    }

    const approval = await client.query<{ id: string; terms: unknown; actor_id: string; role: string; granted: boolean; reason: string; granted_at: Date; expires_at: Date; consumed_at: Date | null }>(
      `SELECT id, terms, actor_id, role, granted, reason, granted_at, expires_at, consumed_at
       FROM ap_approvals WHERE business_id = $1 AND decision_id = $2 ORDER BY granted_at DESC LIMIT 1`,
      [input.businessId, input.decisionId]);
    let validApprovalId: string | null = null;
    const policy = treasuryPolicySchema.safeParse(treasuryRow.policy);
    if (row.action === "REQUIRE_APPROVAL" || !policy.success || BigInt(row.amount) > BigInt(policy.data.autoPayMaxMicroUsdc)) {
      const approvalRow = approval.rows[0];
      const terms = { businessId: input.businessId, obligationId: input.obligationId, decisionId: input.decisionId,
        walletId: treasuryRow.wallet_id, obligationVersion: row.version, vendorId: row.vendor_id,
        vendorAddressVersion: row.vendor_address_version, purchaseOrderId: row.purchase_order_id,
        purchaseOrderVersion: row.purchase_order_version, policyVersion: row.policy_version,
        recipient: row.vendor_address, amountMicroUsdc: row.amount, chainId: ARC_CHAIN_ID, token: ARC_USDC_ADDRESS };
      if (!approvalRow) throw new ReservationConflict("RESERVATION_APPROVAL_REQUIRED");
      if (!isExactApprovalValid({ id: approvalRow.id, terms: approvalRow.terms,
        actorId: approvalRow.actor_id, role: approvalRow.role, granted: approvalRow.granted,
        reason: approvalRow.reason, grantedAt: approvalRow.granted_at.toISOString(),
        expiresAt: approvalRow.expires_at.toISOString(), consumedAt: approvalRow.consumed_at?.toISOString() ?? null }, terms, input.now)) {
        throw new ReservationConflict("RESERVATION_APPROVAL_INVALID");
      }
      validApprovalId = approvalRow.id;
    }
    const existing = await client.query("SELECT 1 FROM ap_payment_intents WHERE business_id = $1 AND obligation_id = $2 AND state IN ('RESERVED','SUBMITTING','PENDING','UNKNOWN','SETTLED') LIMIT 1", [input.businessId, input.obligationId]);
    if (existing.rowCount) throw new ReservationConflict("RESERVATION_ALREADY_ACTIVE");
    const active = await client.query("SELECT 1 FROM ap_payment_intents WHERE business_id = $1 AND state IN ('RESERVED','SUBMITTING','PENDING','UNKNOWN') LIMIT 1", [input.businessId]);
    if (active.rowCount) throw new ReservationConflict("RESERVATION_TREASURY_BUSY");

    const intentId = randomUUID(), reservationId = randomUUID(), providerIdempotencyKey = randomUUID();
    const terms = { businessId: input.businessId, obligationId: input.obligationId, decisionId: input.decisionId,
      walletId: treasuryRow.wallet_id, recipient: row.vendor_address, amountMicroUsdc: row.amount,
      feeAllowanceMicroUsdc: input.feeAllowanceMicroUsdc, chainId: ARC_CHAIN_ID, token: ARC_USDC_ADDRESS,
      vendorId: row.vendor_id, vendorAddressVersion: row.vendor_address_version,
      purchaseOrderId: row.purchase_order_id, purchaseOrderVersion: row.purchase_order_version,
      obligationVersion: row.version, policyVersion: row.policy_version, evidence: input.evidence };
    await client.query(`INSERT INTO ap_payment_intents
      (business_id, id, obligation_id, decision_id, approval_id, terms, request_fingerprint,
       provider_idempotency_key, amount_micro_usdc, fee_allowance_micro_usdc, state)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,'RESERVED')`,
      [input.businessId, intentId, input.obligationId, input.decisionId,
        validApprovalId, JSON.stringify(terms), reservationFingerprint(terms), providerIdempotencyKey,
        row.amount, input.feeAllowanceMicroUsdc]);
    await client.query(`INSERT INTO ap_reservations (business_id, intent_id, amount_micro_usdc, fee_micro_usdc, category)
      VALUES ($1,$2,$3,$4,$5)`, [input.businessId, intentId, row.amount, input.feeAllowanceMicroUsdc, row.category]);
    await client.query(`INSERT INTO ap_events (business_id, event_key, actor_id, entity_id, entity_version, event_type, payload)
      VALUES ($1,$2,$3,$4,$5,'PAYMENT_RESERVED',$6::jsonb)`,
      [input.businessId, `reserved:${intentId}`, input.actorId, input.obligationId, row.version,
        JSON.stringify({ intentId, reservationId, providerIdempotencyKey, amountMicroUsdc: row.amount })]);
    await client.query("COMMIT");
    return { intentId, reservationId, providerIdempotencyKey };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}