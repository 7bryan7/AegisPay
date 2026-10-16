import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { compareVerifiedDiscount, enrollmentSchema, type Enrollment } from "@agentpay/core";
import { z } from "zod";

const contextSchema = z.strictObject({
  businessId: z.string().trim().min(1).max(500), actorId: z.string().trim().min(1).max(500),
  role: z.literal("OPERATOR"), paymentMode: z.enum(["disabled", "fixture", "arc_testnet"])
});
export type EnrollmentContext = z.infer<typeof contextSchema>;
export class EnrollmentConflict extends Error {
  constructor() { super("ENROLLMENT_CONFLICT"); }
}
export function validateEnrollment(context: EnrollmentContext, raw: unknown): Enrollment {
  const trusted = contextSchema.parse(context);
  const manifest = enrollmentSchema.parse(raw);
  if (manifest.businessId !== trusted.businessId || manifest.treasury.paymentMode !== trusted.paymentMode) {
    throw new Error("ENROLLMENT_CONTEXT_MISMATCH");
  }
  if (manifest.vendors.some((vendor) => Date.parse(vendor.verifiedAt) > Date.now())) throw new Error("FUTURE_VERIFICATION_DATE");
  for (const po of manifest.purchaseOrders) if (po.verifiedDiscount && compareVerifiedDiscount({
    nominalAmountMicroUsdc: po.amountMicroUsdc, dueDate: po.dueDate, terms: po.verifiedDiscount,
    now: new Date().toISOString() }).status === "INVALID") throw new Error("INVALID_DISCOUNT_TERMS");
  return manifest;
}

/** CLI/operator-only bootstrap: insert missing records, accept exact retries, never update existing terms.
 * Context is trusted server/CLI configuration. This function is not an authentication boundary.
 */
export async function enrollPayables(pool: Pool, context: EnrollmentContext, raw: unknown) {
  const manifest = validateEnrollment(context, raw);
  const { businessId, treasury } = manifest;
  const client = await pool.connect();
  const inserted = { treasuries: 0, vendors: 0, purchaseOrders: 0 };
  try {
    await client.query("BEGIN");
    // Serializes creation before a stable treasury row exists, then follows the normal lock order.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ap-enrollment:${businessId}`]);
    const existingTreasury = await client.query<{ terms: unknown }>(`SELECT jsonb_build_object(
      'walletId',wallet_id,'walletAddress',wallet_address,'chainId',chain_id,'tokenAddress',token_address,
      'paymentMode',payment_mode,'policy',policy) AS terms FROM ap_treasuries WHERE business_id = $1 FOR UPDATE`, [businessId]);
    if (existingTreasury.rows[0]) {
      if (!isDeepStrictEqual(existingTreasury.rows[0].terms, treasury)) throw new EnrollmentConflict();
      // A prior provenance marker must agree; unmarked/manual treasuries require explicit review.
      const provenance = await client.query<{ kind: string }>(`SELECT payload->>'kind' AS kind FROM ap_events
        WHERE business_id = $1 AND event_key = 'treasury-enrolled'`, [businessId]);
      if (provenance.rows[0]?.kind !== manifest.kind) throw new EnrollmentConflict();
    } else {
      await client.query(`INSERT INTO ap_treasuries (business_id,wallet_id,wallet_address,chain_id,token_address,payment_mode,policy,paused)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,true)`,
      [businessId, treasury.walletId, treasury.walletAddress, treasury.chainId, treasury.tokenAddress, treasury.paymentMode, JSON.stringify(treasury.policy)]);
      inserted.treasuries++;
    }
    for (const vendor of manifest.vendors) {
      const existing = await client.query<{ terms: unknown }>(`SELECT jsonb_build_object(
        'businessId',business_id,'id',id,'name',name,'aliases',aliases,'status',status,'address',address,
        'addressVersion',address_version,'chainId',chain_id,'category',category,'settlementCurrency',settlement_currency,
        'settlementAgreementReference',settlement_agreement_reference,'verificationReference',verification_reference,
        'verifiedAt',to_char(verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS terms
        FROM ap_vendors WHERE business_id = $1 AND id = $2 FOR UPDATE`, [businessId, vendor.id]);
      if (existing.rows[0]) {
        if (!isDeepStrictEqual(existing.rows[0].terms, vendor)) throw new EnrollmentConflict();
      } else {
        await client.query(`INSERT INTO ap_vendors (business_id,id,name,aliases,status,address,address_version,chain_id,category,
          settlement_currency,settlement_agreement_reference,verification_reference,verified_at)
          VALUES ($1,$2,$3,$4::jsonb,$5,$6,1,$7,$8,$9,$10,$11,$12)`,
        [businessId,vendor.id,vendor.name,JSON.stringify(vendor.aliases),vendor.status,vendor.address,vendor.chainId,vendor.category,
          vendor.settlementCurrency,vendor.settlementAgreementReference,vendor.verificationReference,vendor.verifiedAt]);
        inserted.vendors++;
      }
    }
    for (const po of manifest.purchaseOrders) {
      const existing = await client.query<{ terms: unknown }>(`SELECT jsonb_build_object(
        'businessId',p.business_id,'id',p.id,'vendorId',p.vendor_id,'version',p.version,
        'amountMicroUsdc',p.amount_micro_usdc::text,'outstandingMicroUsdc',p.outstanding_micro_usdc::text,
        'deliveryAccepted',p.delivery_accepted,'acceptanceReference',p.acceptance_reference,'description',p.description,
        'dueDate',p.due_date::text,'servicePeriod',p.service_period,'essential',p.essential,'verifiedDiscount',p.verified_discount,'activeObligationId',NULL) AS terms
        FROM ap_purchase_orders p WHERE p.business_id = $1 AND p.id = $2 FOR UPDATE`, [businessId, po.id]);
      if (existing.rows[0]) {
        // A retry does not release an existing obligation claim; activeObligationId is never written here.
        if (!isDeepStrictEqual(existing.rows[0].terms, { ...po, servicePeriod: po.servicePeriod ?? null, essential: po.essential ?? true, verifiedDiscount: po.verifiedDiscount ?? null })) throw new EnrollmentConflict();
      } else {
        await client.query(`INSERT INTO ap_purchase_orders (business_id,id,vendor_id,version,amount_micro_usdc,
          outstanding_micro_usdc,description,due_date,delivery_accepted,acceptance_reference,essential,verified_discount,service_period)
          VALUES ($1,$2,$3,1,$4,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [businessId,po.id,po.vendorId,po.amountMicroUsdc,po.description,po.dueDate,po.deliveryAccepted,po.acceptanceReference,po.essential ?? true,po.verifiedDiscount ? JSON.stringify(po.verifiedDiscount) : null, po.servicePeriod ?? null]);
        inserted.purchaseOrders++;
      }
    }
    if (inserted.treasuries) {
      await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
        VALUES ($1,'treasury-enrolled',$2,$1,1,'TREASURY_ENROLLED',$3::jsonb)`,
      [businessId,context.actorId,JSON.stringify({ kind: manifest.kind, paused: true, reason: manifest.reason })]);
    }
    if (inserted.treasuries + inserted.vendors + inserted.purchaseOrders > 0) {
      const fingerprint = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
      await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
        VALUES ($1,$2,$3,$1,1,'REGISTRY_ENROLLED',$4::jsonb)`,
      [businessId,`enrollment:${fingerprint}`,context.actorId,JSON.stringify({ kind: manifest.kind, fingerprint, inserted,
        vendorIds: manifest.vendors.map((v) => v.id), purchaseOrderIds: manifest.purchaseOrders.map((p) => p.id), reason: manifest.reason })]);
    }
    await client.query("COMMIT");
    return { inserted, reused: inserted.treasuries + inserted.vendors + inserted.purchaseOrders === 0 };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
