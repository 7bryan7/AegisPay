import type { Pool } from "pg";
import { normalizePayableExtraction, verifyObligation, type PayableExtraction, type TreasuryAccountingInput, type NormalizedObligation } from "@agentpay/core";
import type { ExtractionClaim } from "../obligations/process.js";
import type { PayablePlanner, BoundedDecision, PlanningContext } from "../agent/planner.js";
import { planAccountedPayable, type AccountedDecision } from "./evaluate.js";
import { readPlanningState, planningFingerprint, type PlanningState } from "./ledger.js";

export type PlanningAdapters = {
  mode: "arc_testnet" | "fixture";
  planner: PayablePlanner | null;
  readCash(treasury: PlanningState["treasury"]): Promise<TreasuryAccountingInput["cash"]>;
  estimateFee(cash: TreasuryAccountingInput["cash"], recipient: string, amount: string): Promise<NonNullable<TreasuryAccountingInput["fee"]>>;
  verifyPayments?(cash: TreasuryAccountingInput["cash"], payments: TreasuryAccountingInput["payments"]): Promise<TreasuryAccountingInput["payments"]>;
};
export type PreparedPlanning = AccountedDecision & {
  fingerprint: string | null; evidence: Omit<TreasuryAccountingInput, "candidate" | "policy" | "businessId" | "now"> | null;
};
export const heldDecision = (reason: string): BoundedDecision => ({ action: "HOLD", reasons: [reason],
  candidate: null, proposal: null, modelId: null, promptVersion: null });

/** Caller holds treasury/obligation locks. Only replays a stored proposal locally, with a fresh
 * clock and the current records. It never calls an external model while holding SQL locks.
 */
export async function revalidatePlanning(prepared: PreparedPlanning, state: PlanningState, obligation: NormalizedObligation,
  vendor: PlanningContext["vendor"], purchaseOrder: PlanningContext["purchaseOrder"], clock: () => Date = () => new Date()): Promise<PreparedPlanning> {
  const stop = (reason: string): PreparedPlanning => ({ ...prepared, accounting: null, decision: heldDecision(reason) });
  if (!prepared.fingerprint || !prepared.evidence || planningFingerprint(state) !== prepared.fingerprint) return stop("PLANNING_STATE_CHANGED");
  const proposal = prepared.decision.proposal;
  const checked = await planAccountedPayable({ obligation, vendor, purchaseOrder, policy: state.treasury.policy,
    duplicateOrSettled: false, exactApprovalValid: false, screening: "LOCAL_REGISTRY" }, prepared.evidence,
  proposal ? { modelId: prepared.decision.modelId ?? "unavailable", propose: () => Promise.resolve(proposal) } : null, clock);
  if (!proposal && checked.decision.reasons.includes("PLANNER_UNAVAILABLE")) checked.decision = prepared.decision;
  return { ...prepared, ...checked };
}

/** No SQL transaction spans external calls. Final persistence must re-read and compare state. */
export async function preparePlanning(pool: Pool, claim: ExtractionClaim, raw: PayableExtraction,
  adapters: PlanningAdapters, clock: () => Date = () => new Date()): Promise<PreparedPlanning> {
  const hold = (reason: string): PreparedPlanning => ({ accounting: null, decision: heldDecision(reason), fingerprint: null, evidence: null });
  const normalized = normalizePayableExtraction(raw, { businessId: claim.business_id, id: claim.id, version: claim.version + 1 });
  if (normalized.status !== "NORMALIZED") return hold("OBLIGATION_NOT_VERIFIED");
  const obligation = normalized.obligation;
  if (claim.purchase_order_hint && claim.purchase_order_hint !== obligation.purchaseOrderId) return hold("PURCHASE_ORDER_HINT_MISMATCH");
  try {
    const before = await readPlanningState(pool, claim.business_id);
    const po = before.purchaseOrders.find((p) => p.id === obligation.purchaseOrderId) ?? null;
    const vendor = before.vendors.find((v) => v.id === po?.vendorId) ?? null;
    if (verifyObligation(obligation, vendor, po).status !== "VERIFIED" || !vendor) return hold("OBLIGATION_NOT_VERIFIED");
    if (before.treasury.mode !== adapters.mode) return hold("PLANNING_MODE_MISMATCH");
    const cash = await adapters.readCash(structuredClone(before.treasury));
    if (cash.walletAddress !== before.treasury.walletAddress) return hold("PLANNING_WALLET_MISMATCH");
    const fee = await adapters.estimateFee(structuredClone(cash), vendor.address, obligation.amountMicroUsdc);
    const state = await readPlanningState(pool, claim.business_id);
    const fingerprint = planningFingerprint(state);
    if (fingerprint !== planningFingerprint(before)) return hold("PLANNING_STATE_CHANGED");
    const payments = adapters.verifyPayments ? await adapters.verifyPayments(cash, state.payments) : state.payments;
    const evidence = { cash, fee, paused: state.treasury.paused, ledgerAsOf: clock().toISOString(),
      coverageFrom: "1970-01-01T00:00:00.000Z", payments,
      // The schema has no optional essential flag: conservatively protect every accepted open PO.
      commitments: state.purchaseOrders.map((p) => ({ businessId: p.businessId, purchaseOrderId: p.id,
        obligationId: p.activeObligationId, outstandingMicroUsdc: p.outstandingMicroUsdc, dueDate: p.dueDate,
        accepted: p.deliveryAccepted, essential: true, status: p.outstandingMicroUsdc === "0" ? "SETTLED" as const : "OPEN" as const })) };
    const result = await planAccountedPayable({ obligation, vendor, purchaseOrder: po, policy: state.treasury.policy,
      duplicateOrSettled: false, exactApprovalValid: false, screening: "LOCAL_REGISTRY" }, evidence, adapters.planner, clock);
    return { ...result, evidence, fingerprint };
  } catch { return hold("TREASURY_EVIDENCE_UNAVAILABLE"); }
}
