import type { Pool } from "pg";
import { z } from "zod";
import { cashEvidenceSchema, feeEvidenceSchema, treasurySnapshotSchema } from "@agentpay/core";
import { ReservationConflict, reservePayment } from "./reserve.js";

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
export async function reserveNextPayment(pool: Pool, businessId: string, now = new Date()): Promise<ReservationWorkerResult> {
  const result = await pool.query<DueDecision>(`SELECT o.id AS obligation_id, d.id AS decision_id, d.treasury_snapshot
    FROM ap_obligations o
    JOIN LATERAL (SELECT id, action, candidate, treasury_snapshot, expires_at
      FROM ap_decisions WHERE business_id = o.business_id AND obligation_id = o.id
      ORDER BY evaluated_at DESC, id DESC LIMIT 1) d ON true
    WHERE o.business_id = $1 AND o.status = 'OPEN' AND o.next_evaluation_at <= $2
      AND d.action IN ('PAY_NOW', 'SCHEDULE', 'REQUIRE_APPROVAL') AND d.expires_at > $2
    ORDER BY o.next_evaluation_at, o.id
    LIMIT 1`, [businessId, now.toISOString()]);
  const due = result.rows[0];
  if (!due) return { status: "NO_DUE" };
  const evidence = storedPlanningEvidenceSchema.safeParse(due.treasury_snapshot);
  if (!evidence.success) return { status: "SKIPPED", reason: "TREASURY_EVIDENCE_UNAVAILABLE" };
  try {
    const reserved = await reservePayment(pool, { businessId, obligationId: due.obligation_id, decisionId: due.decision_id,
      actorId: "payment-worker", feeAllowanceMicroUsdc: evidence.data.snapshot.feeAllowanceMicroUsdc,
      now: now.toISOString(), evidence: { cashBlockHash: evidence.data.cash.blockHash,
        capturedAt: evidence.data.cash.capturedAt, ledgerFingerprint: evidence.data.ledgerFingerprint,
        feeEvidenceReference: evidence.data.fee.evidenceReference } });
    return { status: "RESERVED", ...reserved };
  } catch (error) {
    if (error instanceof ReservationConflict) return { status: "SKIPPED", reason: error.code };
    throw error;
  }
}