import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { approvalTermsSchema, arcAddressSchema, microUsdcStringSchema } from "@agentpay/core";
import type { CircleExpectedTerms, CircleTransactionStatus, CircleTransferResult } from "./circle.js";
import { createCircleTransferAdapter, CircleTransferError } from "./circle.js";
import { authorizePayment, readPaymentEvidence, PaymentAuthorizationError } from "./authorization.js";
import { reservationFingerprint } from "./reserve.js";
import type { PlanningAdapters } from "../treasury/prepare.js";

export type CircleTransferAdapter = { dispatchEnabled?: boolean; submit(request: unknown): Promise<CircleTransferResult> };
export type CircleProvider = CircleTransferAdapter & { checkWallet(): Promise<void>; getStatus(providerId: string, expected?: CircleExpectedTerms): Promise<CircleTransactionStatus> };
export const storedPaymentTermsSchema = approvalTermsSchema.safeExtend({ walletAddress: arcAddressSchema, feeAllowanceMicroUsdc: microUsdcStringSchema,
  fee: z.strictObject({ gasLimit: z.string().regex(/^[1-9]\d*$/), maxFeePerGasNative: z.string().regex(/^[1-9]\d*$/),
    maxPriorityFeePerGasNative: z.string().regex(/^(0|[1-9]\d*)$/) }), evidence: z.record(z.string(),z.unknown()) });
type Intent = { id: string; obligation_id: string; decision_id: string; terms: unknown; provider_idempotency_key: string;
  request_fingerprint: string; amount: string; allowance: string; approval_id: string | null; state: string };
export type DispatchResult = { status: "DISABLED" | "NO_RESERVED" }
  | { status: "PENDING"; intentId: string; providerId: string; providerState: string }
  | { status: "CANCELLED" | "UNKNOWN" | "WAITING"; intentId: string; reason: string };

/** A lost lease never authorizes replay. Unknown-without-ID needs operator/provider investigation. */
export async function recoverSubmittingPayments(pool: Pool, businessId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT business_id FROM ap_treasuries WHERE business_id=$1 FOR UPDATE", [businessId]);
    const rows = (await client.query<{ id: string; obligation_id: string }>(`UPDATE ap_payment_intents SET state='UNKNOWN',
      lease_owner=NULL,lease_expires_at=NULL WHERE business_id=$1 AND state='SUBMITTING'
      AND (lease_expires_at IS NULL OR lease_expires_at <= now()) RETURNING id,obligation_id`,[businessId])).rows;
    for (const row of rows) await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      VALUES ($1,$2,'payment-worker',$3,1,'PAYMENT_UNKNOWN',$4::jsonb) ON CONFLICT DO NOTHING`,
      [businessId,"recovery:"+row.id,row.obligation_id,JSON.stringify({ intentId:row.id,reason:"SUBMISSION_LEASE_EXPIRED" })]);
    await client.query("COMMIT"); return rows.length;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

/** External reads first; treasury/registry locks recheck exact identity and hard limits before committing SUBMITTING. */
export async function dispatchNextPayment(pool: Pool, adapter: CircleTransferAdapter, businessId: string,
  evidenceReaders?: PlanningAdapters, expectedIntentId?: string): Promise<DispatchResult> {
  if (adapter.dispatchEnabled !== true || !evidenceReaders) return { status:"DISABLED" };
  const row = (await pool.query<Intent>(`SELECT *,amount_micro_usdc::text AS amount,fee_allowance_micro_usdc::text AS allowance
    FROM ap_payment_intents WHERE business_id=$1 AND state='RESERVED' AND ($2::uuid IS NULL OR id=$2::uuid)
    ORDER BY created_at,id LIMIT 1`,[businessId,expectedIntentId??null])).rows[0];
  if (!row) return { status:"NO_RESERVED" };
  const parsed = storedPaymentTermsSchema.safeParse(row.terms);
  if (!parsed.success) return { status:"WAITING",intentId:row.id,reason:"LEGACY_INTENT_TERMS_REQUIRE_REVIEW" };
  const terms = parsed.data;
  let fresh;
  try { fresh = await readPaymentEvidence(pool,businessId,terms.recipient,terms.amountMicroUsdc,evidenceReaders); }
  catch { return { status:"WAITING",intentId:row.id,reason:"FRESH_EVIDENCE_UNAVAILABLE" }; }
  const providerRequestId=randomUUID();
  const leaseOwner = randomUUID(), client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT business_id FROM ap_treasuries WHERE business_id=$1 FOR UPDATE",[businessId]);
    const current = (await client.query<Intent>("SELECT * FROM ap_payment_intents WHERE business_id=$1 AND id=$2 FOR UPDATE",[businessId,row.id])).rows[0];
    if (!current || current.state !== "RESERVED") { await client.query("ROLLBACK"); return { status:"NO_RESERVED" }; }
    try {
      if (reservationFingerprint(row.terms) !== row.request_fingerprint || JSON.stringify(current.terms) !== JSON.stringify(row.terms)
        || terms.businessId !== businessId || terms.obligationId !== row.obligation_id || terms.decisionId !== row.decision_id
        || terms.amountMicroUsdc !== row.amount || terms.feeAllowanceMicroUsdc !== row.allowance) throw new PaymentAuthorizationError("PAYMENT_TERMS_CONFLICT");
      const check = await authorizePayment(client,businessId,row.obligation_id,row.decision_id,new Date(),fresh,row.id,terms.feeAllowanceMicroUsdc);
      const expected = approvalTermsSchema.strip().parse(terms);
      if (JSON.stringify(check.terms) !== JSON.stringify(expected) || check.approvalId !== row.approval_id
        || check.state.treasury.walletAddress !== terms.walletAddress
        || BigInt(check.fee.gasLimit) > BigInt(terms.fee.gasLimit) || BigInt(check.fee.maxFeePerGasNative) > BigInt(terms.fee.maxFeePerGasNative)) {
        throw new PaymentAuthorizationError("PAYMENT_TERMS_CHANGED");
      }
    } catch (error) {
      if (!(error instanceof PaymentAuthorizationError)) throw error;
      await client.query("UPDATE ap_payment_intents SET state='CANCELLED',lease_owner=NULL,lease_expires_at=NULL WHERE business_id=$1 AND id=$2",[businessId,row.id]);
      await client.query("UPDATE ap_reservations SET status='RELEASED',finished_at=now() WHERE business_id=$1 AND intent_id=$2 AND status='HELD'",[businessId,row.id]);
      await client.query("UPDATE ap_obligations SET next_evaluation_at=now() WHERE business_id=$1 AND id=$2",[businessId,row.obligation_id]);
      await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
        VALUES ($1,$2,'payment-worker',$3,$4,'PAYMENT_CANCELLED',$5::jsonb)`,
        [businessId,"cancelled:"+row.id,row.obligation_id,terms.obligationVersion,JSON.stringify({intentId:row.id,reason:error.code})]);
      await client.query("COMMIT"); return {status:"CANCELLED",intentId:row.id,reason:error.code};
    }
    await client.query(`UPDATE ap_payment_intents SET state='SUBMITTING',submitted_at=now(),lease_owner=$3,
      lease_expires_at=now()+interval '2 minutes' WHERE business_id=$1 AND id=$2`,[businessId,row.id,leaseOwner]);
    await client.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      VALUES ($1,$2,'payment-worker',$3,$4,'PAYMENT_SUBMITTING',$5::jsonb)`,
      [businessId,"submitting:"+row.id,row.obligation_id,terms.obligationVersion,JSON.stringify({intentId:row.id,requestId:providerRequestId})]);
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally {client.release();}
  let response: CircleTransferResult | null = null;
  let submissionIssue: CircleTransferError["submissionIssue"]=undefined;
  try {
    response = await adapter.submit({ walletId:terms.walletId,providerIdempotencyKey:row.provider_idempotency_key,
      providerRequestId,recipient:terms.recipient,amountMicroUsdc:terms.amountMicroUsdc,chainId:terms.chainId,tokenAddress:terms.token,
      feeAllowanceMicroUsdc:terms.feeAllowanceMicroUsdc,fee:terms.fee });
  } catch(error) {
    if(error instanceof CircleTransferError)submissionIssue=error.submissionIssue;
    // All uncertain attempts retain their hold. A recorded HTTP code alone never authorizes replay.
  }
  const persist = await pool.connect();
  try {
    await persist.query("BEGIN");
    await persist.query("SELECT business_id FROM ap_treasuries WHERE business_id=$1 FOR UPDATE",[businessId]);
    const updated = await persist.query(`UPDATE ap_payment_intents SET state=$4,provider_id=$5,provider_state=$6,
      lease_owner=NULL,lease_expires_at=NULL WHERE business_id=$1 AND id=$2 AND state='SUBMITTING' AND lease_owner=$3`,
      [businessId,row.id,leaseOwner,response?"PENDING":"UNKNOWN",response?.providerId??null,response?.providerState??null]);
    if (updated.rowCount !== 1) {await persist.query("ROLLBACK");return {status:"UNKNOWN",intentId:row.id,reason:"DISPATCH_LEASE_LOST"};}
    await persist.query(`INSERT INTO ap_events (business_id,event_key,actor_id,entity_id,entity_version,event_type,payload)
      VALUES ($1,$2,'payment-worker',$3,$4,$5,$6::jsonb)`,[businessId,"submitted:"+row.id,row.obligation_id,terms.obligationVersion,
      response?"PAYMENT_PENDING":"PAYMENT_UNKNOWN",JSON.stringify({intentId:row.id,providerId:response?.providerId??null,...(submissionIssue?{submissionIssue}:{})})]);
    await persist.query("COMMIT");
  } catch(error) {await persist.query("ROLLBACK");throw error;} finally {persist.release();}
  return response?{status:"PENDING",intentId:row.id,providerId:response.providerId,providerState:response.providerState}
    :{status:"UNKNOWN",intentId:row.id,reason:"CIRCLE_UNAVAILABLE"};
}
export function createCircleAdapterFromEnvironment(environment: NodeJS.ProcessEnv): CircleProvider | null {
  if (environment.PAYMENT_MODE !== "arc_testnet" || environment.CIRCLE_BLOCKCHAIN !== "ARC-TESTNET") return null;
  if (!environment.CIRCLE_API_KEY || !environment.CIRCLE_ENTITY_SECRET || !environment.CIRCLE_WALLET_ID) return null;
  try {return { ...createCircleTransferAdapter({mode:"arc_testnet",blockchain:"ARC-TESTNET",walletAddress:environment.ARC_WALLET_ADDRESS??"",
    apiKey:environment.CIRCLE_API_KEY,entitySecret:environment.CIRCLE_ENTITY_SECRET,walletId:environment.CIRCLE_WALLET_ID}),
    dispatchEnabled: environment.PAYMENT_DISPATCH_ENABLED === "true" };}
  catch{return null;}
}
