import type { Pool } from "pg";
import { accountTreasuryOverview, treasuryOverviewSchema, type TreasuryOverview } from "@agentpay/core";
import { readPlanningState, planningFingerprint } from "./ledger.js";
import type { PlanningAdapters } from "./prepare.js";
import { commitmentsFor } from "../payments/authorization.js";

/** Uses the complete ledger and fresh independent receipt inclusion, never the
 * paginated invoice inbox or previously stored receipt JSON. No signing path. */
export async function readTreasuryOverview(pool: Pool, businessId: string, adapters: PlanningAdapters | null): Promise<TreasuryOverview> {
  const before = await readPlanningState(pool, businessId);
  const empty: TreasuryOverview = { status: "UNAVAILABLE", reason: "LIVE_EVIDENCE_UNAVAILABLE", capturedAt: null, blockNumber: null, blockHash: null,
    cashMicroUsdc: null, spendableMicroUsdc: null, protectedObligationsMicroUsdc: null, reflectedHoldsMicroUsdc: null,
    dailySettledMicroUsdc: null, dailyHoldsMicroUsdc: null, dailyHeadroomMicroUsdc: null, categories: [],
    upcoming: before.purchaseOrders.filter((po) => po.outstandingMicroUsdc !== "0").map((po) => ({ purchaseOrderId: po.id,
      amountMicroUsdc: po.outstandingMicroUsdc, dueDate: po.dueDate, essential: po.essential ?? true, accepted: po.deliveryAccepted })),
    futureFeeMessage: "Spendable cash includes existing fee holds; a new transfer requires a fresh fee estimate." };
  if (!adapters || before.treasury.mode !== adapters.mode) return empty;
  try {
    const cash = await adapters.readCash(before.treasury);
    if (cash.walletAddress !== before.treasury.walletAddress) return { ...empty, reason: "WALLET_MISMATCH" };
    const payments = adapters.verifyPayments ? await adapters.verifyPayments(cash, before.payments) : before.payments;
    const after = await readPlanningState(pool, businessId);
    if (planningFingerprint(before) !== planningFingerprint(after)) return { ...empty, reason: "TREASURY_CHANGED_DURING_READ" };
    const categories = [...new Set([...before.vendors.map((vendor) => vendor.category), ...payments.map((payment) => payment.category)])];
    const evaluatedAt = new Date().toISOString();
    const input = { businessId, now: evaluatedAt, paused: before.treasury.paused, policy: before.treasury.policy,
      cash, payments, commitments: commitmentsFor(before), ledgerAsOf: evaluatedAt, coverageFrom: "1970-01-01T00:00:00.000Z" };
    const total = accountTreasuryOverview({ ...input, category: categories[0] ?? "unassigned" });
    const observed = { ...empty, cashMicroUsdc: cash.cashMicroUsdc, capturedAt: cash.capturedAt, blockNumber: cash.blockNumber, blockHash: cash.blockHash };
    if (total.status !== "READY") return treasuryOverviewSchema.parse({ ...observed, reason: total.reasons.join(", ") });
    const meters = categories.map((category) => {
      const result = accountTreasuryOverview({ ...input, category });
      if (result.status !== "READY") throw new Error("INCONSISTENT_CATEGORY_ACCOUNTING");
      return { category, settledMicroUsdc: result.snapshot.categorySettledMicroUsdc, holdsMicroUsdc: result.snapshot.categoryHoldsMicroUsdc,
        headroomMicroUsdc: result.categoryHeadroomMicroUsdc };
    });
    return treasuryOverviewSchema.parse({ ...observed, status: "AVAILABLE", reason: null, spendableMicroUsdc: total.availableMicroUsdc,
      protectedObligationsMicroUsdc: total.snapshot.protectedObligationsMicroUsdc, reflectedHoldsMicroUsdc: total.reflectedHeldMicroUsdc,
      dailySettledMicroUsdc: total.snapshot.dailySettledMicroUsdc, dailyHoldsMicroUsdc: total.snapshot.dailyHoldsMicroUsdc,
      dailyHeadroomMicroUsdc: total.dailyHeadroomMicroUsdc, categories: meters });
  } catch { return { ...empty, reason: "LIVE_EVIDENCE_UNAVAILABLE" }; }
}
