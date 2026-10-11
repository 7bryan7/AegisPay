import { randomUUID } from "node:crypto";
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
import { dispatchNextPayment } from "../apps/server/src/payments/dispatch.js";
import { reconcileNextPayment } from "../apps/server/src/payments/reconcile.js";
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

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  for (const file of ["001_initial.sql", "002_browser_runs.sql", "003_invoice_qa.sql"]) {
    await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  await pool.query("INSERT INTO providers (ens_name) VALUES ('legacy.example.eth')");
  await pool.query(await readFile(new URL("../migrations/004_payables.sql", import.meta.url), "utf8"));
});
afterAll(async () => {
  await pool.end();
  // Only the generated, identifier-safe test schema is removed; no public tables.
  if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

describe("AP PostgreSQL persistence", () => {
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
    const dispatched = await dispatchNextPayment(pool, { submit: (request) => {
      expect(request).toMatchObject({ walletId: manifest.treasury.walletId, recipient: manifest.vendors[0]!.address,
        amountMicroUsdc: "1500000", providerIdempotencyKey: result.providerIdempotencyKey });
      return Promise.resolve({ providerId: "00000000-0000-4000-8000-000000000099", providerState: "INITIATED" });
    } }, businessId);
    expect(dispatched).toMatchObject({ status: "PENDING", intentId: result.intentId, providerId: "00000000-0000-4000-8000-000000000099" });
    expect((await pool.query<{ state: string; provider_id: string; provider_state: string }>("SELECT state, provider_id, provider_state FROM ap_payment_intents WHERE business_id = $1 AND id = $2", [businessId, result.intentId])).rows[0]).toMatchObject({ state: "PENDING", provider_id: "00000000-0000-4000-8000-000000000099", provider_state: "INITIATED" });
    const settlementHash = `0x${"b".repeat(64)}`;
    const settled = await reconcileNextPayment(pool,
      { getStatus: () => Promise.resolve({ providerId: "00000000-0000-4000-8000-000000000099", providerState: "COMPLETE", transactionHash: settlementHash, errorReason: null }) },
      { read: () => Promise.resolve({ chainId: 5042002 as const, tokenAddress: "0x3600000000000000000000000000000000000000" as const,
        walletAddress: manifest.treasury.walletAddress, cashMicroUsdc: "20000000", blockNumber: "100", blockHash: `0x${"a".repeat(64)}`,
        blockTimestamp: new Date().toISOString(), capturedAt: new Date().toISOString(), observedAt: new Date().toISOString() }) },
      { verify: (request) => { expect(request).toMatchObject({ transactionHash: settlementHash, recipient: manifest.vendors[0]!.address, amountMicroUsdc: "1500000" });
        return Promise.resolve({ transactionHash: settlementHash, amountMicroUsdc: "1500000", actualFeeMicroUsdc: "21", outcome: "SUCCESS", verificationReference: "arc-test-receipt" }); } }, businessId);
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
