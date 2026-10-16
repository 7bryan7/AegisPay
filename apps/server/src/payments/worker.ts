import type { Pool } from "pg";
import { z } from "zod";
import { cashEvidenceSchema, feeEvidenceSchema, treasurySnapshotSchema } from "@agentpay/core";
import { ReservationConflict, reservePayment } from "./reserve.js";
import type { PlanningAdapters } from "../treasury/prepare.js";
import { readPaymentEvidence } from "./authorization.js";
import { feeAllowanceFromEvidence } from "@agentpay/core";

const storedPlanningEvidenceSchema = z.object({
  available: z.literal(true),
  snapshot: treasurySnapshotSchema,
  cash: cashEvidenceSchema,
  fee: feeEvidenceSchema,
  ledgerFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
});
type DueDecision = { obligation_id: string; decision_id: string; treasury_snapshot: unknown };

export type ReservationWorkerResult =
  | { status: "NO_DUE" }
  | { status: "RESERVED"; intentId: string; reservationId: string; providerIdempotencyKey: string }
  | { status: "SKIPPED"; reason: string };

/** Claims one persisted decision for reservation. Provider dispatch is intentionally separate. */
export async function reserveNextPayment(pool: Pool, businessId: string, now = new Date(), adapters?: PlanningAdapters): Promise<ReservationWorkerResult> {
  const result = await pool.query<DueDecision>(`SELECT o.id AS obligation_id, d.id AS decision_id, d.treasury_snapshot
    FROM ap_obligations o
    JOIN LATERAL (SELECT id, action, candidate, treasury_snapshot, expires_at
      FROM ap_decisions WHERE business_id = o.business_id AND obligation_id = o.id AND obligation_version=o.version
      ORDER BY evaluated_at DESC, id DESC LIMIT 1) d ON true
    WHERE o.business_id = $1 AND o.status = 'OPEN' AND o.next_evaluation_at <= $2
      AND d.action IN ('PAY_NOW', 'SCHEDULE', 'REQUIRE_APPROVAL') AND (d.expires_at > $2 OR d.action='REQUIRE_APPROVAL')
      AND NOT EXISTS (SELECT 1 FROM ap_payment_intents i WHERE i.business_id=o.business_id AND i.obligation_id=o.id AND i.state IN ('RESERVED','SUBMITTING','PENDING','UNKNOWN','SETTLED'))
    ORDER BY o.next_evaluation_at, o.id
    LIMIT 1`, [businessId, now.toISOString()]);
  const due = result.rows[0];
  if (!due) return { status: "NO_DUE" };
  const evidence = storedPlanningEvidenceSchema.safeParse(due.treasury_snapshot);
  if (!evidence.success) return { status: "SKIPPED", reason: "TREASURY_EVIDENCE_UNAVAILABLE" };
  try {
    const fresh = adapters ? await readPaymentEvidence(pool, businessId, evidence.data.fee.recipient, evidence.data.fee.amountMicroUsdc, adapters) : undefined;
    const fee = fresh?.fee ?? evidence.data.fee, cash = fresh?.cash ?? evidence.data.cash;
    if (fresh) now = new Date();
    const reserved = await reservePayment(pool, { businessId, obligationId: due.obligation_id, decisionId: due.decision_id,
      actorId: "payment-worker", feeAllowanceMicroUsdc: feeAllowanceFromEvidence(fee),
      now: now.toISOString(), evidence: { cashBlockHash: cash.blockHash,
        capturedAt: cash.capturedAt, ledgerFingerprint: fresh?.fingerprint ?? evidence.data.ledgerFingerprint,
        feeEvidenceReference: fee.evidenceReference } }, fresh);
    return { status: "RESERVED", ...reserved };
  } catch (error) {
    if (error instanceof ReservationConflict) return { status: "SKIPPED", reason: error.code };
    throw error;
  }
}
