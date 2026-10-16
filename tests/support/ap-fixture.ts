// In-memory fixture for automated tests and the explicit local demo harness.
// Never imported by the production entrypoint or the payment worker.
import { createHash, randomUUID } from "node:crypto";
import { invoiceMutationResultSchema, type InvoiceDetail, type InvoiceCommand, type InvoiceMutationResult } from "@agentpay/core";
import { InvoiceReviewError } from "../../apps/server/src/obligations/review.js";
import type { ApStore } from "../../apps/server/src/ap/store.js";
import { ApprovalConflict } from "../../apps/server/src/ap/store.js";
import { IngestionConflict } from "../../apps/server/src/obligations/ingest.js";
import { loadApConfig } from "../../apps/server/src/ap/config.js";

export const fixtureConfig = loadApConfig({ NODE_ENV: "test", WEB_ORIGIN: "http://127.0.0.1:3100",
  BUSINESS_ID: "synthetic-business", SESSION_SECRET: "synthetic-test-session-secret-not-for-production",
  DEMO_ACCESS_CODE: "synthetic-operator-code", REVIEWER_ACCESS_CODE: "synthetic-reviewer-code", PAYMENT_MODE: "fixture" });

export function createFixtureStore(): ApStore {
  let paused = true;
  const records = new Map<string, InvoiceDetail>();
  const keys = new Map<string, { hash: string; id: string }>();
  const hashes = new Map<string, string>();
  const images = new Map<string, { bytes: Buffer; mimeType: "image/png" | "image/jpeg" }>();
  const approved = new Set<string>();
  const commands = new Map<string, { fingerprint: string; result: InvoiceMutationResult }>();
  function review(id: string, input: InvoiceCommand, action: "CORRECT" | "EVALUATE" | "REJECT") {
    const fingerprint = JSON.stringify({ input, action }), key = `${id}:${input.commandId}`, previous = commands.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new InvoiceReviewError("COMMAND_CONFLICT");
      return previous.result;
    }
    const record = records.get(id);
    if (!record) throw new InvoiceReviewError("NOT_FOUND", 404);
    if (record.invoice.version !== input.expectedVersion) throw new InvoiceReviewError("VERSION_CONFLICT");
    if (record.payment) throw new InvoiceReviewError("PAYMENT_IN_PROGRESS");
    if (record.invoice.status === "REJECTED" && action !== "CORRECT") throw new InvoiceReviewError("INVOICE_REJECTED");
    approved.delete(id);
    record.invoice = { ...record.invoice, version: record.invoice.version + 1,
      status: action === "REJECT" ? "REJECTED" : "RECEIVED", decision: null };
    record.decision = null; record.facts = null;
    record.approvalOffer = null;
    record.processingMessage = "Synthetic review recorded. No real extraction or transfer occurred.";
    const result = invoiceMutationResultSchema.parse({ obligationId: id, version: record.invoice.version, status: record.invoice.status });
    commands.set(key, { fingerprint, result });
    return result;
  }
  function settleApproved() {
    if (paused) return;
    for (const id of approved) {
      const record = records.get(id)!;
      record.invoice = { ...record.invoice, status: "SETTLED", paymentState: "SETTLED" };
      record.decision!.action = "PAY_NOW";
      record.payment = { state: "SETTLED", providerId: "synthetic-provider", providerState: "COMPLETE",
        transactionHash: `0x${"b".repeat(64)}`, settledAt: new Date().toISOString(), actualFeeMicroUsdc: "21",
        verificationReference: "synthetic-receipt-not-chain-evidence" };
      approved.delete(id);
    }
  }
  return {
    reconcile: (_business, _actor, id) => Promise.resolve({ status: "WAITING" as const, intentId: id, reason: "SYNTHETIC_NO_PROVIDER" }),
    correct: (_business, _actor, id, input) => Promise.resolve().then(() => review(id, input, "CORRECT")),
    evaluate: (_business, _actor, id, input) => Promise.resolve().then(() => review(id, input, "EVALUATE")),
    reject: (_business, _actor, id, input) => Promise.resolve().then(() => review(id, input, "REJECT")),
    ready: (business) => Promise.resolve(business === fixtureConfig.BUSINESS_ID),
    workerStatus: () => Promise.resolve(null),
    list: (_business, offset) => Promise.resolve({ invoices: [...records.values()].slice(offset, offset + 25).map((record) => record.invoice),
      nextOffset: records.size > offset + 25 ? offset + 25 : null }),
    detail: (_business, id) => Promise.resolve(records.get(id) ?? null),
    image: (_business, id) => Promise.resolve(images.get(id) ?? null),
    audit: (_business, id) => Promise.resolve(records.has(id) ? { decision:records.get(id)!.decision,payment:records.get(id)!.payment,
      events: [{ key: `received:${id}`, type: records.get(id)!.payment?.state==="SETTLED"?"SYNTHETIC_PAYMENT_SETTLED":"SYNTHETIC_INVOICE_RECEIVED", version: 1, createdAt: "2026-10-09T06:00:00.000Z" }] } : null),
    treasury: () => Promise.resolve({ walletAddress: null, paused, holdsMicroUsdc: "0", minimumReserveMicroUsdc: "5000000" }),
    setPaused: (_business, _actor, value) => { paused=value; settleApproved(); return Promise.resolve(); },
    upload: (_claims, key, hint, bytes, mime) => {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const fingerprint = `${hash}:${hint ?? ""}`;
      const existing = keys.get(key);
      if (existing) {
        if (existing.hash !== fingerprint) return Promise.reject(new IngestionConflict("IDEMPOTENCY_CONFLICT", existing.id));
        return Promise.resolve({ obligationId: existing.id, status: "RECEIVED", reused: true });
      }
      const duplicate = hashes.get(hash);
      if (duplicate) return Promise.reject(new IngestionConflict("DUPLICATE_INPUT", duplicate));
      const id = randomUUID(); keys.set(key, { hash: fingerprint, id }); hashes.set(hash, id);
      images.set(id, { bytes, mimeType: mime === "image/jpeg" ? "image/jpeg" : "image/png" });
      records.set(id, { invoice: { id, status: "RECEIVED", version: 1, invoiceNumber: null, vendorName: null,
        amountMicroUsdc: null, dueDate: null, createdAt: "2026-10-09T06:00:00.000Z", decision: null, paymentState: null },
      facts: null, decision: null, payment: null,
      processingMessage: "Synthetic fixture image saved. Extraction worker is unavailable; no payment was initiated." });
      if (hint === "SYNTHETIC-PAYMENT-SCENARIO") {
        const record=records.get(id)!;
        record.invoice={...record.invoice,status:"OPEN",decision:"REQUIRE_APPROVAL",amountMicroUsdc:"1500000",invoiceNumber:"SYNTHETIC-2",vendorName:"Synthetic vendor"};
        record.decision={id:randomUUID(),action:"REQUIRE_APPROVAL",reason:"Synthetic amount exceeds automatic threshold.",evidenceIds:["synthetic-po-accepted"],evaluatedAt:new Date().toISOString()};
        record.approvalOffer = { decisionId: record.decision.id, expectedVersion: record.invoice.version, termsHash: "a".repeat(64),
          expiresAt: new Date(Date.now() + 86400000).toISOString(), terms: { businessId: fixtureConfig.BUSINESS_ID,
            obligationId: id, decisionId: record.decision.id, walletId: "synthetic-wallet", obligationVersion: 1,
            vendorId: "synthetic-vendor", vendorAddressVersion: 1, purchaseOrderId: "synthetic-po", purchaseOrderVersion: 1,
            policyVersion: 1, recipient: `0x${"2".repeat(40)}`, amountMicroUsdc: "1500000", chainId: 5042002,
            token: "0x3600000000000000000000000000000000000000" } };
        record.processingMessage="Synthetic browser scenario. No model, chain or provider is contacted.";
      }
      return Promise.resolve({ obligationId: id, status: "RECEIVED", reused: false });
    },
    approve: (_business,_actor,id,decisionId,_reason,confirmation) => {
      const record=records.get(id);
      if (!record?.decision || record.decision.id !== decisionId || record.decision.action !== "REQUIRE_APPROVAL")
        return Promise.reject(new ApprovalConflict("APPROVAL_NOT_ELIGIBLE"));
      if (approved.has(id)) return Promise.reject(new ApprovalConflict("APPROVAL_ALREADY_EXISTS"));
      if (confirmation && (confirmation.expectedVersion !== record.invoice.version || confirmation.termsHash !== record.approvalOffer?.termsHash))
        return Promise.reject(new ApprovalConflict("APPROVAL_NOT_ELIGIBLE"));
      approved.add(id);
      record.approvalOffer = null;
      settleApproved();
      return Promise.resolve({ approvalId: randomUUID(), expiresAt: new Date(Date.now()+86400000).toISOString() });
    }
  };
}
