import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { microUsdcStringSchema } from "@agentpay/core";
import { authorizePayment, PaymentAuthorizationError, type PaymentEvidence } from "./authorization.js";

const requestSchema = z.strictObject({ businessId: z.string().min(1), obligationId: z.uuid(), decisionId: z.uuid(), actorId: z.string().min(1),
  feeAllowanceMicroUsdc: microUsdcStringSchema, now: z.iso.datetime(), evidence: z.strictObject({
    cashBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/), capturedAt: z.iso.datetime(), ledgerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    feeEvidenceReference: z.string().min(1) }) });
export type ReservationRequest = z.infer<typeof requestSchema>;
export class ReservationConflict extends Error {
  constructor(readonly code: string) { super(code); this.name = "ReservationConflict"; }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const reservationFingerprint = (terms: unknown) => createHash("sha256").update(JSON.stringify(canonical(terms))).digest("hex");
export async function reservePayment(pool: Pool, raw: unknown, fresh?: PaymentEvidence) {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new ReservationConflict("RESERVATION_INVALID_REQUEST");
  const input = parsed.data, now = new Date(input.now), age = now.getTime() - Date.parse(input.evidence.capturedAt);
  if (age < 0 || age > 30000) throw new ReservationConflict("RESERVATION_STALE_EVIDENCE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT business_id FROM ap_treasuries WHERE business_id=$1 FOR UPDATE", [input.businessId]);
    const active = await client.query("SELECT 1 FROM ap_payment_intents WHERE business_id=$1 AND state IN ('RESERVED','SUBMITTING','PENDING','UNKNOWN')", [input.businessId]);
    if (active.rowCount) throw new ReservationConflict("RESERVATION_TREASURY_BUSY");
    const authorized = await authorizePayment(client, input.businessId, input.obligationId, input.decisionId, now, fresh);
    if (input.evidence.cashBlockHash!==authorized.evidence.cash.blockHash || input.evidence.capturedAt!==authorized.evidence.cash.capturedAt
      || input.evidence.ledgerFingerprint!==authorized.evidence.fingerprint || input.evidence.feeEvidenceReference!==authorized.evidence.fee.evidenceReference) {
      throw new ReservationConflict("RESERVATION_EVIDENCE_MISMATCH");
    }
    if (authorized.allowance !== input.feeAllowanceMicroUsdc) throw new ReservationConflict("RESERVATION_FEE_MISMATCH");
    const intentId = randomUUID(), providerIdempotencyKey = randomUUID();
    const terms = { ...authorized.terms, walletAddress: authorized.state.treasury.walletAddress,
      feeAllowanceMicroUsdc: authorized.allowance, fee: authorized.fee, evidence: input.evidence };
    await client.query(`INSERT INTO ap_payment_intents (business_id,id,obligation_id,decision_id,approval_id,terms,request_fingerprint,
      provider_idempotency_key,amount_micro_usdc,fee_allowance_micro_usdc,state) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,'RESERVED')`,
    [input.businessId,intentId,input.obligationId,input.decisionId,authorized.approvalId,JSON.stringify(terms),reservationFingerprint(terms),
      providerIdempotencyKey,terms.amountMicroUsdc,authorized.allowance]);
    await client.query("INSERT INTO ap_reservations (business_id,intent_id,amount_micro_usdc,fee_micro_usdc,category) VALUES ($1,$2,$3,$4,$5)",
      [input.businessId,intentId,terms.amountMicroUsdc,authorized.allowance,authorized.category]);
    await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      VALUES ($1,$2,$3,$4,$5,'PAYMENT_RESERVED',$6::jsonb)`, [input.businessId,"reserved:"+intentId,input.actorId,input.obligationId,
      terms.obligationVersion,JSON.stringify({ intentId,providerIdempotencyKey,amountMicroUsdc:terms.amountMicroUsdc,fee:authorized.fee })]);
    await client.query("COMMIT");
    return { intentId, reservationId: intentId, providerIdempotencyKey };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof PaymentAuthorizationError) throw new ReservationConflict(error.code);
    throw error;
  } finally { client.release(); }
}
