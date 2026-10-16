import { z } from "zod";
import { payableVendorSchema, purchaseOrderSchema } from "./obligations.js";
import { treasuryPolicySchema } from "./treasury.js";

export const changeReasonSchema = z.string().trim().min(1).max(2000);
const expectedVersion = z.number().int().positive();
export const vendorRecordSchema = payableVendorSchema.extend({ verifiedAt: z.iso.datetime() });
export const vendorFieldsSchema = vendorRecordSchema.omit({ businessId: true, addressVersion: true });
export const createVendorSchema = vendorFieldsSchema.extend({ reason: changeReasonSchema });
export const updateVendorSchema = vendorFieldsSchema.omit({ id: true }).partial()
  .extend({ expectedVersion, reason: changeReasonSchema })
  .refine((value) => Object.keys(value).some((key) => key !== "expectedVersion" && key !== "reason"), "Supply a changed field");
export const purchaseOrderFieldsSchema = z.strictObject({ id: purchaseOrderSchema.shape.id, vendorId: purchaseOrderSchema.shape.vendorId,
  amountMicroUsdc: purchaseOrderSchema.shape.amountMicroUsdc, deliveryAccepted: purchaseOrderSchema.shape.deliveryAccepted,
  acceptanceReference: purchaseOrderSchema.shape.acceptanceReference, description: purchaseOrderSchema.shape.description, dueDate: purchaseOrderSchema.shape.dueDate,
  servicePeriod: purchaseOrderSchema.shape.servicePeriod, essential: purchaseOrderSchema.shape.essential, verifiedDiscount: purchaseOrderSchema.shape.verifiedDiscount });
export const createPurchaseOrderSchema = purchaseOrderFieldsSchema.extend({ reason: changeReasonSchema });
export const updatePurchaseOrderSchema = purchaseOrderFieldsSchema.omit({ id: true }).partial()
  .extend({ expectedVersion, reason: changeReasonSchema })
  .refine((value) => Object.keys(value).some((key) => key !== "expectedVersion" && key !== "reason"), "Supply a changed field");
export const policyViewSchema = z.strictObject({ policy: treasuryPolicySchema, version: expectedVersion });
export const updatePolicySchema = z.strictObject({ policy: treasuryPolicySchema, expectedVersion, reason: changeReasonSchema });
export const vendorListSchema = z.strictObject({ vendors: z.array(vendorRecordSchema), nextOffset: z.number().int().nullable() });
export const purchaseOrderListSchema = z.strictObject({ purchaseOrders: z.array(purchaseOrderSchema), nextOffset: z.number().int().nullable() });
export const pauseTreasurySchema = z.strictObject({ paused: z.boolean(), reason: changeReasonSchema });
export type VendorRecord = z.infer<typeof vendorRecordSchema>;
export type CreateVendor = z.infer<typeof createVendorSchema>;
export type UpdateVendor = z.infer<typeof updateVendorSchema>;
export type CreatePurchaseOrder = z.infer<typeof createPurchaseOrderSchema>;
export type UpdatePurchaseOrder = z.infer<typeof updatePurchaseOrderSchema>;
export type UpdatePolicy = z.infer<typeof updatePolicySchema>;
