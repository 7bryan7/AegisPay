import type { PoolClient } from "pg";
import type { NormalizedObligation } from "@agentpay/core";

/** Conservative review signal, separate from the unique invoice/PO constraints.
 * An owner can reject a duplicate or correct independently verified facts. */
export async function similarInvoices(db: PoolClient, facts: NormalizedObligation, vendorId: string) {
  if (!facts.servicePeriod) return [];
  const period = facts.servicePeriod.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  const matches = await db.query<{ id: string; period: string }>(`SELECT id,normalized->>'servicePeriod' AS period
    FROM ap_obligations WHERE business_id=$1 AND id<>$2 AND vendor_id=$3
    AND amount_micro_usdc=$4::numeric AND status<>'REJECTED' AND normalized->>'servicePeriod' IS NOT NULL
    ORDER BY id LIMIT 100001`, [facts.businessId, facts.id, vendorId, facts.amountMicroUsdc]);
  if (matches.rows.length > 100000) throw new Error("SIMILARITY_COVERAGE_UNAVAILABLE");
  return matches.rows.filter((row) => row.period.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") === period).map((row) => row.id);
}
