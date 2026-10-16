import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ARC_USDC_ADDRESS, createVendorSchema, createPurchaseOrderSchema, updateVendorSchema, updatePurchaseOrderSchema,
  updatePolicySchema, vendorRecordSchema, purchaseOrderSchema, policyViewSchema, vendorListSchema, purchaseOrderListSchema,
  compareVerifiedDiscount, type CreateVendor, type UpdateVendor, type CreatePurchaseOrder, type UpdatePurchaseOrder, type UpdatePolicy } from "@agentpay/core";
import { cancelUnsubmittedPayments, type ReviewContext } from "../obligations/review.js";

export class AdministrationError extends Error {
  constructor(readonly code: "NOT_FOUND" | "VERSION_CONFLICT" | "RECORD_EXISTS" | "INVALID_RECIPIENT" | "INVALID_EVIDENCE"
    | "PAYMENT_IN_PROGRESS" | "PURCHASE_ORDER_CONSUMED", readonly status = 409) { super(code); }
}
const vendorSelect = `SELECT jsonb_build_object('businessId',v.business_id,'id',v.id,'name',v.name,'aliases',v.aliases,
  'status',v.status,'address',v.address,'addressVersion',v.address_version,'chainId',v.chain_id,'category',v.category,
  'settlementCurrency',v.settlement_currency,'settlementAgreementReference',v.settlement_agreement_reference,
  'verificationReference',v.verification_reference,'verifiedAt',to_char(v.verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS data
  FROM ap_vendors v WHERE v.business_id=$1`;
const poSelect = `SELECT jsonb_build_object('businessId',p.business_id,'id',p.id,'vendorId',p.vendor_id,'version',p.version,
  'amountMicroUsdc',p.amount_micro_usdc::text,'outstandingMicroUsdc',p.outstanding_micro_usdc::text,
  'deliveryAccepted',p.delivery_accepted,'acceptanceReference',p.acceptance_reference,'description',p.description,'dueDate',p.due_date::text,'servicePeriod',p.service_period,'essential',p.essential,'verifiedDiscount',p.verified_discount,
  'activeObligationId',(SELECT id FROM ap_obligations WHERE business_id=p.business_id AND purchase_order_id=p.id AND status<>'REJECTED' LIMIT 1)) AS data
  FROM ap_purchase_orders p WHERE p.business_id=$1`;

async function invalidate(client: PoolClient, context: ReviewContext, reason: string, vendorId: string | null, poId: string | null) {
  const rows = (await client.query<{ id: string; version: number }>(`SELECT o.id,o.version FROM ap_obligations o WHERE o.business_id=$1
    AND o.status IN ('RECEIVED','EXTRACTING','OPEN') AND ($2::text IS NULL OR o.vendor_id=$2)
    AND ($3::text IS NULL OR o.purchase_order_id=$3) AND NOT EXISTS (SELECT 1 FROM ap_payment_intents i
      WHERE i.business_id=o.business_id AND i.obligation_id=o.id AND i.state IN ('SUBMITTING','PENDING','UNKNOWN','SETTLED')) FOR UPDATE`,
    [context.businessId, vendorId, poId])).rows;
  for (const row of rows) {
    await cancelUnsubmittedPayments(client, context.businessId, row.id, context.actorId, reason);
    await client.query(`UPDATE ap_obligations SET version=version+1,normalized=NULL,lease_owner=NULL,lease_expires_at=NULL,next_evaluation_at=now()
      WHERE business_id=$1 AND id=$2`, [context.businessId, row.id]);
    await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      VALUES ($1,$2,$3,$4,$5,'AUTHORIZATION_INVALIDATED',$6::jsonb)`,
      [context.businessId, `invalidate:${randomUUID()}`, context.actorId, row.id, row.version + 1, JSON.stringify({ reason })]);
  }
}
async function record(client: PoolClient, context: ReviewContext, kind: string, id: string, version: number,
  reason: string, previous: unknown, current: unknown) {
  await client.query(`INSERT INTO ap_registry_revisions (business_id,kind,entity_id,version,actor_id,reason,previous_record,record)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
    [context.businessId, kind, id, version, context.actorId, reason, JSON.stringify(previous), JSON.stringify(current)]);
  await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [context.businessId, `registry:${randomUUID()}`, context.actorId, id, version,
    `${kind}_UPDATED`, JSON.stringify({ reason, version })]);
}
async function transaction<T>(pool: Pool, context: ReviewContext, work: (client: PoolClient, wallet: string) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const treasury = (await client.query<{ wallet_address: string }>("SELECT wallet_address FROM ap_treasuries WHERE business_id=$1 FOR UPDATE", [context.businessId])).rows[0];
    if (!treasury) throw new AdministrationError("NOT_FOUND", 404);
    const result = await work(client, treasury.wallet_address);
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export function createAdministration(pool: Pool) {
  return {
    async vendors(businessId: string, offset = 0) {
      const rows = (await pool.query<{ data: unknown }>(vendorSelect + " ORDER BY v.id LIMIT 26 OFFSET $2", [businessId, offset])).rows;
      return vendorListSchema.parse({ vendors: rows.slice(0, 25).map((row) => row.data), nextOffset: rows.length > 25 ? offset + 25 : null });
    },
    async purchaseOrders(businessId: string, offset = 0) {
      const rows = (await pool.query<{ data: unknown }>(poSelect + " ORDER BY p.id LIMIT 26 OFFSET $2", [businessId, offset])).rows;
      return purchaseOrderListSchema.parse({ purchaseOrders: rows.slice(0, 25).map((row) => row.data), nextOffset: rows.length > 25 ? offset + 25 : null });
    },
    async policy(businessId: string) {
      const row = (await pool.query<{ policy: unknown; version: number }>("SELECT policy,policy_version AS version FROM ap_treasuries WHERE business_id=$1", [businessId])).rows[0];
      if (!row) throw new AdministrationError("NOT_FOUND", 404);
      return policyViewSchema.parse(row);
    },
    async saveVendor(context: ReviewContext, id: string | null, raw: CreateVendor | UpdateVendor) {
      const input = id === null ? createVendorSchema.parse(raw) : updateVendorSchema.parse(raw);
      return transaction(pool, context, async (client, wallet) => {
        const vendorId = id ?? (input as CreateVendor).id;
        const existing = (await client.query<{ data: unknown }>(vendorSelect + " AND v.id=$2 FOR UPDATE", [context.businessId, vendorId])).rows[0];
        const previous = existing ? vendorRecordSchema.parse(existing.data) : null;
        if (id === null && previous) throw new AdministrationError("RECORD_EXISTS");
        if (id !== null && !previous) throw new AdministrationError("NOT_FOUND", 404);
        if (previous && (!("expectedVersion" in input) || input.expectedVersion !== previous.addressVersion)) throw new AdministrationError("VERSION_CONFLICT");
        const current = vendorRecordSchema.strip().parse({ ...previous, ...input, businessId: context.businessId, id: vendorId,
          addressVersion: previous ? previous.addressVersion + 1 : 1 });
        if (current.address === wallet || current.address === ARC_USDC_ADDRESS) throw new AdministrationError("INVALID_RECIPIENT", 422);
        if (Date.parse(current.verifiedAt) > Date.now()) throw new AdministrationError("INVALID_EVIDENCE", 422);
        await client.query(`INSERT INTO ap_vendors (business_id,id,name,aliases,status,address,address_version,chain_id,category,
          settlement_currency,settlement_agreement_reference,verification_reference,verified_at)
          VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (business_id,id) DO UPDATE SET name=$3,aliases=$4::jsonb,status=$5,address=$6,address_version=$7,
          chain_id=$8,category=$9,settlement_currency=$10,settlement_agreement_reference=$11,verification_reference=$12,verified_at=$13`,
          [context.businessId, vendorId, current.name, JSON.stringify(current.aliases), current.status, current.address, current.addressVersion,
            current.chainId, current.category, current.settlementCurrency, current.settlementAgreementReference, current.verificationReference, current.verifiedAt]);
        await invalidate(client, context, input.reason, previous ? vendorId : null, null);
        await record(client, context, "VENDOR", vendorId, current.addressVersion, input.reason, previous, current);
        return current;
      });
    },
    async savePurchaseOrder(context: ReviewContext, id: string | null, raw: CreatePurchaseOrder | UpdatePurchaseOrder) {
      const input = id === null ? createPurchaseOrderSchema.parse(raw) : updatePurchaseOrderSchema.parse(raw);
      return transaction(pool, context, async (client) => {
        const poId = id ?? (input as CreatePurchaseOrder).id;
        const existing = (await client.query<{ data: unknown }>(poSelect + " AND p.id=$2 FOR UPDATE OF p", [context.businessId, poId])).rows[0];
        const previous = existing ? purchaseOrderSchema.parse(existing.data) : null;
        if (id === null && previous) throw new AdministrationError("RECORD_EXISTS");
        if (id !== null && !previous) throw new AdministrationError("NOT_FOUND", 404);
        if (previous && (!("expectedVersion" in input) || input.expectedVersion !== previous.version)) throw new AdministrationError("VERSION_CONFLICT");
        const protectedPayment = await client.query(`SELECT 1 FROM ap_payment_intents WHERE business_id=$1 AND terms->>'purchaseOrderId'=$2
          AND state IN ('SUBMITTING','PENDING','UNKNOWN','SETTLED')`, [context.businessId, poId]);
        if (protectedPayment.rowCount) throw new AdministrationError("PAYMENT_IN_PROGRESS");
        if (previous && previous.outstandingMicroUsdc !== previous.amountMicroUsdc) throw new AdministrationError("PURCHASE_ORDER_CONSUMED");
        const amount = "amountMicroUsdc" in input && input.amountMicroUsdc ? input.amountMicroUsdc : previous?.amountMicroUsdc;
        const current = purchaseOrderSchema.strip().parse({ ...previous, ...input, id: poId, businessId: context.businessId,
          version: previous ? previous.version + 1 : 1, amountMicroUsdc: amount, outstandingMicroUsdc: amount,
          activeObligationId: previous?.activeObligationId ?? null });
        if (current.verifiedDiscount && compareVerifiedDiscount({ nominalAmountMicroUsdc: current.amountMicroUsdc,
          dueDate: current.dueDate, terms: current.verifiedDiscount, now: new Date().toISOString() }).status === "INVALID")
          throw new AdministrationError("INVALID_EVIDENCE", 422);
        if (current.deliveryAccepted && !current.acceptanceReference) throw new AdministrationError("INVALID_EVIDENCE", 422);
        if (!(await client.query("SELECT 1 FROM ap_vendors WHERE business_id=$1 AND id=$2", [context.businessId, current.vendorId])).rowCount)
          throw new AdministrationError("INVALID_EVIDENCE", 422);
        if (previous?.activeObligationId && previous.vendorId !== current.vendorId) throw new AdministrationError("INVALID_EVIDENCE", 422);
        await client.query(`INSERT INTO ap_purchase_orders (business_id,id,vendor_id,version,amount_micro_usdc,outstanding_micro_usdc,
          delivery_accepted,acceptance_reference,description,due_date,essential,verified_discount,service_period) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
          ON CONFLICT (business_id,id) DO UPDATE SET vendor_id=$3,version=$4,amount_micro_usdc=$5,outstanding_micro_usdc=$5,
          delivery_accepted=$6,acceptance_reference=$7,description=$8,due_date=$9,essential=$10,verified_discount=$11::jsonb,service_period=$12`,
          [context.businessId, poId, current.vendorId, current.version, current.amountMicroUsdc, current.deliveryAccepted,
            current.acceptanceReference, current.description, current.dueDate, current.essential ?? true, current.verifiedDiscount ? JSON.stringify(current.verifiedDiscount) : null, current.servicePeriod ?? null]);
        await invalidate(client, context, input.reason, null, previous ? poId : null);
        await record(client, context, "PURCHASE_ORDER", poId, current.version, input.reason, previous, current);
        return current;
      });
    },
    async savePolicy(context: ReviewContext, raw: UpdatePolicy) {
      const input = updatePolicySchema.parse(raw);
      return transaction(pool, context, async (client) => {
        const previous = (await client.query<{ policy: unknown; version: number }>("SELECT policy,policy_version AS version FROM ap_treasuries WHERE business_id=$1", [context.businessId])).rows[0]!;
        if (previous.version !== input.expectedVersion) throw new AdministrationError("VERSION_CONFLICT");
        const current = policyViewSchema.parse({ policy: input.policy, version: previous.version + 1 });
        await client.query("UPDATE ap_treasuries SET policy=$2::jsonb,policy_version=$3 WHERE business_id=$1", [context.businessId, JSON.stringify(current.policy), current.version]);
        await invalidate(client, context, input.reason, null, null);
        await record(client, context, "POLICY", context.businessId, current.version, input.reason, previous, current);
        return current;
      });
    }
  };
}
export type Administration = ReturnType<typeof createAdministration>;

/** Current independently maintained records linked by the stored invoice, scoped to its owner. */
export async function readInvoiceRegistry(pool: Pool, businessId: string, invoiceId: string) {
  const [vendor,po]=await Promise.all([
    pool.query<{data:unknown}>(vendorSelect+" AND v.id=(SELECT vendor_id FROM ap_obligations WHERE business_id=$1 AND id=$2)",[businessId,invoiceId]),
    pool.query<{data:unknown}>(poSelect+" AND p.id=(SELECT purchase_order_id FROM ap_obligations WHERE business_id=$1 AND id=$2)",[businessId,invoiceId])
  ]);
  return {vendor:vendor.rows[0]?vendorRecordSchema.parse(vendor.rows[0].data):null,purchaseOrder:po.rows[0]?purchaseOrderSchema.parse(po.rows[0].data):null};
}
