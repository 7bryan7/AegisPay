import { similarInvoices } from "../obligations/similarity.js";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { paymentAmounts, accountTreasury, evaluateTreasury, isExactApprovalValid, normalizedObligationSchema, verifyObligation,
  cashEvidenceSchema, feeEvidenceSchema, paymentLedgerSchema, approvalTermsSchema, type TreasuryAccountingInput } from "@agentpay/core";
import { planningFingerprint, readPlanningState, type PlanningState } from "../treasury/ledger.js";
import type { PlanningAdapters } from "../treasury/prepare.js";

export class PaymentAuthorizationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "PaymentAuthorizationError"; }
}
function fail(code: string): never { throw new PaymentAuthorizationError(code); }
export const paymentEvidenceSchema = z.object({ cash: cashEvidenceSchema, fee: feeEvidenceSchema,
  fingerprint: z.string(), payments: z.array(paymentLedgerSchema), ledgerAsOf: z.iso.datetime() });
export type PaymentEvidence = z.infer<typeof paymentEvidenceSchema>;
export const commitmentsFor = (state: PlanningState): TreasuryAccountingInput["commitments"] => state.purchaseOrders.map((p) => ({
  businessId: p.businessId, purchaseOrderId: p.id, obligationId: p.activeObligationId, outstandingMicroUsdc: p.outstandingMicroUsdc,
  dueDate: p.dueDate, accepted: p.deliveryAccepted, essential: p.essential ?? true, status: p.outstandingMicroUsdc === "0" ? "SETTLED" : "OPEN"
}));
export async function readPaymentEvidence(pool: Pool, businessId: string, recipient: string, amount: string, adapters: PlanningAdapters): Promise<PaymentEvidence> {
  const state = await readPlanningState(pool, businessId);
  if (state.treasury.mode !== adapters.mode) fail("PAYMENT_MODE_MISMATCH");
  const cash = await adapters.readCash(state.treasury);
  const fee = await adapters.estimateFee(cash, recipient, amount);
  const payments = adapters.verifyPayments ? await adapters.verifyPayments(cash, state.payments) : state.payments;
  return paymentEvidenceSchema.parse({ cash, fee, payments, fingerprint: planningFingerprint(state), ledgerAsOf: new Date().toISOString() });
}

/** Treasury lock must be held before this call. Locks current invoice/registry rows and replays all hard gates. */
export async function authorizePayment(db: PoolClient, businessId: string, obligationId: string, decisionId: string,
  now: Date, fresh?: PaymentEvidence, ownIntentId?: string, feeAllowance?: string) {
  const row = (await db.query<{
    normalized: unknown; version: number; status: string; amount: string; vendor_id: string; purchase_order_id: string;
    obligation_version: number; policy_version: number; vendor_address_version: number; purchase_order_version: number;
    action: string; expires_at: Date; candidate: unknown; treasury_snapshot: unknown; latest: string; lease_owner: string | null;
  }>(`SELECT o.normalized,o.version,o.status,o.amount_micro_usdc::text AS amount,o.vendor_id,o.purchase_order_id,o.lease_owner,
     d.obligation_version,d.policy_version,d.vendor_address_version,d.purchase_order_version,d.action,d.expires_at,d.candidate,d.treasury_snapshot,
     (SELECT id FROM ap_decisions WHERE business_id=o.business_id AND obligation_id=o.id ORDER BY evaluated_at DESC,id DESC LIMIT 1) AS latest
     FROM ap_obligations o JOIN ap_decisions d ON d.business_id=o.business_id AND d.obligation_id=o.id
     JOIN ap_vendors v ON v.business_id=o.business_id AND v.id=o.vendor_id
     JOIN ap_purchase_orders p ON p.business_id=o.business_id AND p.id=o.purchase_order_id
     WHERE o.business_id=$1 AND o.id=$2 AND d.id=$3 FOR UPDATE OF o,v,p`, [businessId, obligationId, decisionId])).rows[0];
  if (!row || row.status !== "OPEN" || row.latest !== decisionId || row.lease_owner
    || row.obligation_version !== row.version || row.normalized === null) fail("PAYMENT_STALE_DECISION");
  const state = await readPlanningState(db, businessId);
  const facts = normalizedObligationSchema.parse(row.normalized);
  const po = state.purchaseOrders.find((p) => p.id === row.purchase_order_id);
  const vendor = state.vendors.find((v) => v.id === row.vendor_id);
  if (!po || !vendor || state.treasury.mode === "disabled" || facts.businessId !== businessId || facts.id !== obligationId
    || facts.version !== row.version || facts.amountMicroUsdc !== row.amount || facts.purchaseOrderId !== po.id
    || row.obligation_version !== row.version || row.policy_version !== state.treasury.policyVersion
    || row.vendor_address_version !== vendor.addressVersion || row.purchase_order_version !== po.version
    || verifyObligation(facts, vendor, po).status !== "VERIFIED") fail("PAYMENT_VERSION_OR_VERIFICATION");
  if ((await similarInvoices(db, facts, vendor.id)).length) fail("SIMILAR_INVOICE_REQUIRES_REVIEW");
  let amounts;
  try { amounts = paymentAmounts(facts.amountMicroUsdc, facts.dueDate, po.verifiedDiscount,
    now.toISOString(), state.treasury.policy.annualCashPreservationCostBps); }
  catch { return fail("INVALID_DISCOUNT_TERMS"); }
  const terms = approvalTermsSchema.parse({ businessId, obligationId, decisionId, walletId: state.treasury.walletId,
    obligationVersion: row.version, vendorId: vendor.id, vendorAddressVersion: vendor.addressVersion, purchaseOrderId: po.id,
    purchaseOrderVersion: po.version, policyVersion: state.treasury.policyVersion, recipient: vendor.address,
    ...amounts, chainId: state.treasury.chainId, token: state.treasury.tokenAddress });
  const grant = (await db.query<{ id: string; terms: unknown; actor_id: string; role: string; granted: boolean; reason: string;
    granted_at: Date; expires_at: Date; consumed_at: Date | null }>(
    "SELECT * FROM ap_approvals WHERE business_id=$1 AND decision_id=$2 FOR UPDATE", [businessId, decisionId])).rows[0];
  const exactApprovalValid = !!grant && isExactApprovalValid({ id: grant.id, terms: grant.terms, actorId: grant.actor_id,
    role: grant.role, granted: grant.granted, reason: grant.reason, grantedAt: grant.granted_at.toISOString(),
    expiresAt: grant.expires_at.toISOString(), consumedAt: grant.consumed_at?.toISOString() ?? null }, terms, now.toISOString());
  if (row.action === "REQUIRE_APPROVAL" && !exactApprovalValid) fail("PAYMENT_APPROVAL_REQUIRED");
  if (!["PAY_NOW", "SCHEDULE", "REQUIRE_APPROVAL"].includes(row.action)) fail("PAYMENT_DECISION_NOT_PAYABLE");
  // An approval may outlive the cash snapshot, but only with independently refreshed evidence.
  if (row.expires_at <= now && !(fresh && row.action === "REQUIRE_APPROVAL" && exactApprovalValid)) fail("PAYMENT_STALE_DECISION");
  if (row.action !== "REQUIRE_APPROVAL") {
    const candidate = z.object({ action: z.string(), amountMicroUsdc: z.string(), executeAt: z.iso.datetime().nullable() }).parse(row.candidate);
    if (candidate.action !== row.action || candidate.amountMicroUsdc !== amounts.amountMicroUsdc
      || (candidate.executeAt && Date.parse(candidate.executeAt) > now.getTime())) fail("PAYMENT_CANDIDATE_MISMATCH");
  }
  const stored = fresh ? null : z.object({ available: z.literal(true), cash: cashEvidenceSchema, fee: feeEvidenceSchema,
    ledgerFingerprint: z.string(), ledgerAsOf: z.iso.datetime() }).parse(row.treasury_snapshot);
  const evidence = fresh ?? { cash: stored!.cash, fee: stored!.fee, fingerprint: stored!.ledgerFingerprint,
    payments: state.payments, ledgerAsOf: stored!.ledgerAsOf };
  if (evidence.fingerprint !== planningFingerprint(state) || evidence.cash.walletAddress !== state.treasury.walletAddress) fail("PAYMENT_STATE_CHANGED");
  // Own RESERVED intent is removed exactly once when testing whether its payout still fits.
  const payments = evidence.payments.filter((p) => p.intentId !== ownIntentId);
  const accounting = accountTreasury({ businessId, now: now.toISOString(), paused: state.treasury.paused, policy: state.treasury.policy,
    candidate: { obligationId, purchaseOrderId: po.id, category: vendor.category, recipient: vendor.address, amountMicroUsdc: amounts.amountMicroUsdc },
    cash: evidence.cash, fee: evidence.fee, payments, commitments: commitmentsFor(state), ledgerAsOf: evidence.ledgerAsOf,
    coverageFrom: "1970-01-01T00:00:00.000Z" });
  if (accounting.status !== "READY") fail(accounting.reasons[0] ?? "PAYMENT_ACCOUNTING_UNAVAILABLE");
  const snapshot = { ...accounting.snapshot, feeAllowanceMicroUsdc: feeAllowance ?? accounting.snapshot.feeAllowanceMicroUsdc };
  const eligibility = evaluateTreasury({ now: now.toISOString(), dueDate: facts.dueDate, amountMicroUsdc: facts.amountMicroUsdc, verifiedDiscount: po.verifiedDiscount ?? null,
    verification: "VERIFIED", duplicateOrSettled: false, screening: "LOCAL_REGISTRY", exactApprovalValid,
    policy: state.treasury.policy, snapshot });
  if (eligibility.action !== "PAY_NOW") fail(eligibility.reasons[0] ?? "PAYMENT_NOT_DUE");
  const fee = { gasLimit: ((BigInt(evidence.fee.gasLimit) * BigInt(10000 + evidence.fee.bufferBps) + 9999n) / 10000n).toString(),
    maxFeePerGasNative: evidence.fee.maxFeePerGasNative, maxPriorityFeePerGasNative: evidence.fee.maxFeePerGasNative };
  const allowance = snapshot.feeAllowanceMicroUsdc;
  if ((BigInt(fee.gasLimit) * BigInt(fee.maxFeePerGasNative) + 999_999_999_999n) / 1_000_000_000_000n > BigInt(allowance)) fail("PAYMENT_FEE_LIMIT");
  return { terms, fee, allowance, approvalId: exactApprovalValid ? grant.id : null, category: vendor.category, evidence, state };
}
