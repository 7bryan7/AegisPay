import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { invoiceCommandSchema, invoiceCorrectionSchema, invoiceEvaluationSchema, invoiceMutationResultSchema,
  ownerCorrectionsSchema, type InvoiceCommand, type InvoiceCorrection, type InvoiceEvaluation, type InvoiceMutationResult } from "@agentpay/core";
import { reservationFingerprint } from "../payments/reserve.js";

export class InvoiceReviewError extends Error {
  constructor(readonly code: "NOT_FOUND" | "VERSION_CONFLICT" | "COMMAND_CONFLICT" | "PAYMENT_IN_PROGRESS"
    | "INVOICE_REJECTED" | "INPUT_UNAVAILABLE" | "RESERVATION_CONFLICT", readonly status = 409) { super(code); }
}
export type ReviewContext = { businessId: string; actorId: string };
type ReviewRow = { version: number; status: string; raw_extraction: unknown; owner_corrections: unknown; purchase_order_hint: string | null };

/** Caller holds the treasury lock. Submitted/uncertain payment identity is immutable. */
export async function cancelUnsubmittedPayments(client: PoolClient, businessId: string, obligationId: string,
  actorId: string, reason: string): Promise<void> {
  const intents = (await client.query<{ id: string; state: string }>(`SELECT id,state FROM ap_payment_intents
    WHERE business_id=$1 AND obligation_id=$2 AND state IN ('RESERVED','SUBMITTING','PENDING','UNKNOWN','SETTLED') FOR UPDATE`,
    [businessId, obligationId])).rows;
  if (intents.some((intent) => intent.state !== "RESERVED")) throw new InvoiceReviewError("PAYMENT_IN_PROGRESS");
  for (const intent of intents) {
    await client.query("UPDATE ap_payment_intents SET state='CANCELLED',lease_owner=NULL,lease_expires_at=NULL WHERE business_id=$1 AND id=$2", [businessId, intent.id]);
    const released = await client.query(`UPDATE ap_reservations SET status='RELEASED',finished_at=now()
      WHERE business_id=$1 AND intent_id=$2 AND status='HELD'`, [businessId, intent.id]);
    if (released.rowCount !== 1) throw new InvoiceReviewError("RESERVATION_CONFLICT");
    await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      SELECT business_id,$3,$4,id,version,'PAYMENT_CANCELLED',$5::jsonb FROM ap_obligations WHERE business_id=$1 AND id=$2`,
      [businessId, obligationId, `review-cancel:${intent.id}`, actorId, JSON.stringify({ intentId: intent.id, reason })]);
  }
}

async function mutate(pool: Pool, context: ReviewContext, id: string, action: "CORRECT" | "EVALUATE" | "REJECT",
  input: InvoiceCommand | InvoiceCorrection | InvoiceEvaluation): Promise<InvoiceMutationResult> {
  const client = await pool.connect(), fingerprint = reservationFingerprint({ action, input, actorId: context.actorId });
  try {
    await client.query("BEGIN");
    const treasury = await client.query("SELECT business_id FROM ap_treasuries WHERE business_id=$1 FOR UPDATE", [context.businessId]);
    if (!treasury.rowCount) throw new InvoiceReviewError("NOT_FOUND", 404);
    const previous = (await client.query<{ fingerprint: string; result: unknown }>(`SELECT fingerprint,result FROM ap_invoice_commands
      WHERE business_id=$1 AND obligation_id=$2 AND command_id=$3`, [context.businessId, id, input.commandId])).rows[0];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new InvoiceReviewError("COMMAND_CONFLICT");
      await client.query("COMMIT"); return invoiceMutationResultSchema.parse(previous.result);
    }
    const row = (await client.query<ReviewRow>(`SELECT version,status,raw_extraction,owner_corrections,purchase_order_hint
      FROM ap_obligations WHERE business_id=$1 AND id=$2 FOR UPDATE`, [context.businessId, id])).rows[0];
    if (!row) throw new InvoiceReviewError("NOT_FOUND", 404);
    if (row.version !== input.expectedVersion) throw new InvoiceReviewError("VERSION_CONFLICT");
    if (row.status === "REJECTED" && action !== "CORRECT") throw new InvoiceReviewError("INVOICE_REJECTED");
    if (action === "EVALUATE" && "reextract" in input && input.reextract) {
      const image = await client.query("SELECT 1 FROM ap_inputs WHERE business_id=$1 AND obligation_id=$2", [context.businessId, id]);
      if (!image.rowCount) throw new InvoiceReviewError("INPUT_UNAVAILABLE", 422);
    }
    await cancelUnsubmittedPayments(client, context.businessId, id, context.actorId, input.reason);
    const version = row.version + 1;
    const corrections = ownerCorrectionsSchema.parse({ ...ownerCorrectionsSchema.parse(row.owner_corrections),
      ...(action === "CORRECT" && "fields" in input ? input.fields : {}) });
    const reextract = action === "EVALUATE" && "reextract" in input && input.reextract;
    const status = action === "REJECT" ? "REJECTED" : reextract || row.raw_extraction === null ? "RECEIVED" : "OPEN";
    await client.query(`INSERT INTO ap_invoice_revisions (business_id,obligation_id,version,actor_id,action,reason,raw_extraction,corrections)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, [context.businessId, id, version, context.actorId, action, input.reason,
      JSON.stringify(row.raw_extraction), JSON.stringify(corrections)]);
    // Clearing the fencing token prevents an old model call from committing.
    // Old immutable decisions/approvals remain as evidence and fail the new version checks.
    await client.query(`UPDATE ap_obligations SET version=$3,status=$4,owner_corrections=$5::jsonb,
      raw_extraction=CASE WHEN $6 THEN NULL ELSE raw_extraction END,
      normalized=NULL,
      lease_owner=NULL,lease_expires_at=NULL,next_evaluation_at=now()
      WHERE business_id=$1 AND id=$2`, [context.businessId, id, version, status, JSON.stringify(corrections), reextract]);
    const result = invoiceMutationResultSchema.parse({ obligationId: id, version, status });
    await client.query(`INSERT INTO ap_invoice_commands (business_id,obligation_id,command_id,fingerprint,result)
      VALUES ($1,$2,$3,$4,$5::jsonb)`, [context.businessId, id, input.commandId, fingerprint, JSON.stringify(result)]);
    await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [context.businessId, `review:${randomUUID()}`, context.actorId, id, version,
      `INVOICE_${action === "CORRECT" ? "CORRECTED" : action === "REJECT" ? "REJECTED" : "EVALUATION_REQUESTED"}`,
      JSON.stringify({ commandId: input.commandId, reason: input.reason, previousVersion: row.version,
        correctedFields: action === "CORRECT" && "fields" in input ? Object.keys(input.fields) : [], reextract })]);
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export const correctInvoice = (pool: Pool, context: ReviewContext, id: string, input: unknown) =>
  mutate(pool, context, id, "CORRECT", invoiceCorrectionSchema.parse(input));
export const evaluateInvoice = (pool: Pool, context: ReviewContext, id: string, input: unknown) =>
  mutate(pool, context, id, "EVALUATE", invoiceEvaluationSchema.parse(input));
export const rejectInvoice = (pool: Pool, context: ReviewContext, id: string, input: unknown) =>
  mutate(pool, context, id, "REJECT", invoiceCommandSchema.parse(input));
