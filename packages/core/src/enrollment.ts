import { z } from "zod";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, arcAddressSchema, payableVendorSchema, purchaseOrderSchema } from "./obligations.js";
import { treasuryPolicySchema } from "./treasury.js";

/** Initial owner-maintained records, never model output or invoice-supplied registry edits. */
export const enrollmentSchema = z.strictObject({
  kind: z.enum(["fixture", "owner_verified"]),
  businessId: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
  treasury: z.strictObject({
    walletId: z.string().trim().min(1).max(500), walletAddress: arcAddressSchema,
    chainId: z.literal(ARC_CHAIN_ID), tokenAddress: z.literal(ARC_USDC_ADDRESS),
    paymentMode: z.enum(["disabled", "fixture", "arc_testnet"]), policy: treasuryPolicySchema
  }),
  vendors: z.array(payableVendorSchema.extend({ verifiedAt: z.iso.datetime({ precision: 3 }) })).min(1).max(100),
  purchaseOrders: z.array(purchaseOrderSchema).min(1).max(500)
}).superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if ((value.kind === "fixture") !== (value.treasury.paymentMode === "fixture")) issue("Fixture data requires fixture mode; owner data cannot use fixture mode");
  const vendors = new Set(value.vendors.map((vendor) => vendor.id));
  if (vendors.size !== value.vendors.length) issue("Duplicate vendor IDs");
  if (new Set(value.purchaseOrders.map((po) => po.id)).size !== value.purchaseOrders.length) issue("Duplicate purchase order IDs");
  for (const vendor of value.vendors) {
    if (vendor.businessId !== value.businessId || vendor.addressVersion !== 1) issue("Vendors must belong to this business and start at version one");
    if (vendor.address === value.treasury.walletAddress || vendor.address === ARC_USDC_ADDRESS) issue("Recipient cannot be the treasury or USDC token address");
  }
  for (const po of value.purchaseOrders) {
    if (po.businessId !== value.businessId || !vendors.has(po.vendorId)) issue("Purchase orders must reference a vendor in this business manifest");
    if (po.version !== 1 || po.activeObligationId !== null || po.outstandingMicroUsdc !== po.amountMicroUsdc) issue("Enrollment only accepts new, unclaimed, unpaid purchase orders");
    if (po.deliveryAccepted && !po.acceptanceReference) issue("Accepted delivery requires independent evidence");
  }
});
export type Enrollment = z.infer<typeof enrollmentSchema>;
