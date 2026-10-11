// Test-only in-memory store. Never imported by the production entrypoint.
import { createHash, randomUUID } from "node:crypto";
import type { InvoiceDetail } from "@agentpay/core";
import type { ApStore } from "../../apps/server/src/ap/store.js";
import { IngestionConflict } from "../../apps/server/src/obligations/ingest.js";
import { loadApConfig } from "../../apps/server/src/ap/config.js";

export const fixtureConfig = loadApConfig({ NODE_ENV: "test", WEB_ORIGIN: "http://127.0.0.1:3100",
  BUSINESS_ID: "synthetic-business", SESSION_SECRET: "synthetic-test-session-secret-not-for-production",
  DEMO_ACCESS_CODE: "synthetic-operator-code", REVIEWER_ACCESS_CODE: "synthetic-reviewer-code", PAYMENT_MODE: "fixture" });

export function createFixtureStore(): ApStore {
  const records = new Map<string, InvoiceDetail>();
  const keys = new Map<string, { hash: string; id: string }>();
  const hashes = new Map<string, string>();
  const images = new Map<string, Buffer>();
  return {
    ready: (business) => Promise.resolve(business === fixtureConfig.BUSINESS_ID),
    list: (_business, offset) => Promise.resolve({ invoices: [...records.values()].slice(offset, offset + 25).map((record) => record.invoice), nextOffset: null }),
    detail: (_business, id) => Promise.resolve(records.get(id) ?? null),
    image: (_business, id) => Promise.resolve(images.has(id) ? { bytes: images.get(id)!, mimeType: "image/png" as const } : null),
    audit: (_business, id) => Promise.resolve(records.has(id) ? { events: [{ key: `received:${id}`, type: "SYNTHETIC_INVOICE_RECEIVED", version: 1, createdAt: "2026-10-09T06:00:00.000Z" }] } : null),
    treasury: () => Promise.resolve({ walletAddress: null, paused: true, holdsMicroUsdc: "0", minimumReserveMicroUsdc: "5000000" }),
    upload: (_claims, key, hint, bytes) => {
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
      images.set(id, bytes);
      records.set(id, { invoice: { id, status: "RECEIVED", version: 1, invoiceNumber: null, vendorName: null,
        amountMicroUsdc: null, dueDate: null, createdAt: "2026-10-09T06:00:00.000Z", decision: null, paymentState: null },
      facts: null, decision: null, payment: null,
      processingMessage: "Synthetic fixture image saved. Extraction worker is unavailable; no payment was initiated." });
      return Promise.resolve({ obligationId: id, status: "RECEIVED", reused: false });
    },
    approve: () => Promise.resolve({ approvalId: randomUUID(), expiresAt: "2026-10-10T06:00:00.000Z" })
  };
}
