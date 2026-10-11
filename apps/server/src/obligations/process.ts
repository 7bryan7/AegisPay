import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { normalizePayableExtraction, payableExtractionSchema, payableVendorSchema, purchaseOrderSchema,
  verifyObligation, type NormalizedObligation, type PayableExtraction } from "@agentpay/core";
import { PAYABLE_EXTRACTION_PROMPT, type PayableExtractor } from "../extraction/payable.js";
import { validateInvoiceImage } from "../extraction/image.js";
import { preparePlanning, revalidatePlanning, heldDecision, type PlanningAdapters, type PreparedPlanning } from "../treasury/prepare.js";
import { readPlanningState } from "../treasury/ledger.js";

export type ExtractionClaim = {
  business_id: string; id: string; version: number; lease_owner: string;
  raw_extraction: unknown; purchase_order_hint: string | null;
};

/** Each claim has a fresh fencing token. An expired model call can never commit over its successor. */
export async function claimExtraction(pool: Pool, businessId: string): Promise<ExtractionClaim | null> {
  const result = await pool.query<ExtractionClaim>(`WITH job AS (
    SELECT o.id FROM ap_obligations o WHERE o.business_id = $1
      AND o.status IN ('RECEIVED', 'EXTRACTING', 'OPEN') AND o.next_evaluation_at <= now()
      AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= now())
      AND NOT EXISTS (SELECT 1 FROM ap_payment_intents p WHERE p.business_id = o.business_id
        AND p.obligation_id = o.id AND p.state IN ('RESERVED','SUBMITTING','PENDING','UNKNOWN','SETTLED'))
    ORDER BY o.next_evaluation_at, o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1
  ) UPDATE ap_obligations o SET lease_owner = $2, lease_expires_at = now() + interval '3 minutes',
    status = CASE WHEN raw_extraction IS NULL THEN 'EXTRACTING' ELSE status END
    FROM job WHERE o.business_id = $1 AND o.id = job.id
    RETURNING o.business_id, o.id, o.version, o.lease_owner, o.raw_extraction, o.purchase_order_hint`, [businessId, randomUUID()]);
  return result.rows[0] ?? null;
}

async function registry(client: PoolClient, facts: NormalizedObligation) {
  const result = await client.query<{ vendor: unknown; po: unknown }>(`SELECT
    jsonb_build_object('businessId', v.business_id, 'id', v.id, 'name', v.name, 'aliases', v.aliases,
      'status', v.status, 'address', v.address, 'addressVersion', v.address_version, 'chainId', v.chain_id,
      'category', v.category, 'settlementCurrency', v.settlement_currency,
      'settlementAgreementReference', v.settlement_agreement_reference, 'verificationReference', v.verification_reference) AS vendor,
    jsonb_build_object('businessId', p.business_id, 'id', p.id, 'vendorId', p.vendor_id, 'version', p.version,
      'amountMicroUsdc', p.amount_micro_usdc::text, 'outstandingMicroUsdc', p.outstanding_micro_usdc::text,
      'deliveryAccepted', p.delivery_accepted, 'acceptanceReference', p.acceptance_reference,
      'description', p.description, 'dueDate', p.due_date::text,
      'activeObligationId', (SELECT id FROM ap_obligations WHERE business_id = p.business_id
        AND purchase_order_id = p.id AND status <> 'REJECTED' LIMIT 1)) AS po
    FROM ap_purchase_orders p JOIN ap_vendors v ON v.business_id = p.business_id AND v.id = p.vendor_id
    WHERE p.business_id = $1 AND p.id = $2 FOR SHARE OF p, v`, [facts.businessId, facts.purchaseOrderId]);
  const vendor = payableVendorSchema.safeParse(result.rows[0]?.vendor);
  const po = purchaseOrderSchema.safeParse(result.rows[0]?.po);
  return { vendor: vendor.success ? vendor.data : null, po: po.success ? po.data : null };
}
const nameKey = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

/** Model calls occur before these short SQL locks. No payment intent is created here. */
export async function finishExtraction(pool: Pool, claim: ExtractionClaim, raw: PayableExtraction | null,
  failure: "EXTRACTION_UNAVAILABLE" | "EXTRACTION_FAILED" | null, modelId: string | null,
  prepared: PreparedPlanning | null = null): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const treasury = await client.query<{ policy_version: number }>(
      "SELECT policy_version FROM ap_treasuries WHERE business_id = $1 FOR UPDATE", [claim.business_id]);
    const current = await client.query(`SELECT id FROM ap_obligations WHERE business_id = $1 AND id = $2
      AND version = $3 AND lease_owner = $4 AND lease_expires_at > now()
      AND status IN ('RECEIVED','EXTRACTING','OPEN') FOR UPDATE`,
    [claim.business_id, claim.id, claim.version, claim.lease_owner]);
    if (!treasury.rowCount || !current.rowCount) { await client.query("ROLLBACK"); return false; }
    const active = await client.query(`SELECT id FROM ap_payment_intents WHERE business_id = $1 AND obligation_id = $2
      AND state IN ('RESERVED','SUBMITTING','PENDING','UNKNOWN','SETTLED')`, [claim.business_id, claim.id]);
    if (active.rowCount) { await client.query("ROLLBACK"); return false; }
    const version = claim.version + 1;
    const normalized = normalizePayableExtraction(raw, { businessId: claim.business_id, id: claim.id, version });
    const facts = normalized.status === "NORMALIZED" ? normalized.obligation : null;
    const records = facts ? await registry(client, facts) : { vendor: null, po: null };
    const verification = facts ? verifyObligation(facts, records.vendor, records.po) : null;
    let reasons = failure ? [failure] : normalized.status === "HOLD" ? normalized.reasons : verification?.reasons ?? [];
    let action: PreparedPlanning["decision"]["action"] = verification?.status === "REJECT" ? "REJECT" : "HOLD";
    const recognized = facts && records.vendor && [records.vendor.name, ...records.vendor.aliases]
      .some((name) => nameKey(name) === nameKey(facts.vendorName));
    let vendorId = recognized ? records.vendor?.id ?? null : null;
    let poId = verification?.status === "VERIFIED" ? records.po?.id ?? null : null;
    if (facts && claim.purchase_order_hint && claim.purchase_order_hint !== facts.purchaseOrderId) {
      reasons = [...reasons, "PURCHASE_ORDER_HINT_MISMATCH"]; poId = null;
    }
    if (facts && vendorId) {
      const duplicate = await client.query(`SELECT id FROM ap_obligations WHERE business_id = $1 AND id <> $2
        AND vendor_id = $3 AND normalized_invoice_number = $4`, [claim.business_id, claim.id, vendorId, facts.invoiceNumber]);
      if (duplicate.rowCount) {
        action = "REJECT"; reasons = ["DUPLICATE_INVOICE_IDENTITY"]; vendorId = null; poId = null;
      }
    }
    let planning: PreparedPlanning | null = null;
    if (!reasons.length && facts && prepared) {
      planning = { ...prepared, accounting: null, decision: heldDecision("PLANNING_STATE_CHANGED") };
      if (prepared.fingerprint && prepared.evidence) {
        try {
          const state = await readPlanningState(client, claim.business_id);
          planning = await revalidatePlanning(prepared, state, facts, records.vendor, records.po);
        } catch { planning.decision = heldDecision("TREASURY_EVIDENCE_UNAVAILABLE"); }
      } else planning.decision = prepared.decision;
      action = planning.decision.action; reasons = planning.decision.reasons;
    }
    if (reasons.length === 0) reasons = ["TREASURY_EVALUATION_UNAVAILABLE"];
    const evaluatedAt = new Date();
    let expiresAt = new Date(evaluatedAt.getTime() + 30_000);
    if (planning?.accounting?.status === "READY") {
      expiresAt = new Date(Date.parse(planning.accounting.snapshot.capturedAt) + 30_000);
      if (expiresAt <= evaluatedAt) {
        planning = { ...planning, accounting: null, decision: heldDecision("PLANNING_CONTEXT_EXPIRED") };
        action = "HOLD"; reasons = planning.decision.reasons; expiresAt = new Date(evaluatedAt.getTime() + 30_000);
      }
    }
    const nextEvaluation = action === "PAY_NOW" ? evaluatedAt.toISOString()
      : action === "SCHEDULE" && planning?.decision.candidate?.executeAt
        ? planning.decision.candidate.executeAt : new Date(evaluatedAt.getTime() + 300_000).toISOString();
    await client.query(`UPDATE ap_obligations SET raw_extraction = $5::jsonb, normalized = $6::jsonb,
      vendor_id = $7, purchase_order_id = $8, normalized_invoice_number = $9,
      amount_micro_usdc = $10, currency = $11, issue_date = $12, due_date = $13,
      status = $14, version = $15, lease_owner = NULL, lease_expires_at = NULL,
      next_evaluation_at = $16
      WHERE business_id = $1 AND id = $2 AND version = $3 AND lease_owner = $4`,
    [claim.business_id, claim.id, claim.version, claim.lease_owner, raw ? JSON.stringify(raw) : null,
      facts ? JSON.stringify(facts) : null, vendorId, poId, facts?.invoiceNumber ?? null,
      facts?.amountMicroUsdc ?? null, facts?.currency ?? null,
      facts && facts.issueDate <= facts.dueDate ? facts.issueDate : null, facts?.dueDate ?? null,
      action === "REJECT" ? "REJECTED" : "OPEN", version, nextEvaluation]);
    const decisionId = randomUUID();
    await client.query(`INSERT INTO ap_decisions (business_id, id, obligation_id, obligation_version,
      action, reason, evidence_ids, model_version, prompt_version, policy_version,
      vendor_address_version, purchase_order_version, treasury_snapshot, evaluated_at, expires_at, candidate)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,
        $13::jsonb, $14, $15, $16::jsonb)`,
    [claim.business_id, decisionId, claim.id, version, action, planning?.decision.proposal?.reason ?? reasons.join(", "),
      JSON.stringify([...new Set([...(facts?.evidence.map((item) => item.id) ?? []),
        ...(planning?.decision.proposal?.evidenceIds ?? []),
        ...(planning?.accounting?.status === "READY" ? planning.accounting.evidenceReferences : [])])]),
      planning ? planning.decision.modelId : modelId,
      planning ? planning.decision.promptVersion : raw ? PAYABLE_EXTRACTION_PROMPT : null, treasury.rows[0]!.policy_version,
      records.vendor?.addressVersion ?? null, records.po?.version ?? null,
      JSON.stringify(planning?.accounting?.status === "READY" ? { available: true, ...planning.accounting,
        cash: planning.evidence?.cash, fee: planning.evidence?.fee, ledgerAsOf: planning.evidence?.ledgerAsOf,
        ledgerFingerprint: planning.fingerprint, dispatchEnabled: false } : { available: false }),
      evaluatedAt.toISOString(), expiresAt.toISOString(), JSON.stringify(planning?.decision.candidate ?? null)]);
    await client.query(`INSERT INTO ap_events (business_id, event_key, actor_id, entity_id, entity_version, event_type, payload)
      VALUES ($1,$2,'extraction-worker',$3,$4,'OBLIGATION_EVALUATED',$5::jsonb)`,
    [claim.business_id, `evaluated:${decisionId}`, claim.id, version,
      JSON.stringify({ decisionId, action, reasons, verification: verification?.status ?? "HOLD", dispatchEnabled: false,
        proposal: planning?.decision.proposal ?? null, nextEvaluationAt: nextEvaluation,
        ledgerFingerprint: planning?.fingerprint ?? null })]);
    await client.query("COMMIT");
    return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function processNextObligation(pool: Pool, businessId: string, extractor: PayableExtractor | null,
  planning: PlanningAdapters | null = null): Promise<boolean> {
  const claim = await claimExtraction(pool, businessId);
  if (!claim) return false;
  const cached = payableExtractionSchema.safeParse(claim.raw_extraction);
  let raw = cached.success ? cached.data : null;
  let failure: "EXTRACTION_UNAVAILABLE" | "EXTRACTION_FAILED" | null = null;
  if (!raw) {
    if (!extractor) failure = "EXTRACTION_UNAVAILABLE";
    else {
      try {
        const input = await pool.query<{ image_bytes: Buffer; mime_type: string }>(
          "SELECT image_bytes, mime_type FROM ap_inputs WHERE business_id = $1 AND obligation_id = $2", [businessId, claim.id]);
        const image = input.rows[0];
        if (!image) throw new Error("INPUT_UNAVAILABLE");
        raw = payableExtractionSchema.parse(await extractor.extract(validateInvoiceImage(image.image_bytes, image.mime_type,
          { maxBytes: 5_000_000, maxPixels: 20_000_000 })));
      } catch { failure = "EXTRACTION_FAILED"; } // Never persist provider errors or raw exception text.
    }
  }
  const prepared = raw && !failure && planning ? await preparePlanning(pool, claim, raw, planning) : null;
  await finishExtraction(pool, claim, raw, failure, cached.success ? null : extractor?.modelId ?? null, prepared);
  return true;
}
