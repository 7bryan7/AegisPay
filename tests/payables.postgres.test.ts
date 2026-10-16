import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { config } from "dotenv";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupExpiredInputs, ingestObligation } from "../apps/server/src/obligations/ingest.js";
import { createApStore } from "../apps/server/src/ap/store.js";
import { claimExtraction, finishExtraction, processNextObligation } from "../apps/server/src/obligations/process.js";
import { syntheticPayable } from "./support/payable.js";
import { enrollPayables } from "../apps/server/src/obligations/enroll.js";
import { syntheticEnrollment } from "./support/enrollment.js";
import { syntheticPlanning } from "./support/planning.js";
import { readPlanningState } from "../apps/server/src/treasury/ledger.js";
import { preparePlanning } from "../apps/server/src/treasury/prepare.js";
import { reserveNextPayment } from "../apps/server/src/payments/worker.js";
import { resolveRejectedSubmission } from "../apps/server/src/payments/rejected-submission.js";
import { CircleTransferError } from "../apps/server/src/payments/circle.js";
import { dispatchNextPayment, recoverSubmittingPayments } from "../apps/server/src/payments/dispatch.js";
import { reconcilePaymentForOperator, reconcileNextPayment } from "../apps/server/src/payments/reconcile.js";
import { correctInvoice, evaluateInvoice, rejectInvoice } from "../apps/server/src/obligations/review.js";
import { createAdministration } from "../apps/server/src/ap/administration.js";
import { isExactApprovalValid, payableApprovalSchema } from "@agentpay/core";

config({ quiet: true });
const connectionString = process.env.AP_TEST_DATABASE_URL;
// Explicit command fails rather than presenting absent PostgreSQL coverage as green.
if (!connectionString) throw new Error("Set AP_TEST_DATABASE_URL to a dedicated disposable PostgreSQL test database");
if (connectionString === process.env.DATABASE_URL) throw new Error("AP tests must not use the application database");
const schema = `ap_test_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000,
  options: `-c search_path=${schema} -c statement_timeout=10000` });
const image = await readFile(new URL("../fixtures/synthetic-invoice.png", import.meta.url));
let schemaCreated = false;

async function treasury(id: string) {
  await pool.query(`INSERT INTO ap_treasuries
    (business_id, wallet_id, wallet_address, chain_id, token_address, policy)
    VALUES ($1, $1, $2, 5042002, '0x3600000000000000000000000000000000000000', '{}')`,
  [id, `0x${"1".repeat(40)}`]);
}
async function upload(businessId: string, key = randomUUID(), purchaseOrderHint: string | null = null) {
  return ingestObligation(pool, { businessId, actorId: "test-owner", role: "OPERATOR", idempotencyKey: key, purchaseOrderHint }, image, "image/png");
}
async function obligation(business: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO ap_obligations (business_id, id, input_sha256, idempotency_key, input_fingerprint)
    VALUES ($1, $2::uuid, $3, $2::text, $3)`, [business, id, randomUUID().replaceAll("-", "").repeat(2)]);
  return id;
}
async function decision(business: string, id: string) {
  const decisionId = randomUUID();
  await pool.query(`INSERT INTO ap_decisions (business_id, id, obligation_id, obligation_version,
    action, reason, evidence_ids, policy_version, treasury_snapshot, evaluated_at, expires_at)
    VALUES ($1, $2, $3, 1, 'PAY_NOW', 'synthetic test', '[]', 1, '{}', now(), now() + interval '30 seconds')`, [business, decisionId, id]);
  return decisionId;
}
async function intent(business: string, id: string, decisionId: string) {
  const paymentId = randomUUID();
  await pool.query(`INSERT INTO ap_payment_intents (business_id, id, obligation_id, decision_id, terms,
    request_fingerprint, provider_idempotency_key, amount_micro_usdc, fee_allowance_micro_usdc)
    VALUES ($1, $2, $3, $4, '{}', $5, $6, 1500000, 10000)`, [business, paymentId, id, decisionId, "f".repeat(64), randomUUID()]);
  return paymentId;
}

async function plannedPayment(approval = false, discount = false) {
  const businessId=randomUUID(), manifest=syntheticEnrollment(businessId);
  if (discount) {
    manifest.purchaseOrders[0]!.dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    manifest.purchaseOrders[0]!.verifiedDiscount = { discountedAmountMicroUsdc: "1200000",
      validThrough: new Date(Date.now() + 86400000).toISOString().slice(0, 10), verifiedAt: new Date().toISOString(),
      verificationReference: "owner:verified-full-settlement", settlesInFull: true };
  }
  await enrollPayables(pool,{businessId,actorId:"synthetic-owner",role:"OPERATOR",paymentMode:"fixture"},manifest);
  await pool.query(`UPDATE ap_treasuries SET paused=false,policy=jsonb_set(policy,'{autoPayMaxMicroUsdc}',$2::jsonb) WHERE business_id=$1`,
    [businessId,JSON.stringify(approval?"1000000":"2000000")]);
  const saved=await upload(businessId);
  const raw = syntheticPayable();
  if (discount) raw.dueDate = { value: manifest.purchaseOrders[0]!.dueDate, sourceText: manifest.purchaseOrders[0]!.dueDate, status: "EXTRACTED" };
  await processNextObligation(pool,businessId,{modelId:"synthetic",extract:()=>Promise.resolve(raw)},syntheticPlanning());
  const decision=(await pool.query<{id:string}>("SELECT id FROM ap_decisions WHERE business_id=$1 AND obligation_id=$2",[businessId,saved.obligationId])).rows[0]!;
  return {businessId,manifest,obligationId:saved.obligationId,decisionId:decision.id};
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  for (const file of ["001_initial.sql", "002_browser_runs.sql", "003_invoice_qa.sql"]) {
    await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  await pool.query("INSERT INTO providers (ens_name) VALUES ('legacy.example.eth')");
  await pool.query(await readFile(new URL("../migrations/004_payables.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../migrations/005_worker_status.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../migrations/006_invoice_review.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../migrations/007_registry_history.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../migrations/008_verified_discount.sql", import.meta.url), "utf8"));
});
afterAll(async () => {
  await pool.end();
  // Only the generated, identifier-safe test schema is removed; no public tables.
  if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

describe("AP PostgreSQL persistence", () => {
  it("holds similar service-period invoices across different numbers and POs and stops an earlier unsubmitted decision", async () => {
    const businessId = randomUUID(), manifest = syntheticEnrollment(businessId);
    manifest.purchaseOrders.push({ ...manifest.purchaseOrders[0]!, id: "po-second" });
    await enrollPayables(pool, { businessId, actorId: "owner", role: "OPERATOR", paymentMode: "fixture" }, manifest);
    await pool.query("UPDATE ap_treasuries SET paused=false WHERE business_id=$1", [businessId]);
    const first = await upload(businessId), field = (value: string) => ({ value, sourceText: value, status: "EXTRACTED" as const });
    const raw = syntheticPayable(); raw.servicePeriod = field("September 2026");
    await processNextObligation(pool, businessId, { modelId: "synthetic", extract: () => Promise.resolve(raw) }, syntheticPlanning());
    await pool.query("UPDATE ap_obligations SET next_evaluation_at=now()+interval '5 minutes' WHERE business_id=$1 AND id=$2", [businessId, first.obligationId]);
    const second = await ingestObligation(pool, { businessId, actorId: "owner", role: "OPERATOR", idempotencyKey: randomUUID(), purchaseOrderHint: null }, Buffer.concat([image, Buffer.from("similar-test")]), "image/png");
    const changed = structuredClone(raw); changed.invoiceNumber = field("TEST-2"); changed.purchaseOrderReference = field("po-second");
    await processNextObligation(pool, businessId, { modelId: "synthetic", extract: () => Promise.resolve(changed) }, syntheticPlanning());
    expect((await createApStore(pool, 168).detail(businessId, second.obligationId))?.decision).toMatchObject({ action: "HOLD", reason: "SIMILAR_INVOICE_REQUIRES_REVIEW" });
    await pool.query("UPDATE ap_obligations SET next_evaluation_at=now() WHERE business_id=$1 AND id=$2", [businessId, first.obligationId]);
    const stopped = await reserveNextPayment(pool, businessId, new Date(), syntheticPlanning());
    expect(stopped).toMatchObject({ status: "SKIPPED", reason: "SIMILAR_INVOICE_REQUIRES_REVIEW" });
    expect((await pool.query("SELECT 1 FROM ap_payment_intents WHERE business_id=$1", [businessId])).rowCount).toBe(0);
    expect((await createApStore(pool, 168).detail(businessId, first.obligationId))?.invoice.status).toBe("OPEN");
  });
  it("builds treasury metrics from the complete ledger and withholds liquidity for unresolved inclusion", async () => {
    const p = await plannedPayment(), store = createApStore(pool, 168);
    const before = await store.overview!(p.businessId, syntheticPlanning());
    expect(before).toMatchObject({ status: "AVAILABLE", protectedObligationsMicroUsdc: "1500000" });
    await reserveNextPayment(pool, p.businessId, new Date(), syntheticPlanning());
    const held = await store.overview!(p.businessId, syntheticPlanning());
    expect(held).toMatchObject({ status: "AVAILABLE", protectedObligationsMicroUsdc: "0", dailyHoldsMicroUsdc: "1500000" });
    const providerId = randomUUID();
    await dispatchNextPayment(pool, { dispatchEnabled: true, submit: () => Promise.resolve({ providerId, providerState: "INITIATED" }) }, p.businessId, syntheticPlanning());
    const unknown = await store.overview!(p.businessId, syntheticPlanning());
    expect(unknown).toMatchObject({ status: "UNAVAILABLE", reason: "CASH_INCLUSION_UNRESOLVED", spendableMicroUsdc: null });
    expect((await store.overview!(p.businessId, null)).spendableMicroUsdc).toBeNull();
  });
  it("targets manual reconciliation by business and existing intent without any submission path", async () => {
    const p = await plannedPayment();
    const reserved = await reserveNextPayment(pool, p.businessId, new Date(), syntheticPlanning());
    if (reserved.status !== "RESERVED") throw new Error("expected reserved intent");
    await expect(reconcilePaymentForOperator(pool, "other-business", "owner", reserved.intentId, "Check existing intent", {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await reconcilePaymentForOperator(pool, p.businessId, "owner", reserved.intentId, "Check existing intent", {})).toMatchObject({ status: "WAITING", reason: "SUBMISSION_NOT_RECONCILABLE" });
    const providerId = randomUUID();
    await dispatchNextPayment(pool, { dispatchEnabled: true, submit: () => Promise.resolve({ providerId, providerState: "INITIATED" }) }, p.businessId, syntheticPlanning());
    await expect(reconcilePaymentForOperator(pool, p.businessId, "owner", reserved.intentId, "Check existing intent", {})).rejects.toMatchObject({ code: "RECONCILIATION_UNAVAILABLE" });
    let providerReads = 0;
    const result = await reconcileNextPayment(pool, { getStatus: () => { providerReads++; throw new Error("Wrong target must not query provider"); } },
      { read: () => { throw new Error("Wrong target must not query cash"); } }, { verify: () => { throw new Error("Wrong target must not query receipt"); } }, p.businessId, randomUUID());
    expect(result.status).toBe("NO_UNRESOLVED"); expect(providerReads).toBe(0);
    expect((await pool.query("SELECT 1 FROM ap_reservations WHERE business_id=$1 AND status='HELD'", [p.businessId])).rowCount).toBe(1);
  });
  it("versions registry updates, cancels affected reserved intents and refuses stale writes", async () => {
    const { businessId, obligationId } = await plannedPayment(), admin = createAdministration(pool), context = { businessId, actorId: "owner" };
    const reserved = await reserveNextPayment(pool, businessId, new Date(), syntheticPlanning());
    if (reserved.status !== "RESERVED") throw new Error("expected reservation");
    const vendor = (await admin.vendors(businessId)).vendors[0]!;
    const updated = await admin.saveVendor(context, vendor.id, { expectedVersion: vendor.addressVersion,
      address: `0x${"3".repeat(40)}`, verificationReference: "owner:updated-address", reason: "Owner verified changed address" });
    expect(updated.addressVersion).toBe(vendor.addressVersion + 1);
    expect((await createApStore(pool, 168).detail(businessId, obligationId))?.decision).toBeNull();
    expect((await pool.query<{ state: string }>("SELECT state FROM ap_payment_intents WHERE id=$1", [reserved.intentId])).rows[0]?.state).toBe("CANCELLED");
    await expect(admin.saveVendor(context, vendor.id, { expectedVersion: vendor.addressVersion, status: "BLOCKED", reason: "Stale update" })).rejects.toThrow("VERSION_CONFLICT");
    await expect(admin.saveVendor(context, vendor.id, { expectedVersion: updated.addressVersion, address: "0x3600000000000000000000000000000000000000", reason: "Invalid recipient" })).rejects.toThrow("INVALID_RECIPIENT");
    expect((await pool.query("SELECT 1 FROM ap_registry_revisions WHERE business_id=$1 AND kind='VENDOR'", [businessId])).rowCount).toBe(1);
    await expect(pool.query("UPDATE ap_registry_revisions SET reason='overwrite' WHERE business_id=$1", [businessId])).rejects.toThrow();
  });

  it("creates scoped owner vendors/POs, validates evidence and serializes competing policy updates", async () => {
    const { businessId, manifest } = await plannedPayment(), admin = createAdministration(pool), context = { businessId, actorId: "owner" };
    const source = manifest.vendors[0]!;
    const input = { id: "new-vendor", name: "Owner-approved supplier", aliases: [], status: "APPROVED" as const,
      address: `0x${"4".repeat(40)}`, chainId: 5042002 as const, category: "office", settlementCurrency: "USD" as const,
      settlementAgreementReference: "owner:agreement", verificationReference: "owner:address", verifiedAt: source.verifiedAt, reason: "Owner enrolled supplier" };
    expect((await admin.saveVendor(context, null, input)).businessId).toBe(businessId);
    await expect(admin.saveVendor(context, null, input)).rejects.toThrow("RECORD_EXISTS");
    const po = await admin.savePurchaseOrder(context, null, { id: "new-po", vendorId: input.id, amountMicroUsdc: "9007199254740993",
      deliveryAccepted: true, acceptanceReference: "owner:acceptance", description: "Owner-accepted obligation", dueDate: "2026-10-20", reason: "Verified acceptance" });
    expect(po.outstandingMicroUsdc).toBe("9007199254740993");
    const changed = await admin.savePurchaseOrder(context, po.id, { expectedVersion: 1, dueDate: "2026-10-21", reason: "Owner corrected terms" });
    expect(changed.version).toBe(2);
    await expect(admin.savePurchaseOrder(context, po.id, { expectedVersion: 2, acceptanceReference: null, reason: "Invalid acceptance" })).rejects.toThrow("INVALID_EVIDENCE");
    expect((await admin.purchaseOrders(randomUUID())).purchaseOrders).toEqual([]);
    const policy = await admin.policy(businessId), change = { expectedVersion: policy.version, policy: policy.policy, reason: "Owner reviewed budget" };
    const results = await Promise.allSettled([admin.savePolicy(context, change), admin.savePolicy(context, change)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await admin.policy(businessId)).version).toBe(policy.version + 1);
  });

  it("blocks purchase-order edits after ambiguous dispatch while allowing future vendor policy changes without releasing its hold", async () => {
    const { businessId, obligationId, manifest } = await plannedPayment(), admin = createAdministration(pool), context = { businessId, actorId: "owner" };
    const reserved = await reserveNextPayment(pool, businessId, new Date(), syntheticPlanning());
    if (reserved.status !== "RESERVED") throw new Error("expected reservation");
    await dispatchNextPayment(pool, { dispatchEnabled: true, submit: () => Promise.reject(new Error("synthetic timeout")) }, businessId, syntheticPlanning());
    await expect(admin.savePurchaseOrder(context, manifest.purchaseOrders[0]!.id,
      { expectedVersion: 1, amountMicroUsdc: "1000000", reason: "Cannot alter unresolved terms" })).rejects.toThrow("PAYMENT_IN_PROGRESS");
    await admin.saveVendor(context, manifest.vendors[0]!.id, { expectedVersion: 1, status: "BLOCKED", reason: "Block future payments" });
    const row = (await pool.query<{ state: string; status: string; version: number }>(`SELECT i.state,r.status,o.version FROM ap_payment_intents i
      JOIN ap_reservations r ON r.business_id=i.business_id AND r.intent_id=i.id
      JOIN ap_obligations o ON o.business_id=i.business_id AND o.id=i.obligation_id WHERE i.business_id=$1 AND o.id=$2`, [businessId, obligationId])).rows[0]!;
    expect(row).toMatchObject({ state: "UNKNOWN", status: "HELD", version: 2 });
  });
  it("versions owner corrections, cancels only reserved money and preserves source provenance across re-evaluation", async () => {
    const prepared = await plannedPayment(), { businessId, obligationId } = prepared;
    const reservation = await reserveNextPayment(pool, businessId, new Date(), syntheticPlanning());
    expect(reservation.status).toBe("RESERVED");
    if (reservation.status !== "RESERVED") throw new Error("expected reservation");
    const store = createApStore(pool, 168), current = (await store.detail(businessId, obligationId))!;
    const input = { commandId: randomUUID(), expectedVersion: current.invoice.version, reason: "Owner checked accepted purchase order",
      fields: { dueDate: { value: "2026-10-09", evidenceReference: "owner:po-acceptance" } } };
    const context = { businessId, actorId: "owner" };
    const corrected = await correctInvoice(pool, context, obligationId, input);
    expect(corrected.version).toBe(current.invoice.version + 1);
    expect(await correctInvoice(pool, context, obligationId, input)).toEqual(corrected);
    await expect(correctInvoice(pool, context, obligationId, { ...input, reason: "Changed command input" })).rejects.toThrow("COMMAND_CONFLICT");
    expect((await store.detail(businessId, obligationId))?.decision).toBeNull();
    expect((await pool.query<{ state: string; status: string }>(`SELECT p.state,r.status FROM ap_payment_intents p
      JOIN ap_reservations r ON r.business_id=p.business_id AND r.intent_id=p.id WHERE p.id=$1`, [reservation.intentId])).rows[0])
      .toEqual({ state: "CANCELLED", status: "RELEASED" });
    await processNextObligation(pool, businessId, null);
    const detail = (await store.detail(businessId, obligationId))!;
    expect(detail.facts?.evidence.find((item) => item.field === "dueDate"))
      .toMatchObject({ status: "OPERATOR_VERIFIED", sourceReference: "owner:po-acceptance" });
    const sources = (await pool.query<{ original_extraction: unknown; raw_extraction: unknown }>(
      "SELECT original_extraction,raw_extraction FROM ap_obligations WHERE business_id=$1 AND id=$2", [businessId, obligationId])).rows[0]!;
    expect(sources.raw_extraction).toEqual(syntheticPayable());
    expect(sources.original_extraction).toEqual(syntheticPayable());
    await expect(pool.query("UPDATE ap_obligations SET original_extraction='{}' WHERE business_id=$1 AND id=$2", [businessId, obligationId])).rejects.toThrow();
    await expect(pool.query("DELETE FROM ap_invoice_revisions WHERE business_id=$1", [businessId])).rejects.toThrow();
  });

  it("fences an old model result, makes command retries idempotent and rejects concurrent/stale owner edits", async () => {
    const businessId = randomUUID(); await treasury(businessId); const saved = await upload(businessId);
    const claim = (await claimExtraction(pool, businessId))!;
    const command = { commandId: randomUUID(), expectedVersion: claim.version, reason: "Review missing source facts" };
    const context = { businessId, actorId: "owner" };
    const outcomes = await Promise.all([evaluateInvoice(pool, context, saved.obligationId, command), evaluateInvoice(pool, context, saved.obligationId, command)]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(await finishExtraction(pool, claim, syntheticPayable(), null, "late-model")).toBe(false);
    await expect(rejectInvoice(pool, context, saved.obligationId, { ...command, commandId: randomUUID() })).rejects.toThrow("VERSION_CONFLICT");
    const newer = { ...command, commandId: randomUUID(), expectedVersion: outcomes[0].version };
    const edits = await Promise.allSettled([
      evaluateInvoice(pool, context, saved.obligationId, newer),
      rejectInvoice(pool, context, saved.obligationId, { ...newer, commandId: randomUUID() })
    ]);
    expect(edits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(evaluateInvoice(pool, { businessId: randomUUID(), actorId: "other" }, saved.obligationId, newer)).rejects.toThrow("NOT_FOUND");
  });

  it("invalidates exact approvals and refuses review after submission without releasing funds", async () => {
    const { businessId, obligationId, decisionId } = await plannedPayment(true), store = createApStore(pool, 168);
    const offer = (await store.detail(businessId, obligationId))!.approvalOffer!;
    await expect(store.approve(businessId, "owner", obligationId, decisionId, "Wrong confirmation", { ...offer, termsHash: "f".repeat(64) })).rejects.toThrow("APPROVAL_NOT_ELIGIBLE");
    await store.approve(businessId, "owner", obligationId, decisionId, "Owner approved exact exception", offer);
    await expect(store.approve(businessId, "owner", obligationId, decisionId, "Duplicate grant", offer)).rejects.toThrow("APPROVAL_ALREADY_EXISTS");
    const version = (await store.detail(businessId, obligationId))!.invoice.version;
    await evaluateInvoice(pool, { businessId, actorId: "owner" }, obligationId,
      { commandId: randomUUID(), expectedVersion: version, reason: "Refresh source evaluation" });
    const next = await reserveNextPayment(pool, businessId, new Date(), syntheticPlanning());
    expect(next.status).not.toBe("RESERVED");
    const other = await plannedPayment(), reserved = await reserveNextPayment(pool, other.businessId, new Date(), syntheticPlanning());
    if (reserved.status !== "RESERVED") throw new Error("expected reservation");
    expect((await dispatchNextPayment(pool, { dispatchEnabled: true, submit: () => Promise.reject(new Error("synthetic timeout")) },
      other.businessId, syntheticPlanning())).status).toBe("UNKNOWN");
    const current = (await store.detail(other.businessId, other.obligationId))!;
    for (const mutate of [evaluateInvoice, rejectInvoice]) await expect(mutate(pool, { businessId: other.businessId, actorId: "owner" }, other.obligationId,
      { commandId: randomUUID(), expectedVersion: current.invoice.version, reason: "Cannot change unresolved payable" })).rejects.toThrow("PAYMENT_IN_PROGRESS");
    expect((await pool.query<{ status: string }>("SELECT status FROM ap_reservations WHERE business_id=$1", [other.businessId])).rows[0]?.status).toBe("HELD");
  });

  it("audits rejection and requires an available image for a requested re-extraction", async () => {
    const businessId = randomUUID(); await treasury(businessId); const saved = await upload(businessId), context = { businessId, actorId: "owner" };
    const rejected = await rejectInvoice(pool, context, saved.obligationId, { commandId: randomUUID(), expectedVersion: 1, reason: "Not an accepted business obligation" });
    expect(rejected.status).toBe("REJECTED"); expect(await claimExtraction(pool, businessId)).toBeNull();
    const second = await obligation(businessId);
    await expect(evaluateInvoice(pool, context, second, { commandId: randomUUID(), expectedVersion: 1, reason: "Re-read source", reextract: true })).rejects.toThrow("INPUT_UNAVAILABLE");
    expect((await pool.query("SELECT 1 FROM ap_events WHERE business_id=$1 AND entity_id=$2 AND event_type='INVOICE_REJECTED'", [businessId, saved.obligationId])).rowCount).toBe(1);
  });
  it("persists scheduled planning and evidence atomically without reserving funds, surviving a fresh connection", async () => {
    const businessId = randomUUID(), manifest = syntheticEnrollment(businessId);
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    manifest.purchaseOrders[0]!.dueDate = future;
    await enrollPayables(pool, { businessId, actorId: "synthetic-owner", role: "OPERATOR", paymentMode: "fixture" }, manifest);
    await pool.query("UPDATE ap_treasuries SET paused = false WHERE business_id = $1", [businessId]);
    const saved = await upload(businessId), raw = syntheticPayable();
    raw.dueDate.value = raw.dueDate.sourceText = future;
    await processNextObligation(pool, businessId, { modelId: "synthetic-extractor", extract: () => Promise.resolve(raw) }, syntheticPlanning());
    const fresh = new Pool({ connectionString, max: 1, options: `-c search_path=${schema} -c statement_timeout=10000` });
    try {
      const detail = await createApStore(fresh, 168).detail(businessId, saved.obligationId);
      expect(detail?.decision?.action).toBe("SCHEDULE");
      const row = (await fresh.query<{ next: Date; lease_owner: string | null; treasury_snapshot: { available: boolean }; candidate: { executeAt: string } }>(
        `SELECT o.next_evaluation_at AS next, o.lease_owner, d.treasury_snapshot, d.candidate
         FROM ap_obligations o JOIN ap_decisions d ON d.business_id = o.business_id AND d.obligation_id = o.id
         WHERE o.business_id = $1`, [businessId])).rows[0]!;
      expect(row.next.toISOString()).toBe(`${future}T09:00:00.000Z`);
      expect(row.candidate.executeAt).toBe(row.next.toISOString()); expect(row.lease_owner).toBeNull();
      expect(row.treasury_snapshot.available).toBe(true); expect(await claimExtraction(fresh, businessId)).toBeNull();
      expect((await fresh.query("SELECT id FROM ap_payment_intents WHERE business_id = $1", [businessId])).rowCount).toBe(0);
      expect((await fresh.query("SELECT intent_id FROM ap_reservations WHERE business_id = $1", [businessId])).rowCount).toBe(0);
    } finally { await fresh.end(); }
  });

  it("discards a model proposal after a concurrent policy or pause change", async () => {
    const businessId = randomUUID(), manifest = syntheticEnrollment(businessId);
    await enrollPayables(pool, { businessId, actorId: "synthetic-owner", role: "OPERATOR", paymentMode: "fixture" }, manifest);
    await pool.query("UPDATE ap_treasuries SET paused = false WHERE business_id = $1", [businessId]);
    const saved = await upload(businessId);
    await processNextObligation(pool, businessId, { modelId: "synthetic", extract: () => Promise.resolve(syntheticPayable()) },
      syntheticPlanning(async () => { await pool.query("UPDATE ap_treasuries SET paused = true, policy_version = policy_version + 1 WHERE business_id = $1", [businessId]); }));
    expect((await createApStore(pool, 168).detail(businessId, saved.obligationId))?.decision)
      .toMatchObject({ action: "HOLD", reason: "PLANNING_STATE_CHANGED" });
    expect((await pool.query("SELECT id FROM ap_payment_intents WHERE business_id = $1", [businessId])).rowCount).toBe(0);
  });

  it("rechecks evidence freshness at persistence and refuses expired lease owners", async () => {
    const businessId = randomUUID(), manifest = syntheticEnrollment(businessId);
    await enrollPayables(pool, { businessId, actorId: "synthetic-owner", role: "OPERATOR", paymentMode: "fixture" }, manifest);
    await pool.query("UPDATE ap_treasuries SET paused = false WHERE business_id = $1", [businessId]);
    const saved = await upload(businessId), claim = (await claimExtraction(pool, businessId))!;
    const prepared = await preparePlanning(pool, claim, syntheticPayable(), syntheticPlanning());
    expect(prepared.decision.action).toBe("PAY_NOW");
    prepared.evidence!.cash.capturedAt = prepared.evidence!.cash.blockTimestamp = new Date(Date.now() - 31000).toISOString();
    expect(await finishExtraction(pool, claim, syntheticPayable(), null, "synthetic", prepared)).toBe(true);
    expect((await createApStore(pool, 168).detail(businessId, saved.obligationId))?.decision)
      .toMatchObject({ action: "HOLD", reason: "STALE_CASH_EVIDENCE" });
    expect(await finishExtraction(pool, claim, syntheticPayable(), null, "synthetic", prepared)).toBe(false);
  });

  it("loads business-isolated full ledger inputs without rounding money or hiding missing reservations", async () => {
    const businessId = randomUUID(), other = randomUUID();
    for (const id of [businessId, other]) {
      const manifest = syntheticEnrollment(id);
      manifest.purchaseOrders[0]!.amountMicroUsdc = manifest.purchaseOrders[0]!.outstandingMicroUsdc = "9007199254740993";
      await enrollPayables(pool, { businessId: id, actorId: "synthetic-owner", role: "OPERATOR", paymentMode: "fixture" }, manifest);
    }
    const state = await readPlanningState(pool, businessId);
    expect(state.purchaseOrders).toHaveLength(1);
    expect(state.purchaseOrders[0]).toMatchObject({ businessId, outstandingMicroUsdc: "9007199254740993" });
    expect(state.vendors.every((v) => v.businessId === businessId)).toBe(true);
    const saved = await upload(businessId), d = await decision(businessId, saved.obligationId);
    await intent(businessId, saved.obligationId, d); // Intentionally incomplete stored intent.
    await expect(readPlanningState(pool, businessId)).rejects.toThrow();
    expect((await readPlanningState(pool, other)).payments).toHaveLength(0);
  });

  it("serializes owner enrollment, starts paused, and accepts exact retries without duplicate events", async () => {
    const businessId = randomUUID();
    const context = { businessId, actorId: "synthetic-owner", role: "OPERATOR" as const, paymentMode: "fixture" as const };
    const manifest = syntheticEnrollment(businessId);
    const results = await Promise.all([enrollPayables(pool, context, manifest), enrollPayables(pool, context, manifest)]);
    expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
    expect((await pool.query<{ paused: boolean }>("SELECT paused FROM ap_treasuries WHERE business_id = $1", [businessId])).rows[0]?.paused).toBe(true);
    expect((await pool.query("SELECT event_key FROM ap_events WHERE business_id = $1", [businessId])).rowCount).toBe(2);
    expect((await pool.query("SELECT id FROM ap_payment_intents WHERE business_id = $1", [businessId])).rowCount).toBe(0);
    const saved = await upload(businessId);
    await processNextObligation(pool, businessId, { modelId: "synthetic", extract: () => Promise.resolve(syntheticPayable()) });
    expect((await createApStore(pool, 168).detail(businessId, saved.obligationId))?.decision)
      .toMatchObject({ action: "HOLD", reason: "TREASURY_EVALUATION_UNAVAILABLE" });
    expect((await enrollPayables(pool, context, manifest)).reused).toBe(true);
    expect((await pool.query<{ po: string }>("SELECT purchase_order_id AS po FROM ap_obligations WHERE business_id = $1 AND id = $2",
      [businessId, saved.obligationId])).rows[0]?.po).toBe("po");
  });
  it("rolls back partial enrollment on conflicts and never restores spent PO amounts or changes a vendor address", async () => {
    const businessId = randomUUID();
    const context = { businessId, actorId: "synthetic-owner", role: "OPERATOR" as const, paymentMode: "fixture" as const };
    const manifest = syntheticEnrollment(businessId);
    await enrollPayables(pool, context, manifest);
    const changed = structuredClone(manifest);
    changed.vendors.unshift({ ...changed.vendors[0]!, id: "new-vendor" });
    changed.purchaseOrders[0]!.description = "Conflicting terms";
    await expect(enrollPayables(pool, context, changed)).rejects.toThrow("ENROLLMENT_CONFLICT");
    expect((await pool.query("SELECT id FROM ap_vendors WHERE business_id = $1 AND id = 'new-vendor'", [businessId])).rowCount).toBe(0);
    const addressChange = structuredClone(manifest);
    addressChange.vendors[0]!.address = `0x${"3".repeat(40)}`;
    await expect(enrollPayables(pool, context, addressChange)).rejects.toThrow("ENROLLMENT_CONFLICT");
    await pool.query("UPDATE ap_purchase_orders SET outstanding_micro_usdc = 0 WHERE business_id = $1", [businessId]);
    await expect(enrollPayables(pool, context, manifest)).rejects.toThrow("ENROLLMENT_CONFLICT");
    expect((await pool.query<{ amount: string }>("SELECT outstanding_micro_usdc::text AS amount FROM ap_purchase_orders WHERE business_id = $1", [businessId])).rows[0]?.amount).toBe("0");
  });
  it("fences expired extraction claims and persists a recoverable hold when the model is unavailable", async () => {
    const business = randomUUID(); await treasury(business); await upload(business);
    const claims = await Promise.all([claimExtraction(pool, business), claimExtraction(pool, business)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find((claim) => claim !== null)!;
    await pool.query("UPDATE ap_obligations SET lease_expires_at = now() - interval '1 second' WHERE business_id = $1", [business]);
    const recovered = await claimExtraction(pool, business);
    expect(recovered?.lease_owner).not.toBe(old.lease_owner);
    expect(await finishExtraction(pool, old, syntheticPayable(), null, "synthetic")).toBe(false);
    expect(await finishExtraction(pool, recovered!, null, "EXTRACTION_UNAVAILABLE", null)).toBe(true);
    const detail = await createApStore(pool, 168).detail(business, old.id);
    expect(detail?.invoice.status).toBe("OPEN");
    expect(detail?.decision).toMatchObject({ action: "HOLD", reason: "EXTRACTION_UNAVAILABLE" });
    expect(detail?.facts).toBeNull();
    expect(await claimExtraction(pool, business)).toBeNull();
  });
  it("matches owner evidence, caches extraction and rejects a second scan with the same invoice identity", async () => {
    const business = randomUUID(); await treasury(business);
    await pool.query(`INSERT INTO ap_vendors (business_id,id,name,status,address,chain_id,category,
      settlement_currency,settlement_agreement_reference,verification_reference,verified_at)
      VALUES ($1,'vendor','Synthetic vendor','APPROVED',$2,5042002,'office','USD','agreement','owner-check',now())`,
    [business, `0x${"2".repeat(40)}`]);
    await pool.query(`INSERT INTO ap_purchase_orders (business_id,id,vendor_id,amount_micro_usdc,outstanding_micro_usdc,
      description,due_date,delivery_accepted,acceptance_reference)
      VALUES ($1,'po','vendor',1500000,1500000,'Synthetic service','2026-10-09',true,'accepted')`, [business]);
    const saved = await upload(business);
    let calls = 0;
    const extractor = { modelId: "synthetic", extract: () => { calls++; return Promise.resolve(syntheticPayable()); } };
    expect(await processNextObligation(pool, business, extractor)).toBe(true);
    const store = createApStore(pool, 168);
    expect((await store.detail(business, saved.obligationId))?.decision).toMatchObject({ action: "HOLD", reason: "TREASURY_EVALUATION_UNAVAILABLE" });
    expect((await store.detail(business, saved.obligationId))?.facts?.amountMicroUsdc).toBe("1500000");
    await pool.query("UPDATE ap_obligations SET next_evaluation_at = now() WHERE business_id = $1", [business]);
    await processNextObligation(pool, business, extractor);
    expect(calls).toBe(1);
    const second = await obligation(business);
    const next = await claimExtraction(pool, business);
    expect(next?.id).toBe(second);
    expect(await finishExtraction(pool, next!, syntheticPayable(), null, "synthetic")).toBe(true);
    expect((await store.detail(business, second))?.decision).toMatchObject({ action: "REJECT", reason: "DUPLICATE_INVOICE_IDENTITY" });
    expect((await pool.query("SELECT id FROM ap_payment_intents WHERE business_id = $1", [business])).rowCount).toBe(0);
  });
  it("holds failed model calls without storing private exception text", async () => {
    const business = randomUUID(); await treasury(business); const saved = await upload(business);
    await processNextObligation(pool, business, { modelId: "synthetic", extract: () => Promise.reject(new Error("private-secret-marker")) });
    const detail = await createApStore(pool, 168).detail(business, saved.obligationId);
    expect(detail?.decision).toMatchObject({ action: "HOLD", reason: "EXTRACTION_FAILED" });
    const events = await pool.query<{ payload: unknown }>("SELECT payload FROM ap_events WHERE business_id = $1", [business]);
    expect(JSON.stringify(events.rows)).not.toContain("private-secret-marker");
  });
  it("reads API views and private images only for the requested business", async () => {
    const business = randomUUID(), other = randomUUID(); await treasury(business); await treasury(other);
    const saved = await upload(business);
    const store = createApStore(pool, 168);
    expect((await store.list(business, 0)).invoices[0]?.id).toBe(saved.obligationId);
    expect((await store.detail(business, saved.obligationId))?.invoice.status).toBe("RECEIVED");
    expect((await store.audit(business, saved.obligationId))?.events[0]?.type).toBe("INVOICE_RECEIVED");
    expect((await store.image(business, saved.obligationId))?.bytes.equals(image)).toBe(true);
    expect(await store.detail(other, saved.obligationId)).toBeNull();
    expect(await store.audit(other, saved.obligationId)).toBeNull();
    expect(await store.image(other, saved.obligationId)).toBeNull();
  });
  it("exposes owned source metadata without bytes and preserves the hash after source retention cleanup", async () => {
    const business = randomUUID(), other = randomUUID(); await treasury(business); await treasury(other);
    const saved = await upload(business), store = createApStore(pool,168);
    const detail = await store.detail(business,saved.obligationId);
    expect(detail?.source).toEqual({sha256:createHash("sha256").update(image).digest("hex"),mimeType:"image/png",byteSize:image.length,retained:true,uploadedBy:"test-owner"});
    expect(detail?.verification).toMatchObject({status:"HOLD",reasons:["MISSING_OR_INVALID_EVIDENCE"]});
    expect(JSON.stringify(detail)).not.toContain(image.toString("base64"));
    expect(await store.detail(other,saved.obligationId)).toBeNull();
    await pool.query("DELETE FROM ap_inputs WHERE business_id=$1 AND obligation_id=$2",[business,saved.obligationId]);
    expect((await store.detail(business,saved.obligationId))?.source).toEqual({...detail!.source,mimeType:null,byteSize:null,retained:false});
  });
  it("reports current verification separately when acceptance changes after a stored decision", async () => {
    const planned = await plannedPayment(true), store = createApStore(pool,168);
    const before = await store.detail(planned.businessId,planned.obligationId);
    expect(before?.verification).toEqual({status:"VERIFIED",reasons:[]});
    await pool.query("UPDATE ap_purchase_orders SET delivery_accepted=false WHERE business_id=$1",[planned.businessId]);
    const after = await store.detail(planned.businessId,planned.obligationId);
    expect(after?.verification).toMatchObject({status:"HOLD",reasons:["DELIVERY_NOT_ACCEPTED"]});
    expect(after?.decision?.id).toBe(before?.decision?.id);
  });
  it("migrates over legacy data without changing it", async () => {
    expect((await pool.query("SELECT ens_name FROM providers")).rows).toEqual([{ ens_name: "legacy.example.eth" }]);
  });

  it("serializes concurrent retries and persists only one image and audit event", async () => {
    const business = randomUUID(); await treasury(business);
    const key = randomUUID();
    const results = await Promise.all([upload(business, key), upload(business, key)]);
    expect(results[0]?.obligationId).toBe(results[1]?.obligationId);
    expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ap_inputs WHERE business_id = $1", [business])).rows[0]?.n).toBe(1);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ap_events WHERE business_id = $1", [business])).rows[0]?.n).toBe(1);
    await expect(upload(business, key, "changed-po")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(upload(business)).rejects.toMatchObject({ code: "DUPLICATE_INPUT" });
  });

  it("rejects reviewers and mismatched image bytes before persistence", async () => {
    const business = randomUUID(); await treasury(business);
    await expect(ingestObligation(pool, { businessId: business, actorId: "reviewer",
      role: "REVIEWER" as "OPERATOR", idempotencyKey: "a", purchaseOrderHint: null }, image, "image/png")).rejects.toThrow();
    await expect(ingestObligation(pool, { businessId: business, actorId: "owner",
      role: "OPERATOR", idempotencyKey: "a", purchaseOrderHint: null }, image, "image/jpeg")).rejects.toThrow();
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ap_obligations WHERE business_id = $1", [business])).rows[0]?.n).toBe(0);
  });

  it("rejects fractional/negative/overflow money without rounding", async () => {
    for (const value of ["0.1", "-1", "100000000000000000000", "NaN", "Infinity"]) {
      await expect(pool.query("SELECT $1::ap_micro_usdc", [value])).rejects.toMatchObject({ code: "23514" });
    }
    expect((await pool.query<{ n: string }>("SELECT '99999999999999999999'::ap_micro_usdc::text AS n")).rows[0]?.n).toBe("99999999999999999999");
  });

  it("enforces business ownership and one active invoice per accepted PO", async () => {
    const business = randomUUID(), other = randomUUID(); await treasury(business); await treasury(other);
    await pool.query(`INSERT INTO ap_vendors (business_id, id, name, status, address, chain_id, category,
      settlement_currency, settlement_agreement_reference, verification_reference, verified_at)
      VALUES ($1, 'vendor', 'Synthetic vendor', 'APPROVED', $2, 5042002, 'office', 'USD', 'agreement', 'owner-check', now())`, [business, `0x${"2".repeat(40)}`]);
    await pool.query(`INSERT INTO ap_purchase_orders (business_id, id, vendor_id, amount_micro_usdc,
      outstanding_micro_usdc, description, due_date, delivery_accepted, acceptance_reference)
      VALUES ($1, 'po', 'vendor', 1500000, 1500000, 'Synthetic service', '2026-10-09', true, 'accepted')`, [business]);
    const first = await obligation(business), second = await obligation(business), foreign = await obligation(other);
    await expect(pool.query("UPDATE ap_obligations SET vendor_id = 'vendor' WHERE business_id = $1 AND id = $2", [other, foreign])).rejects.toMatchObject({ code: "23503" });
    await pool.query("UPDATE ap_obligations SET vendor_id = 'vendor', purchase_order_id = 'po', normalized_invoice_number = 'INV-1' WHERE business_id = $1 AND id = $2", [business, first]);
    await expect(pool.query("UPDATE ap_obligations SET vendor_id = 'vendor', normalized_invoice_number = 'INV-1' WHERE business_id = $1 AND id = $2", [business, second])).rejects.toMatchObject({ code: "23505" });
    await expect(pool.query("UPDATE ap_obligations SET vendor_id = 'vendor', purchase_order_id = 'po' WHERE business_id = $1 AND id = $2", [business, second])).rejects.toMatchObject({ code: "23505" });
  });

  it("blocks competing intents, term changes and resubmission of unknown attempts", async () => {
    const business = randomUUID(); await treasury(business);
    const first = await obligation(business), second = await obligation(business);
    const d1 = await decision(business, first), d2 = await decision(business, second);
    const results = await Promise.allSettled([intent(business, first, d1), intent(business, second, d2)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((r) => r.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("missing winning intent");
    const id = winner.value;
    await expect(pool.query("UPDATE ap_payment_intents SET amount_micro_usdc = 1 WHERE business_id = $1 AND id = $2", [business, id])).rejects.toMatchObject({ code: "23514" });
    await pool.query("UPDATE ap_payment_intents SET state = 'SUBMITTING', submitted_at = now() WHERE business_id = $1 AND id = $2", [business, id]);
    await pool.query("UPDATE ap_payment_intents SET state = 'UNKNOWN', lease_owner = NULL, lease_expires_at = NULL WHERE business_id = $1 AND id = $2", [business, id]);
    await expect(pool.query("UPDATE ap_payment_intents SET state = 'RESERVED' WHERE business_id = $1 AND id = $2", [business, id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE ap_payment_intents SET state = 'SETTLED', transaction_hash = $3 WHERE business_id = $1 AND id = $2", [business, id, `0x${"a".repeat(64)}`])).rejects.toMatchObject({ code: "23514" });
    await expect(intent(business, second, d2)).rejects.toMatchObject({ code: "23505" });
  });

  it("creates one immutable reservation from a verified planned payable and rejects its retry", async () => {
    const businessId = randomUUID(), manifest = syntheticEnrollment(businessId);
    await enrollPayables(pool, { businessId, actorId: "synthetic-owner", role: "OPERATOR", paymentMode: "fixture" }, manifest);
    await pool.query(`UPDATE ap_treasuries SET paused = false,
      policy = jsonb_set(policy, '{autoPayMaxMicroUsdc}', '"2000000"') WHERE business_id = $1`, [businessId]);
    const saved = await upload(businessId);
    await processNextObligation(pool, businessId, { modelId: "synthetic", extract: () => Promise.resolve(syntheticPayable()) }, syntheticPlanning());
    const planned = (await pool.query<{ decision_id: string; snapshot: { snapshot: { capturedAt: string; feeAllowanceMicroUsdc: string }; cash: { blockHash: string }; ledgerFingerprint: string; fee: { evidenceReference: string } } }>(
      `SELECT d.id AS decision_id, d.treasury_snapshot AS snapshot FROM ap_decisions d
       WHERE d.business_id = $1 AND d.obligation_id = $2`, [businessId, saved.obligationId])).rows[0]!;
    const now = new Date(Date.parse(planned.snapshot.snapshot.capturedAt) + 1000).toISOString();
    const request = { businessId, obligationId: saved.obligationId, decisionId: planned.decision_id, actorId: "payment-worker",
      feeAllowanceMicroUsdc: planned.snapshot.snapshot.feeAllowanceMicroUsdc, now,
      evidence: { cashBlockHash: planned.snapshot.cash.blockHash, capturedAt: planned.snapshot.snapshot.capturedAt,
        ledgerFingerprint: planned.snapshot.ledgerFingerprint, feeEvidenceReference: planned.snapshot.fee.evidenceReference } };
    const result = await reserveNextPayment(pool, businessId, new Date(now));
    expect(result.status).toBe("RESERVED");
    if (result.status !== "RESERVED") throw new Error("reservation did not complete");
    expect(result.providerIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect((await pool.query<{ state: string; amount: string; fee: string; provider_key: string }>(
      `SELECT state, amount_micro_usdc::text AS amount, fee_allowance_micro_usdc::text AS fee,
        provider_idempotency_key::text AS provider_key FROM ap_payment_intents WHERE business_id = $1 AND id = $2`,
      [businessId, result.intentId])).rows[0]).toMatchObject({ state: "RESERVED", amount: "1500000", fee: request.feeAllowanceMicroUsdc, provider_key: result.providerIdempotencyKey });
    expect((await pool.query<{ status: string }>("SELECT status FROM ap_reservations WHERE business_id = $1 AND intent_id = $2", [businessId, result.intentId])).rows[0]?.status).toBe("HELD");
    const dispatched = await dispatchNextPayment(pool, { dispatchEnabled: true, submit: (request) => {
      expect(request).toMatchObject({ walletId: manifest.treasury.walletId, recipient: manifest.vendors[0]!.address,
        amountMicroUsdc: "1500000", providerIdempotencyKey: result.providerIdempotencyKey });
      return Promise.resolve({ providerId: "00000000-0000-4000-8000-000000000099", providerState: "INITIATED" });
    } }, businessId, syntheticPlanning());
    expect(dispatched).toMatchObject({ status: "PENDING", intentId: result.intentId, providerId: "00000000-0000-4000-8000-000000000099" });
    expect((await pool.query<{ state: string; provider_id: string; provider_state: string }>("SELECT state, provider_id, provider_state FROM ap_payment_intents WHERE business_id = $1 AND id = $2", [businessId, result.intentId])).rows[0]).toMatchObject({ state: "PENDING", provider_id: "00000000-0000-4000-8000-000000000099", provider_state: "INITIATED" });
    const settlementHash = `0x${"b".repeat(64)}`;
    const settled = await reconcileNextPayment(pool,
      { getStatus: () => Promise.resolve({ providerId: "00000000-0000-4000-8000-000000000099", providerState: "COMPLETE", transactionHash: settlementHash, errorReason: null }) },
      { read: () => Promise.resolve({ chainId: 5042002 as const, tokenAddress: "0x3600000000000000000000000000000000000000" as const,
        walletAddress: manifest.treasury.walletAddress, cashMicroUsdc: "20000000", blockNumber: "100", blockHash: `0x${"a".repeat(64)}`,
        blockTimestamp: new Date().toISOString(), capturedAt: new Date().toISOString(), observedAt: new Date().toISOString() }) },
      { verify: (request) => { expect(request).toMatchObject({ transactionHash: settlementHash, recipient: manifest.vendors[0]!.address, amountMicroUsdc: "1500000" });
        return Promise.resolve({ chainId:5042002,tokenAddress:"0x3600000000000000000000000000000000000000",walletAddress:manifest.treasury.walletAddress,
          recipient:manifest.vendors[0]!.address,blockNumber:"99",blockHash:`0x${"c".repeat(64)}`,cashBlockHash:`0x${"a".repeat(64)}`,
          transactionHash: settlementHash, amountMicroUsdc: "1500000", actualFeeMicroUsdc: "21", outcome: "SUCCESS", verificationReference: "arc-test-receipt" }); } }, businessId);
    expect(settled).toMatchObject({ status: "SETTLED", intentId: result.intentId, transactionHash: settlementHash });
    expect((await pool.query<{ state: string; transaction_hash: string; actual_fee: string }>("SELECT state, transaction_hash, actual_fee_micro_usdc::text AS actual_fee FROM ap_payment_intents WHERE business_id = $1 AND id = $2", [businessId, result.intentId])).rows[0]).toMatchObject({ state: "SETTLED", transaction_hash: settlementHash, actual_fee: "21" });
    expect((await pool.query<{ status: string }>("SELECT status FROM ap_reservations WHERE business_id = $1 AND intent_id = $2", [businessId, result.intentId])).rows[0]?.status).toBe("CONSUMED");
    const obligationId = (await pool.query<{ obligation_id: string }>("SELECT obligation_id FROM ap_payment_intents WHERE business_id = $1 AND id = $2", [businessId, result.intentId])).rows[0]!.obligation_id;
    expect((await pool.query<{ status: string; outstanding: string }>("SELECT o.status, p.outstanding_micro_usdc::text AS outstanding FROM ap_obligations o JOIN ap_purchase_orders p ON p.business_id = o.business_id AND p.id = o.purchase_order_id WHERE o.business_id = $1 AND o.id = $2", [businessId, obligationId])).rows[0]).toMatchObject({ status: "SETTLED", outstanding: "0" });
    const retry = await reserveNextPayment(pool, businessId, new Date(now));
    expect(retry).toMatchObject({ status: "NO_DUE" });
    expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM ap_payment_intents WHERE business_id = $1", [businessId])).rows[0]?.count).toBe(1);
  });

  it("requires and consumes an exact operator approval before reserving above-threshold payment", async () => {
    const businessId = randomUUID(), manifest = syntheticEnrollment(businessId);
    await enrollPayables(pool, { businessId, actorId: "synthetic-owner", role: "OPERATOR", paymentMode: "fixture" }, manifest);
    await pool.query(`UPDATE ap_treasuries SET paused = false,
      policy = jsonb_set(policy, '{autoPayMaxMicroUsdc}', '"1000000"') WHERE business_id = $1`, [businessId]);
    const saved = await upload(businessId);
    await processNextObligation(pool, businessId, { modelId: "synthetic", extract: () => Promise.resolve(syntheticPayable()) }, syntheticPlanning());
    const decision = (await pool.query<{ id: string }>("SELECT id FROM ap_decisions WHERE business_id = $1 AND obligation_id = $2", [businessId, saved.obligationId])).rows[0]!;
    expect((await pool.query<{ action: string }>("SELECT action FROM ap_decisions WHERE business_id = $1 AND id = $2", [businessId, decision.id])).rows[0]?.action).toBe("REQUIRE_APPROVAL");
    const approval = await createApStore(pool, 168).approve(businessId, "owner", saved.obligationId, decision.id, "Reviewed exception");
    expect(approval.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    const binding = (await pool.query<{ terms: unknown; wallet_id: string; obligation_version: number; vendor_id: string; address_version: number; address: string; po_id: string; po_version: number; policy_version: number }>(
      `SELECT a.terms, t.wallet_id, o.version AS obligation_version, o.vendor_id, v.address_version, v.address,
        o.purchase_order_id AS po_id, po.version AS po_version, d.policy_version
       FROM ap_approvals a JOIN ap_obligations o ON o.business_id = a.business_id AND o.id = a.obligation_id
       JOIN ap_vendors v ON v.business_id = o.business_id AND v.id = o.vendor_id
       JOIN ap_purchase_orders po ON po.business_id = o.business_id AND po.id = o.purchase_order_id
       JOIN ap_decisions d ON d.business_id = a.business_id AND d.id = a.decision_id
       JOIN ap_treasuries t ON t.business_id = a.business_id
       WHERE a.business_id = $1 AND a.id = $2`, [businessId, approval.approvalId])).rows[0]!;
    expect(binding.terms).toMatchObject({ businessId, obligationId: saved.obligationId, decisionId: decision.id,
      walletId: binding.wallet_id, obligationVersion: binding.obligation_version, vendorId: binding.vendor_id,
      vendorAddressVersion: binding.address_version, purchaseOrderId: binding.po_id, purchaseOrderVersion: binding.po_version,
      policyVersion: binding.policy_version, recipient: binding.address, amountMicroUsdc: "1500000", chainId: 5042002,
      token: "0x3600000000000000000000000000000000000000" });
    const approvalRow = (await pool.query<{ id: string; terms: unknown; actor_id: string; role: string; granted: boolean; reason: string; granted_at: Date; expires_at: Date; consumed_at: Date | null }>(
      "SELECT id, terms, actor_id, role, granted, reason, granted_at, expires_at, consumed_at FROM ap_approvals WHERE business_id = $1 AND id = $2",
      [businessId, approval.approvalId])).rows[0]!;
    const approvalShape = { id: approvalRow.id, terms: approvalRow.terms, actorId: approvalRow.actor_id, role: approvalRow.role,
      granted: approvalRow.granted, reason: approvalRow.reason, grantedAt: approvalRow.granted_at.toISOString(),
      expiresAt: approvalRow.expires_at.toISOString(), consumedAt: approvalRow.consumed_at?.toISOString() ?? null };
    const parsedApproval = payableApprovalSchema.safeParse(approvalShape);
    if (!parsedApproval.success) throw new Error(JSON.stringify(parsedApproval.error.issues));
    expect(isExactApprovalValid(approvalShape, binding.terms, new Date().toISOString())).toBe(true);
    const result = await reserveNextPayment(pool, businessId, new Date());
    expect(result.status).toBe("RESERVED");
    if (result.status !== "RESERVED") throw new Error("approval reservation did not complete");
    expect((await pool.query<{ approval_id: string }>("SELECT approval_id FROM ap_payment_intents WHERE business_id = $1 AND id = $2", [businessId, result.intentId])).rows[0]?.approval_id).toBe(approval.approvalId);
  });

  it("prevents mutation of decision and audit records", async () => {
    const business = randomUUID(); await treasury(business);
    const invoice = await upload(business); await decision(business, invoice.obligationId);
    await expect(pool.query("DELETE FROM ap_events WHERE business_id = $1", [business])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE ap_decisions SET reason = 'rewrite' WHERE business_id = $1", [business])).rejects.toMatchObject({ code: "23514" });
  });

  it("retains unresolved inputs and deletes terminal expired images with audit evidence", async () => {
    const business = randomUUID(); await treasury(business);
    const invoice = await upload(business);
    await pool.query("UPDATE ap_inputs SET expires_at = now() - interval '1 hour' WHERE business_id = $1", [business]);
    expect(await cleanupExpiredInputs(pool, business)).toBe(0);
    await pool.query("UPDATE ap_obligations SET status = 'REJECTED' WHERE business_id = $1", [business]);
    const d = await decision(business, invoice.obligationId);
    const payment = await intent(business, invoice.obligationId, d);
    expect(await cleanupExpiredInputs(pool, business)).toBe(0);
    await pool.query("UPDATE ap_payment_intents SET state = 'CANCELLED' WHERE business_id = $1 AND id = $2", [business, payment]);
    expect(await cleanupExpiredInputs(pool, business)).toBe(1);
    expect(await cleanupExpiredInputs(pool, business)).toBe(0);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ap_events WHERE business_id = $1 AND event_type = 'INPUT_REMOVED'", [business])).rows[0]?.n).toBe(1);
    expect((await pool.query("SELECT input_sha256 FROM ap_obligations WHERE business_id = $1", [business])).rowCount).toBe(1);
  });
});

// Isolated real PostgreSQL checks of competing workers and fail-closed dispatch.
describe("payment recovery and authorization", () => {
  it("serializes competing reservations and competing dispatchers", async () => {
    const p=await plannedPayment();
    const reserved=await Promise.all([reserveNextPayment(pool,p.businessId,new Date(),syntheticPlanning()),reserveNextPayment(pool,p.businessId,new Date(),syntheticPlanning())]);
    expect(reserved.filter(r=>r.status==="RESERVED")).toHaveLength(1);
    let submissions=0;
    const adapter={dispatchEnabled:true,submit:()=>{submissions++;return Promise.resolve({providerId:randomUUID(),providerState:"INITIATED"});}};
    await Promise.all([dispatchNextPayment(pool,adapter,p.businessId,syntheticPlanning()),dispatchNextPayment(pool,adapter,p.businessId,syntheticPlanning())]);
    expect(submissions).toBe(1);
    expect((await pool.query("SELECT 1 FROM ap_reservations WHERE business_id=$1 AND status='HELD'",[p.businessId])).rowCount).toBe(1);
  });
  it.each(["pause","vendor","policy","purchase-order","cash","fee"])("does not submit after %s changes",async(change)=>{
    const p=await plannedPayment();
    expect((await reserveNextPayment(pool,p.businessId,new Date(),syntheticPlanning())).status).toBe("RESERVED");
    if(change==="pause") await pool.query("UPDATE ap_treasuries SET paused=true WHERE business_id=$1",[p.businessId]);
    if(change==="vendor") await pool.query("UPDATE ap_vendors SET address_version=address_version+1 WHERE business_id=$1",[p.businessId]);
    if(change==="policy") await pool.query("UPDATE ap_treasuries SET policy_version=policy_version+1 WHERE business_id=$1",[p.businessId]);
    if(change==="purchase-order") await pool.query("UPDATE ap_purchase_orders SET version=version+1 WHERE business_id=$1",[p.businessId]);
    const readers=syntheticPlanning(), originalCash=readers.readCash.bind(readers), originalFee=readers.estimateFee.bind(readers);
    if(change==="cash") readers.readCash=async t=>({...await originalCash(t),cashMicroUsdc:"1"});
    if(change==="fee") readers.estimateFee=async(c,r,a)=>({...await originalFee(c,r,a),maxFeePerGasNative:"2000000000"});
    let submissions=0;
    const result=await dispatchNextPayment(pool,{dispatchEnabled:true,submit:()=>{submissions++;throw new Error("must not submit");}},p.businessId,readers);
    expect(result.status).toBe("CANCELLED");expect(submissions).toBe(0);
    expect((await pool.query("SELECT 1 FROM ap_reservations WHERE business_id=$1 AND status='RELEASED'",[p.businessId])).rowCount).toBe(1);
  });
  it("retains an uncertain submission across restart without replay",async()=>{
    const p=await plannedPayment();
    await reserveNextPayment(pool,p.businessId,new Date(),syntheticPlanning());
    let submissions=0;
    const issue={code:"CIRCLE_UNAVAILABLE" as const,stage:"TRANSFER_REQUEST" as const,httpStatus:400,providerCode:"2",requestId:randomUUID()};
    const adapter={dispatchEnabled:true,submit:()=>{submissions++;throw new CircleTransferError("CIRCLE_UNAVAILABLE",issue);}};
    expect((await dispatchNextPayment(pool,adapter,p.businessId,syntheticPlanning())).status).toBe("UNKNOWN");
    await recoverSubmittingPayments(pool,p.businessId);
    expect((await dispatchNextPayment(pool,adapter,p.businessId,syntheticPlanning())).status).toBe("NO_RESERVED");
    expect((await reserveNextPayment(pool,p.businessId,new Date(),syntheticPlanning())).status).toBe("NO_DUE");
    expect(submissions).toBe(1);
    const detail=await createApStore(pool,168).detail(p.businessId,p.obligationId);
    expect(detail?.payment).toMatchObject({state:"UNKNOWN",submissionIssue:issue});
    const event=(await pool.query<{payload:{requestId:string}}>("SELECT payload FROM ap_events WHERE business_id=$1 AND event_type='PAYMENT_SUBMITTING'",[p.businessId])).rows[0];
    expect(event?.payload.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect((await pool.query("SELECT 1 FROM ap_reservations WHERE business_id=$1 AND status='HELD'",[p.businessId])).rowCount).toBe(1);
  });
  it("closes only the exact human-confirmed validation rejection and invalidates its old authorization",async()=>{
    const p=await plannedPayment();
    const reserved=await reserveNextPayment(pool,p.businessId,new Date(),syntheticPlanning());
    if(reserved.status!=="RESERVED")throw Error("reservation failed");
    await dispatchNextPayment(pool,{dispatchEnabled:true,submit:()=>Promise.reject(Error("synthetic rejection"))},p.businessId,syntheticPlanning());
    const original=(await pool.query<{submitted_at:Date}>("SELECT submitted_at FROM ap_payment_intents WHERE business_id=$1 AND id=$2",[p.businessId,reserved.intentId])).rows[0]!;
    const proof={providerIdempotencyKey:reserved.providerIdempotencyKey,providerRequestId:"a".repeat(32),requestedAt:original.submitted_at.toISOString(),httpStatus:400,providerCode:2,reason:"TOKEN_ID_AND_BLOCKCHAIN_MISSING",evidenceReference:"synthetic:provider-log"};
    for(const invalid of [{...proof,providerIdempotencyKey:randomUUID()},{...proof,requestedAt:"2020-01-01T00:00:00.000Z"},{...proof,httpStatus:500}]){
      await expect(resolveRejectedSubmission(pool,p.businessId,reserved.intentId,"synthetic-operator",invalid)).rejects.toThrow();
      expect((await createApStore(pool,168).detail(p.businessId,p.obligationId))?.payment?.state).toBe("UNKNOWN");
    }
    await expect(resolveRejectedSubmission(pool,"another-business",reserved.intentId,"synthetic-operator",proof)).rejects.toThrow();
    const result=await resolveRejectedSubmission(pool,p.businessId,reserved.intentId,"synthetic-operator",proof);
    expect(result.status).toBe("FAILED");
    const detail=await createApStore(pool,168).detail(p.businessId,p.obligationId);
    expect(detail?.invoice.version).toBe(result.version);expect(detail?.decision).toBeNull();expect(detail?.approvalOffer).toBeNull();
    expect(detail?.payment?.state).toBe("FAILED");
    const ledger=await readPlanningState(pool,p.businessId);
    expect(ledger.payments[0]?.submissionRejection).toMatchObject({httpStatus:400,providerCode:2,providerRequestId:proof.providerRequestId,evidenceReference:proof.evidenceReference});
    expect(ledger.payments[0]?.receipt).toBeNull();
    expect((await reserveNextPayment(pool,p.businessId,new Date(),syntheticPlanning())).status).toBe("NO_DUE");
    expect((await pool.query("SELECT 1 FROM ap_reservations WHERE business_id=$1 AND status='RELEASED'",[p.businessId])).rowCount).toBe(1);
    const events=(await pool.query<{payload:unknown}>("SELECT payload FROM ap_events WHERE business_id=$1 AND event_type='PAYMENT_SUBMISSION_REJECTED'",[p.businessId])).rows;
    expect(events).toHaveLength(1);expect(JSON.stringify(events)).not.toContain(reserved.providerIdempotencyKey);
    await expect(resolveRejectedSubmission(pool,p.businessId,reserved.intentId,"synthetic-operator",proof)).rejects.toThrow();
  });
  it("recovers an expired submission lease to UNKNOWN with its original key and hold",async()=>{
    const p=await plannedPayment();
    const r=await reserveNextPayment(pool,p.businessId,new Date(),syntheticPlanning());
    if(r.status!=="RESERVED") throw new Error("reservation failed");
    await pool.query("UPDATE ap_payment_intents SET state='SUBMITTING',submitted_at=now(),lease_owner='synthetic-worker',lease_expires_at=now()-interval '1 second' WHERE business_id=$1",[p.businessId]);
    expect(await recoverSubmittingPayments(pool,p.businessId)).toBe(1);
    expect(await recoverSubmittingPayments(pool,p.businessId)).toBe(0);
    expect((await pool.query("SELECT state,provider_idempotency_key::text AS key FROM ap_payment_intents WHERE business_id=$1",[p.businessId])).rows[0])
      .toEqual({state:"UNKNOWN",key:r.providerIdempotencyKey});
    expect((await pool.query<{status:string}>("SELECT status FROM ap_reservations WHERE business_id=$1",[p.businessId])).rows[0]?.status).toBe("HELD");
  });
  it("preserves an exact approval on the processing queue and still enforces hard limits",async()=>{
    const p=await plannedPayment(true);
    await createApStore(pool,168).approve(p.businessId,"owner",p.obligationId,p.decisionId,"Reviewed");
    expect(await claimExtraction(pool,p.businessId)).toBeNull();
    const readers=syntheticPlanning(), cash=readers.readCash.bind(readers);
    readers.readCash=async t=>({...await cash(t),cashMicroUsdc:"1"});
    expect((await reserveNextPayment(pool,p.businessId,new Date(),readers)).status).toBe("SKIPPED");
    expect((await pool.query("SELECT 1 FROM ap_payment_intents WHERE business_id=$1",[p.businessId])).rowCount).toBe(0);
  });
  it("rejects approval of a stale vendor version",async()=>{
    const p=await plannedPayment(true);
    await pool.query("UPDATE ap_vendors SET address_version=address_version+1 WHERE business_id=$1",[p.businessId]);
    await expect(createApStore(pool,168).approve(p.businessId,"owner",p.obligationId,p.decisionId,"Reviewed"))
      .rejects.toMatchObject({code:"APPROVAL_NOT_ELIGIBLE"});
  });
});


describe("atomic terminal evidence",()=>{
  async function pending(discount = false) {
    const p=await plannedPayment(false, discount);
    await reserveNextPayment(pool,p.businessId,new Date(),syntheticPlanning());
    const providerId=randomUUID();
    await dispatchNextPayment(pool,{dispatchEnabled:true,submit:()=>Promise.resolve({providerId,providerState:"INITIATED"})},p.businessId,syntheticPlanning());
    const cash=await syntheticPlanning().readCash((await readPlanningState(pool,p.businessId)).treasury);
    const receipt={chainId:5042002,tokenAddress:"0x3600000000000000000000000000000000000000",walletAddress:p.manifest.treasury.walletAddress,
      recipient:p.manifest.vendors[0]!.address,blockNumber:"99",blockHash:`0x${"c".repeat(64)}`,cashBlockHash:cash.blockHash,
      transactionHash:`0x${randomUUID().replaceAll("-", "").repeat(2)}`,amountMicroUsdc:discount?"1200000":"1500000",actualFeeMicroUsdc:"21",actualFeeNative:"21000000000000",outcome:"SUCCESS",verificationReference:"synthetic-independent-receipt"};
    const reconcile=(state="COMPLETE")=>reconcileNextPayment(pool,{getStatus:()=>Promise.resolve({providerId,providerState:state,transactionHash:receipt.transactionHash,errorReason:null})},
      {read:()=>Promise.resolve(cash)},{verify:()=>Promise.resolve(receipt)},p.businessId);
    return {...p,reconcile,receipt};
  }
  it("settles a verified discounted full payment with exact payout and no nominal PO residual", async () => {
    const p = await pending(true);
    const stored = (await pool.query<{ terms: Record<string, string>; amount: string }>(
      "SELECT terms,amount_micro_usdc::text AS amount FROM ap_payment_intents WHERE business_id=$1", [p.businessId])).rows[0]!;
    expect(stored.amount).toBe("1200000");
    expect(stored.terms).toMatchObject({ nominalAmountMicroUsdc: "1500000", discountAdjustmentMicroUsdc: "300000", amountMicroUsdc: "1200000" });
    expect((await p.reconcile()).status).toBe("SETTLED");
    const audit = await createApStore(pool, 168).audit(p.businessId, p.obligationId);
    expect(audit?.payment).toMatchObject({ payoutAmountMicroUsdc: "1200000", nominalAmountMicroUsdc: "1500000", discountAdjustmentMicroUsdc: "300000" });
    expect(audit?.decisions?.[0]?.treasury?.discountComparison).toMatchObject({ payoutAmountMicroUsdc: "1200000", discountAdjustmentMicroUsdc: "300000", cashPreservationCostMicroUsdc: "0" });
    expect(audit?.decisions?.[0]?.versions).toMatchObject({ policy: 1, purchaseOrder: 1 });
    expect((await pool.query<{ remaining: string }>("SELECT outstanding_micro_usdc::text AS remaining FROM ap_purchase_orders WHERE business_id=$1", [p.businessId])).rows[0]?.remaining).toBe("0");
    expect((await p.reconcile()).status).toBe("NO_UNRESOLVED");
  });
  it("binds discounted approval offers and grants to nominal, adjustment and actual payout", async () => {
    const p = await plannedPayment(true, true), store = createApStore(pool, 168);
    const offer = (await store.detail(p.businessId, p.obligationId))?.approvalOffer;
    expect(offer?.terms).toMatchObject({ amountMicroUsdc: "1200000", nominalAmountMicroUsdc: "1500000", discountAdjustmentMicroUsdc: "300000" });
    await store.approve(p.businessId, "owner", p.obligationId, p.decisionId, "Reviewed exact discount", offer!);
    expect((await reserveNextPayment(pool, p.businessId, new Date(), syntheticPlanning())).status).toBe("RESERVED");
  });
  it("rolls back every settlement change on a PO conflict, then completes exactly once",async()=>{
    const p=await pending();
    await pool.query("UPDATE ap_purchase_orders SET outstanding_micro_usdc=1 WHERE business_id=$1",[p.businessId]);
    expect((await p.reconcile()).status).toBe("WAITING");
    expect((await pool.query<{state:string}>("SELECT state FROM ap_payment_intents WHERE business_id=$1",[p.businessId])).rows[0]?.state).toBe("PENDING");
    expect((await pool.query<{status:string}>("SELECT status FROM ap_reservations WHERE business_id=$1",[p.businessId])).rows[0]?.status).toBe("HELD");
    await pool.query("UPDATE ap_purchase_orders SET outstanding_micro_usdc=1500000 WHERE business_id=$1",[p.businessId]);
    const results=await Promise.all([p.reconcile(),p.reconcile()]);
    expect(results.filter(r=>r.status==="SETTLED"),JSON.stringify(results)).toHaveLength(1);
    expect((await pool.query("SELECT 1 FROM ap_events WHERE business_id=$1 AND entity_id=$2 AND event_type='PAYMENT_SETTLED'",[p.businessId,p.obligationId])).rowCount).toBe(1);
    expect((await p.reconcile()).status).toBe("NO_UNRESOLVED");
  });
  it("refuses a receipt bound to another recipient",async()=>{
    const p=await pending();p.receipt.recipient=`0x${"9".repeat(40)}`;
    expect(await p.reconcile()).toMatchObject({status:"WAITING",reason:"ARC_RECEIPT_TERMS_MISMATCH"});
    expect((await pool.query<{status:string}>("SELECT status FROM ap_reservations WHERE business_id=$1",[p.businessId])).rows[0]?.status).toBe("HELD");
  });
  it("releases a failed payment only after an independently verified reverted receipt and records gas",async()=>{
    const p=await pending();
    expect((await p.reconcile("FAILED")).status).toBe("WAITING"); // SUCCESS cannot prove failure.
    p.receipt.outcome="REVERTED";p.receipt.amountMicroUsdc="0";
    expect(await p.reconcile("FAILED")).toMatchObject({status:"FAILED"});
    expect((await pool.query<{status:string}>("SELECT status FROM ap_reservations WHERE business_id=$1",[p.businessId])).rows[0]?.status).toBe("RELEASED");
    expect((await pool.query<{fee:string}>("SELECT actual_fee_micro_usdc::text AS fee FROM ap_payment_intents WHERE business_id=$1",[p.businessId])).rows[0]?.fee).toBe("21");
    expect((await pool.query<{outstanding:string}>("SELECT outstanding_micro_usdc::text AS outstanding FROM ap_purchase_orders WHERE business_id=$1",[p.businessId])).rows[0]?.outstanding).toBe("1500000");
  });
});



describe("worker heartbeat",()=>{
  it("expires old heartbeats and reports unavailable after a failed loop",async()=>{
    const p=await plannedPayment(),store=createApStore(pool,168);
    expect(await store.workerStatus(p.businessId)).toBeNull();
    await pool.query("INSERT INTO ap_worker_status (business_id,extraction_available,payment_available,dispatch_enabled,healthy) VALUES ($1,true,true,true,true)",[p.businessId]);
    expect(await store.workerStatus(p.businessId)).toEqual({extractionAvailable:true,paymentAvailable:true,dispatchEnabled:true});
    await pool.query("UPDATE ap_worker_status SET updated_at=now()-interval '2 minutes' WHERE business_id=$1",[p.businessId]);
    expect(await store.workerStatus(p.businessId)).toBeNull();
    await pool.query("UPDATE ap_worker_status SET updated_at=now(),healthy=false WHERE business_id=$1",[p.businessId]);
    expect(await store.workerStatus(p.businessId)).toBeNull();
  });
});
