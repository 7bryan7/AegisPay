import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { validateInvoiceImage } from "../extraction/image.js";

const metadataSchema = z.strictObject({
  // These claims must come from authenticated server context, not upload fields.
  businessId: z.string().trim().min(1).max(500),
  actorId: z.string().trim().min(1).max(500),
  role: z.literal("OPERATOR"),
  idempotencyKey: z.string().trim().min(1).max(200),
  purchaseOrderHint: z.string().trim().min(1).max(500).nullable()
});

export class IngestionConflict extends Error {
  readonly status = 409;
  constructor(readonly code: "IDEMPOTENCY_CONFLICT" | "DUPLICATE_INPUT", readonly obligationId: string) {
    super(code);
    this.name = "IngestionConflict";
  }
}

type StoredUpload = { id: string; input_fingerprint: string; status: string };

/** Persist a validated private image and an extraction job together; never pays.
 * All writers use the stable business treasury lock, including duplicate uploads.
 */
export async function ingestObligation(
  pool: Pool,
  metadata: z.input<typeof metadataSchema>,
  bytes: Buffer,
  contentType: string,
  retentionHours = 168
): Promise<{ obligationId: string; status: string; reused: boolean }> {
  const input = metadataSchema.parse(metadata);
  z.number().int().min(1).max(8760).parse(retentionHours);
  const image = validateInvoiceImage(bytes, contentType, { maxBytes: 5_000_000, maxPixels: 20_000_000 });
  const hash = createHash("sha256").update(image.bytes).digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify({
    hash, mimeType: image.mimeType, purchaseOrderHint: input.purchaseOrderHint
  })).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const treasury = await client.query("SELECT business_id FROM ap_treasuries WHERE business_id = $1 FOR UPDATE", [input.businessId]);
    if (!treasury.rowCount) throw new Error("BUSINESS_NOT_CONFIGURED");
    const existing = await client.query<StoredUpload>(
      "SELECT id, input_fingerprint, status FROM ap_obligations WHERE business_id = $1 AND idempotency_key = $2",
      [input.businessId, input.idempotencyKey]
    );
    const previous = existing.rows[0];
    if (previous) {
      if (previous.input_fingerprint !== fingerprint) throw new IngestionConflict("IDEMPOTENCY_CONFLICT", previous.id);
      await client.query("COMMIT");
      return { obligationId: previous.id, status: previous.status, reused: true };
    }
    const duplicate = await client.query<{ id: string }>(
      "SELECT id FROM ap_obligations WHERE business_id = $1 AND input_sha256 = $2", [input.businessId, hash]
    );
    if (duplicate.rows[0]) throw new IngestionConflict("DUPLICATE_INPUT", duplicate.rows[0].id);
    const id = randomUUID();
    await client.query(`INSERT INTO ap_obligations
      (business_id, id, input_sha256, idempotency_key, input_fingerprint, purchase_order_hint)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.businessId, id, hash, input.idempotencyKey, fingerprint, input.purchaseOrderHint]);
    await client.query(`INSERT INTO ap_inputs
      (business_id, obligation_id, mime_type, byte_size, image_bytes, expires_at)
      VALUES ($1, $2, $3, $4, $5, now() + $6 * interval '1 hour')`,
    [input.businessId, id, image.mimeType, image.bytes.length, Buffer.from(image.bytes), retentionHours]);
    await client.query(`INSERT INTO ap_events
      (business_id, event_key, actor_id, entity_id, entity_version, event_type, payload)
      VALUES ($1, $2, $3, $4, 1, 'INVOICE_RECEIVED', $5::jsonb)`,
    [input.businessId, `received:${id}`, input.actorId, id, JSON.stringify({ inputSha256: hash, mimeType: image.mimeType })]);
    await client.query("COMMIT");
    return { obligationId: id, status: "RECEIVED", reused: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Retention only removes terminal inputs with no unresolved payment or lease.
 * OPEN/RECEIVED/EXTRACTING images stay available for verification and recovery.
 * Lock order matches ingestion and the future payment worker.
 */
export async function cleanupExpiredInputs(pool: Pool, businessId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const treasury = await client.query("SELECT business_id FROM ap_treasuries WHERE business_id = $1 FOR UPDATE", [businessId]);
    if (!treasury.rowCount) throw new Error("BUSINESS_NOT_CONFIGURED");
    const result = await client.query(`DELETE FROM ap_inputs i USING ap_obligations o
      WHERE i.business_id = $1 AND o.business_id = i.business_id AND o.id = i.obligation_id
        AND i.expires_at <= now() AND o.status IN ('SETTLED', 'REJECTED')
        AND o.lease_owner IS NULL
        AND NOT EXISTS (SELECT 1 FROM ap_payment_intents p
          WHERE p.business_id = o.business_id AND p.obligation_id = o.id
            AND p.state IN ('RESERVED', 'SUBMITTING', 'PENDING', 'UNKNOWN'))
      RETURNING i.obligation_id`, [businessId]);
    for (const row of result.rows as { obligation_id: string }[]) {
      await client.query(`INSERT INTO ap_events
        (business_id, event_key, actor_id, entity_id, entity_version, event_type, payload)
        SELECT business_id, $2, 'retention-worker', id::text, version, 'INPUT_REMOVED', '{}'::jsonb
        FROM ap_obligations WHERE business_id = $1 AND id = $3`,
      [businessId, `input-removed:${row.obligation_id}`, row.obligation_id]);
    }
    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
