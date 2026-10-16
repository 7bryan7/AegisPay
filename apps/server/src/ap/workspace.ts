import type { Pool } from "pg";
import { activityListSchema, paymentListSchema, workspaceInvoiceListSchema, workspaceSummarySchema, type WorkspaceQuery } from "@agentpay/core";

const invoices = `SELECT o.id,o.status,o.version,o.normalized_invoice_number AS "invoiceNumber",v.name AS "vendorName",
 o.amount_micro_usdc::text AS "amountMicroUsdc",o.due_date::text AS "dueDate",to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
 d.action AS decision,p.state AS "paymentState",COALESCE(d.reason,CASE WHEN o.status='REJECTED' THEN
 (SELECT r.reason FROM ap_invoice_revisions r WHERE r.business_id=o.business_id AND r.obligation_id=o.id AND r.version=o.version AND r.action='REJECT') END) AS reason,to_char(o.next_evaluation_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "nextEvaluationAt"
 FROM ap_obligations o LEFT JOIN ap_vendors v ON v.business_id=o.business_id AND v.id=o.vendor_id
 LEFT JOIN LATERAL (SELECT action,reason FROM ap_decisions WHERE business_id=o.business_id AND obligation_id=o.id
 AND obligation_version=o.version ORDER BY evaluated_at DESC,id DESC LIMIT 1) d ON true
 LEFT JOIN LATERAL (SELECT state FROM ap_payment_intents WHERE business_id=o.business_id AND obligation_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) p ON true
 WHERE o.business_id=$1`;
const events = `SELECT e.event_key AS key,e.entity_id AS "entityId",o.id AS "invoiceId",e.event_type AS type,e.entity_version AS version,
 e.actor_id AS "actorId",e.payload->>'reason' AS reason,to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
 FROM ap_events e LEFT JOIN ap_obligations o ON o.business_id=e.business_id AND o.id::text=e.entity_id
 WHERE e.business_id=$1`;
const invoiceSort = {
 due_asc: '"dueDate" ASC NULLS LAST,id DESC', due_desc: '"dueDate" DESC NULLS LAST,id DESC',
 amount_asc: '"amountMicroUsdc"::numeric ASC NULLS LAST,id DESC', amount_desc: '"amountMicroUsdc"::numeric DESC NULLS LAST,id DESC',
 created_desc: '"createdAt" DESC,id DESC'
} as const;
// Only allowlisted fields leave persistence. No provider payload, image, secret or signing/idempotency material.
export function createWorkspaceReads(pool: Pool) {
 return {
  async summary(businessId: string) {
   const result=await pool.query<{data:unknown}>(`WITH invoices AS (${invoices}),events AS (${events}) SELECT jsonb_build_object(
    'capturedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'counts',(SELECT jsonb_build_object('total',count(*),'processing',count(*) FILTER(WHERE status IN ('RECEIVED','EXTRACTING')),
    'approvals',count(*) FILTER(WHERE status='OPEN' AND decision='REQUIRE_APPROVAL'),'held',count(*) FILTER(WHERE status='OPEN' AND decision='HOLD'),
    'scheduled',count(*) FILTER(WHERE status='OPEN' AND decision='SCHEDULE'),'rejected',count(*) FILTER(WHERE status='REJECTED'),
    'settled',count(*) FILTER(WHERE status='SETTLED')) FROM invoices),
    'recentInvoices',COALESCE((SELECT jsonb_agg(row_to_json(r) ORDER BY r."createdAt" DESC,r.id DESC) FROM (SELECT * FROM invoices ORDER BY "createdAt" DESC,id DESC LIMIT 5)r),'[]'::jsonb),
    'actionQueue',COALESCE((SELECT jsonb_agg(row_to_json(r)) FROM (SELECT * FROM invoices WHERE status='OPEN' AND decision IN ('REQUIRE_APPROVAL','HOLD','SCHEDULE') ORDER BY CASE decision WHEN 'REQUIRE_APPROVAL' THEN 0 WHEN 'HOLD' THEN 1 ELSE 2 END,"dueDate" NULLS LAST,id DESC LIMIT 5)r),'[]'::jsonb),
    'recentActivity',COALESCE((SELECT jsonb_agg(row_to_json(r) ORDER BY r."createdAt" DESC,r.key DESC) FROM (SELECT * FROM events ORDER BY "createdAt" DESC,key DESC LIMIT 5)r),'[]'::jsonb)) AS data`,[businessId]);
   return workspaceSummarySchema.parse(result.rows[0]?.data);
  },
  async invoices(businessId: string,query: WorkspaceQuery) {
   const ordering=invoiceSort[query.sort??"created_desc"];
   const search=query.q?`%${query.q.replace(/[\\%_]/g,'\\$&')}%`:null;
   const result=await pool.query<{data:unknown}>(`WITH records AS (${invoices}),filtered AS (SELECT * FROM records WHERE
    ($2::text IS NULL OR COALESCE("invoiceNumber",'') ILIKE $2 OR COALESCE("vendorName",'') ILIKE $2 OR id::text ILIKE $2)
    AND ($3::text IS NULL OR decision=$3) AND ($4::text IS NULL OR status=$4)
    AND ($6::text IS NULL OR ($6='open_actions' AND status='OPEN' AND decision IN ('REQUIRE_APPROVAL','HOLD','SCHEDULE'))
      OR ($6='rejected' AND status='REJECTED'))), page AS
    (SELECT * FROM filtered ORDER BY ${ordering} LIMIT 26 OFFSET $5)
    SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'invoices',COALESCE((SELECT jsonb_agg(row_to_json(r) ORDER BY ${ordering})
    FROM (SELECT * FROM page ORDER BY ${ordering} LIMIT 25)r),'[]'::jsonb),'nextOffset',CASE WHEN (SELECT count(*) FROM page)>25 THEN $5::int+25 ELSE NULL END) AS data`,
   [businessId,search,query.decision??null,query.status??null,query.offset,query.queue??null]);
   return workspaceInvoiceListSchema.parse(result.rows[0]?.data);
  },
  async activity(businessId:string,offset:number,invoiceId:string|null) {
   const result=await pool.query<{data:unknown}>(`WITH page AS (${events} AND ($3::uuid IS NULL OR o.id=$3) ORDER BY e.created_at DESC,e.event_key DESC LIMIT 26 OFFSET $2)
    SELECT jsonb_build_object('events',COALESCE((SELECT jsonb_agg(row_to_json(r) ORDER BY r."createdAt" DESC,r.key DESC) FROM
    (SELECT * FROM page ORDER BY "createdAt" DESC,key DESC LIMIT 25)r),'[]'::jsonb),'nextOffset',CASE WHEN (SELECT count(*) FROM page)>25 THEN $2::int+25 ELSE NULL END) AS data`,[businessId,offset,invoiceId]);
   return activityListSchema.parse(result.rows[0]?.data);
  },
  async payments(businessId:string,offset:number,state:string|null) {
   const result=await pool.query<{data:unknown}>(`WITH page AS (SELECT p.id,p.obligation_id AS "invoiceId",o.normalized_invoice_number AS "invoiceNumber",v.name AS "vendorName",p.state,
    t.wallet_address AS sender,p.terms->>'recipient' AS recipient,p.amount_micro_usdc::text AS "amountMicroUsdc",p.fee_allowance_micro_usdc::text AS "feeAllowanceMicroUsdc",
    p.actual_fee_micro_usdc::text AS "actualFeeMicroUsdc",COALESCE(p.terms->>'nominalAmountMicroUsdc',p.amount_micro_usdc::text) AS "nominalAmountMicroUsdc",
    COALESCE(p.terms->>'discountAdjustmentMicroUsdc','0') AS "discountAdjustmentMicroUsdc",t.chain_id AS "chainId",t.token_address AS token,
    p.provider_id AS "providerId",p.provider_state AS "providerState",p.transaction_hash AS "transactionHash",p.receipt_evidence->>'verificationReference' AS "verificationReference",
    to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(p.settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "settledAt" FROM ap_payment_intents p JOIN ap_treasuries t ON t.business_id=p.business_id
    JOIN ap_obligations o ON o.business_id=p.business_id AND o.id=p.obligation_id LEFT JOIN ap_vendors v ON v.business_id=o.business_id AND v.id=o.vendor_id
    WHERE p.business_id=$1 AND ($3::text IS NULL OR p.state=$3) ORDER BY p.created_at DESC,p.id DESC LIMIT 26 OFFSET $2)
    SELECT jsonb_build_object('payments',COALESCE((SELECT jsonb_agg(row_to_json(r) ORDER BY r."createdAt" DESC,r.id DESC) FROM
    (SELECT * FROM page ORDER BY "createdAt" DESC,id DESC LIMIT 25)r),'[]'::jsonb),'nextOffset',CASE WHEN (SELECT count(*) FROM page)>25 THEN $2::int+25 ELSE NULL END) AS data`,[businessId,offset,state]);
   return paymentListSchema.parse(result.rows[0]?.data);
  }
 };
}
export type WorkspaceReads=ReturnType<typeof createWorkspaceReads>;
