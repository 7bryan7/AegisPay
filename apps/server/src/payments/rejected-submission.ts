import type {Pool} from "pg";
import {z} from "zod";
import {storedPaymentTermsSchema} from "./dispatch.js";
import {reservationFingerprint} from "./reserve.js";

// Trusted, offline operator recovery only. Never call this from the dispatcher or
// infer this evidence from an empty transaction list, timeout or HTTP status alone.
const proofSchema=z.strictObject({
  providerIdempotencyKey:z.uuidv4(), providerRequestId:z.string().regex(/^[a-f0-9]{32}$/),
  requestedAt:z.iso.datetime(), httpStatus:z.literal(400), providerCode:z.literal(2),
  reason:z.literal("TOKEN_ID_AND_BLOCKCHAIN_MISSING"),
  evidenceReference:z.string().min(1).max(200)
});
type Row={id:string;obligation_id:string;state:string;provider_id:string|null;transaction_hash:string|null;
  provider_idempotency_key:string;submitted_at:Date;terms:unknown;request_fingerprint:string;version:number;status:string};

/** Explicit human-reviewed Circle validation rejection, matched to the original
 * request key/time. Close without claiming settlement; require a new invoice version.
 * This does not send, replay, consume approval, or change PO/budget expenditure.
 */
export async function resolveRejectedSubmission(pool:Pool,businessId:string,intentId:string,actorId:string,rawProof:unknown){
  const proof=proofSchema.parse(rawProof),client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT business_id FROM ap_treasuries WHERE business_id=$1 FOR UPDATE",[businessId]);
    const row=(await client.query<Row>(`SELECT i.*,o.version,o.status FROM ap_payment_intents i
      JOIN ap_obligations o ON o.business_id=i.business_id AND o.id=i.obligation_id
      WHERE i.business_id=$1 AND i.id=$2 FOR UPDATE OF i,o`,[businessId,intentId])).rows[0];
    if(!row||row.state!=="UNKNOWN"||row.provider_id!==null||row.transaction_hash!==null||row.status!=="OPEN"
      ||row.provider_idempotency_key!==proof.providerIdempotencyKey||!row.submitted_at
      ||Date.parse(proof.requestedAt)-row.submitted_at.getTime()<0
      ||Date.parse(proof.requestedAt)-row.submitted_at.getTime()>30000)throw Error("REJECTION_EVIDENCE_CONFLICT");
    const terms=storedPaymentTermsSchema.parse(row.terms);
    if(reservationFingerprint(row.terms)!==row.request_fingerprint||terms.businessId!==businessId
      ||terms.obligationId!==row.obligation_id||terms.obligationVersion!==row.version)throw Error("REJECTION_TERMS_CONFLICT");
    const requireOne=(count:number|null)=>{if(count!==1)throw Error("REJECTION_RECOVERY_CONFLICT");};
    // Keep the secret-like operational idempotency key out of the public audit projection.
    const evidence={httpStatus:proof.httpStatus,providerCode:proof.providerCode,providerRequestId:proof.providerRequestId,
      requestedAt:proof.requestedAt,reason:proof.reason,evidenceReference:proof.evidenceReference};
    requireOne((await client.query(`UPDATE ap_payment_intents SET state='FAILED',failure_evidence=$3::jsonb,
      lease_owner=NULL,lease_expires_at=NULL WHERE business_id=$1 AND id=$2 AND state='UNKNOWN'`,
      [businessId,intentId,JSON.stringify(evidence)])).rowCount);
    requireOne((await client.query(`UPDATE ap_reservations SET status='RELEASED',finished_at=now()
      WHERE business_id=$1 AND intent_id=$2 AND status='HELD'`,[businessId,intentId])).rowCount);
    // Old decisions and exact approvals remain immutable history, but cannot authorize this version.
    requireOne((await client.query(`UPDATE ap_obligations SET version=version+1,normalized=NULL,
      lease_owner=NULL,lease_expires_at=NULL,next_evaluation_at=now() WHERE business_id=$1 AND id=$2 AND version=$3`,
      [businessId,row.obligation_id,row.version])).rowCount);
    await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      VALUES ($1,$2,$3,$4,$5,'PAYMENT_SUBMISSION_REJECTED',$6::jsonb)`,[businessId,`submission-rejected:${intentId}`,actorId,
      row.obligation_id,row.version+1,JSON.stringify({intentId,previousVersion:row.version,...evidence})]);
    await client.query("COMMIT");
    return {status:"FAILED" as const,intentId,obligationId:row.obligation_id,version:row.version+1};
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
