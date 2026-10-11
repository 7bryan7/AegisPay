import type { Pool } from "pg";
import { auditSchema, invoiceDetailSchema, invoiceListSchema, invoiceSummarySchema, microUsdcStringSchema,
  type AuditView, type InvoiceDetail, type InvoiceList, type TreasuryView } from "@agentpay/core";
import { ingestObligation } from "../obligations/ingest.js";
import type { ApClaims } from "./session.js";

export interface ApStore {
  ready(businessId: string): Promise<boolean>;
  list(businessId: string, offset: number): Promise<InvoiceList>;
  detail(businessId: string, id: string): Promise<InvoiceDetail | null>;
  audit(businessId: string, id: string): Promise<AuditView | null>;
  image(businessId: string, id: string): Promise<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" } | null>;
  treasury(businessId: string): Promise<Pick<TreasuryView, "walletAddress" | "paused" | "holdsMicroUsdc" | "minimumReserveMicroUsdc"> | null>;
  upload(claims: ApClaims, key: string, hint: string | null, bytes: Buffer, mime: string): Promise<{ obligationId: string; status: string; reused: boolean }>;
  approve(businessId: string, actorId: string, id: string, decisionId: string, reason: string): Promise<{ approvalId: string; expiresAt: string }>;
}

type InvoiceRow = {
  id: string; status: string; version: number; invoice_number: string | null; vendor_name: string | null;
  amount: string | null; due_date: string | null; created_at: Date; action: string | null; payment_state: string | null;
  normalized: unknown; decision_view: unknown; payment_view: unknown;
};
export class ApprovalConflict extends Error {
  constructor(readonly code: "APPROVAL_NOT_ELIGIBLE" | "APPROVAL_ALREADY_EXISTS") {
    super(code);
    this.name = "ApprovalConflict";
  }
}
const invoiceSelect = `SELECT o.id, o.status, o.version, o.normalized_invoice_number AS invoice_number,
  v.name AS vendor_name, o.amount_micro_usdc::text AS amount, o.due_date::text, o.created_at, o.normalized,
  d.action, p.state AS payment_state,
  CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id', d.id, 'action', d.action,
    'reason', d.reason, 'evidenceIds', d.evidence_ids,
    'evaluatedAt', to_char(d.evaluated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END AS decision_view,
  CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('state', p.state, 'providerId', p.provider_id,
    'providerState', p.provider_state, 'transactionHash', p.transaction_hash,
    'settledAt', to_char(p.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'actualFeeMicroUsdc', p.actual_fee_micro_usdc::text,
    'verificationReference', p.receipt_evidence->>'verificationReference') END AS payment_view
  FROM ap_obligations o LEFT JOIN ap_vendors v ON v.business_id = o.business_id AND v.id = o.vendor_id
  LEFT JOIN LATERAL (SELECT * FROM ap_decisions WHERE business_id = o.business_id AND obligation_id = o.id
    ORDER BY evaluated_at DESC, id DESC LIMIT 1) d ON true
  LEFT JOIN LATERAL (SELECT * FROM ap_payment_intents WHERE business_id = o.business_id AND obligation_id = o.id
    ORDER BY created_at DESC, id DESC LIMIT 1) p ON true`;
function summary(row: InvoiceRow) {
  return invoiceSummarySchema.parse({ id: row.id, status: row.status, version: row.version,
    invoiceNumber: row.invoice_number, vendorName: row.vendor_name, amountMicroUsdc: row.amount,
    dueDate: row.due_date, createdAt: row.created_at.toISOString(), decision: row.action, paymentState: row.payment_state });
}

export function createApStore(pool: Pool, retentionHours: number): ApStore {
  return {
    async ready(businessId) {
      const result = await pool.query("SELECT business_id FROM ap_treasuries WHERE business_id = $1", [businessId]);
      return result.rowCount === 1;
    },
    async list(businessId, offset) {
      const result = await pool.query<InvoiceRow>(`${invoiceSelect} WHERE o.business_id = $1 ORDER BY o.created_at DESC, o.id DESC LIMIT 26 OFFSET $2`, [businessId, offset]);
      return invoiceListSchema.parse({ invoices: result.rows.slice(0, 25).map(summary), nextOffset: result.rows.length > 25 ? offset + 25 : null });
    },
    async detail(businessId, id) {
      const result = await pool.query<InvoiceRow>(`${invoiceSelect} WHERE o.business_id = $1 AND o.id = $2`, [businessId, id]);
      const row = result.rows[0];
      if (!row) return null;
      return invoiceDetailSchema.parse({ invoice: summary(row), facts: row.normalized, decision: row.decision_view, payment: row.payment_view,
        processingMessage: row.status === "RECEIVED" || row.status === "EXTRACTING"
          ? "Image saved and queued for extraction. Processing requires the configured extraction worker. No payment has been initiated by this upload."
          : "Stored evaluation decision. Scheduling rechecks funding when due; eligible decisions are not transfers. Payment dispatch remains disabled." });
    },
    async audit(businessId, id) {
      if (!(await pool.query("SELECT id FROM ap_obligations WHERE business_id = $1 AND id = $2", [businessId, id])).rowCount) return null;
      // Deliberate allowlist: never export raw payloads, model output, credentials or images.
      const result = await pool.query<{ event_key: string; event_type: string; entity_version: number; created_at: Date }>(
        "SELECT event_key, event_type, entity_version, created_at FROM ap_events WHERE business_id = $1 AND entity_id = $2 ORDER BY created_at, event_key LIMIT 500", [businessId, id]);
      return auditSchema.parse({ events: result.rows.map((row) => ({ key: row.event_key, type: row.event_type, version: row.entity_version, createdAt: row.created_at.toISOString() })) });
    },
    async image(businessId, id) {
      const result = await pool.query<{ image_bytes: Buffer; mime_type: "image/png" | "image/jpeg" }>(
        "SELECT image_bytes, mime_type FROM ap_inputs WHERE business_id = $1 AND obligation_id = $2", [businessId, id]);
      const row = result.rows[0];
      return row ? { bytes: row.image_bytes, mimeType: row.mime_type } : null;
    },
    async treasury(businessId) {
      const result = await pool.query<{ wallet_address: string; paused: boolean; reserve: unknown; holds: string }>(`SELECT wallet_address, paused,
        policy->>'minReserveMicroUsdc' AS reserve,
        (SELECT COALESCE(sum(amount_micro_usdc + fee_micro_usdc), 0)::text FROM ap_reservations WHERE business_id = $1 AND status = 'HELD') AS holds
        FROM ap_treasuries WHERE business_id = $1`, [businessId]);
      const row = result.rows[0];
      if (!row) return null;
      const reserve = microUsdcStringSchema.safeParse(row.reserve);
      return { walletAddress: row.wallet_address, paused: row.paused, holdsMicroUsdc: row.holds,
        minimumReserveMicroUsdc: reserve.success ? reserve.data : null };
    },
    async upload(claims, key, hint, bytes, mime) {
      if (claims.role !== "OPERATOR") throw new Error("OPERATOR_REQUIRED");
      return ingestObligation(pool, { businessId: claims.businessId, actorId: claims.actorId, role: "OPERATOR",
        idempotencyKey: key, purchaseOrderHint: hint }, bytes, mime, retentionHours);
    }
    , async approve(businessId, actorId, id, decisionId, reason) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{
          obligation_version: number; decision_id: string; action: string; policy_version: number;
          vendor_id: string; vendor_address: string; vendor_address_version: number;
          purchase_order_id: string; purchase_order_version: number; amount: string;
          wallet_id: string; chain_id: number; token_address: string; decision_expires_at: Date;
        }>(`SELECT o.version AS obligation_version, d.id AS decision_id, d.action, d.policy_version,
          o.vendor_id, v.address AS vendor_address, v.address_version AS vendor_address_version,
          o.purchase_order_id, po.version AS purchase_order_version, o.amount_micro_usdc::text AS amount,
          t.wallet_id, t.chain_id, t.token_address
          FROM ap_obligations o
          JOIN ap_decisions d ON d.business_id = o.business_id AND d.obligation_id = o.id
          JOIN ap_vendors v ON v.business_id = o.business_id AND v.id = o.vendor_id
          JOIN ap_purchase_orders po ON po.business_id = o.business_id AND po.id = o.purchase_order_id
          JOIN ap_treasuries t ON t.business_id = o.business_id
          WHERE o.business_id = $1 AND o.id = $2 AND d.id = $3
          ORDER BY d.evaluated_at DESC FOR UPDATE OF o, v, po, t`, [businessId, id, decisionId]);
        const row = result.rows[0];
        if (!row || row.decision_id !== decisionId || row.action !== "REQUIRE_APPROVAL" || row.decision_expires_at <= new Date()) throw new ApprovalConflict("APPROVAL_NOT_ELIGIBLE");
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const terms = { businessId, obligationId: id, decisionId, walletId: row.wallet_id,
          obligationVersion: row.obligation_version, vendorId: row.vendor_id,
          vendorAddressVersion: row.vendor_address_version, purchaseOrderId: row.purchase_order_id,
          purchaseOrderVersion: row.purchase_order_version, policyVersion: row.policy_version,
          recipient: row.vendor_address, amountMicroUsdc: row.amount, chainId: row.chain_id,
          token: row.token_address };
        const { createHash, randomUUID } = await import("node:crypto");
        const approvalId = randomUUID();
        const termsHash = createHash("sha256").update(JSON.stringify(terms)).digest("hex");
        await client.query(`INSERT INTO ap_approvals
          (business_id, id, obligation_id, decision_id, terms, terms_hash, actor_id, role, granted, reason, granted_at, expires_at)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'OPERATOR',true,$8,$9,$10)`,
          [businessId, approvalId, id, decisionId, JSON.stringify(terms), termsHash, actorId, reason, now.toISOString(), expiresAt.toISOString()]);
        await client.query(`INSERT INTO ap_events (business_id, event_key, actor_id, entity_id, entity_version, event_type, payload)
          VALUES ($1,$2,$3,$4,$5,'APPROVAL_GRANTED',$6::jsonb)`,
          [businessId, `approval:${approvalId}`, actorId, id, row.obligation_version,
            JSON.stringify({ approvalId, decisionId, expiresAt: expiresAt.toISOString() })]);
          await client.query("UPDATE ap_obligations SET next_evaluation_at = now() WHERE business_id = $1 AND id = $2 AND status = 'OPEN'", [businessId, id]);
        await client.query("COMMIT");
        return { approvalId, expiresAt: expiresAt.toISOString() };
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
  };
}
