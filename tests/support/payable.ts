import { payableExtractionSchema } from "@agentpay/core";

export function syntheticPayable() {
  const visible = { vendorName: "Synthetic vendor", invoiceNumber: "TEST-1", issueDate: "2026-10-01", dueDate: "2026-10-09",
    purchaseOrderReference: "po", currency: "USD", subtotal: "1.40", tax: "0.10", total: "1.50" };
  const missing = { value: null, status: "MISSING", sourceText: null };
  return payableExtractionSchema.parse({
    ...Object.fromEntries(Object.entries(visible).map(([key, value]) => [key, { value, status: "EXTRACTED", sourceText: value }])),
    printedAddress: missing, serviceDescription: missing, servicePeriod: missing, paymentTerms: missing, lineItems: []
  });
}
