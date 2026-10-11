import { readFile } from "node:fs/promises";
import { enrollmentSchema } from "@agentpay/core";

const fixture: unknown = JSON.parse(await readFile(new URL("../../fixtures/payables.fixture.json", import.meta.url), "utf8"));
export function syntheticEnrollment(businessId = "local-business") {
  const manifest = enrollmentSchema.parse(fixture);
  manifest.businessId = businessId;
  manifest.treasury.walletId = `synthetic-wallet:${businessId}`;
  for (const vendor of manifest.vendors) vendor.businessId = businessId;
  for (const po of manifest.purchaseOrders) po.businessId = businessId;
  return manifest;
}
