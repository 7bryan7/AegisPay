import { workspaceSummarySchema, workspaceInvoiceListSchema, paymentListSchema, activityListSchema, readinessSchema } from "@agentpay/core";
import { reviewerExamplesSchema, reviewerEvaluationSchema, apSessionSchema, approvalResultSchema, auditSchema, invoiceDetailSchema, invoiceListSchema, treasuryViewSchema, uploadResultSchema,
  invoiceMutationResultSchema, paymentReconciliationResultSchema, type ApprovalOffer, type InvoiceCorrection, type InvoiceCommand, type InvoiceEvaluation } from "@agentpay/core";
import { vendorListSchema, vendorRecordSchema, purchaseOrderListSchema, purchaseOrderSchema, policyViewSchema,
  type CreateVendor, type UpdateVendor, type CreatePurchaseOrder, type UpdatePurchaseOrder, type UpdatePolicy } from "@agentpay/core";

export class PayablesApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly requestId?: string, readonly retryable?: boolean) { super(message); this.name = "PayablesApiError"; }
}
export class PayablesApi {
  private csrf = "";
  constructor(private readonly baseUrl: string) {}
  private async request<T>(path: string, schema: { parse(value: unknown): T }, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.method && init.method !== "GET") headers.set("x-csrf-token", this.csrf);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000) });
    const body: unknown = response.status === 204 ? undefined : await response.json();
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
        ? body.message : "The request could not be completed";
      const metadata = typeof body === "object" && body !== null ? body : {};
      throw new PayablesApiError(message, response.status,
        "code" in metadata && typeof metadata.code === "string" ? metadata.code : undefined,
        "requestId" in metadata && typeof metadata.requestId === "string" ? metadata.requestId : undefined,
        "retryable" in metadata && typeof metadata.retryable === "boolean" ? metadata.retryable : undefined);
    }
    return schema.parse(body);
  }
  summary() { return this.request("/api/workspace/summary", workspaceSummarySchema); }
  invoices(query = "") { return this.request(`/api/workspace/invoices?${query}`, workspaceInvoiceListSchema); }
  payments(query = "") { return this.request(`/api/payments?${query}`, paymentListSchema); }
  activity(query = "") { return this.request(`/api/activity?${query}`, activityListSchema); }
  async readiness() {
    const response = await fetch(`${this.baseUrl}/ready`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (response.status !== 200 && response.status !== 503) throw new PayablesApiError("Readiness unavailable", response.status);
    return readinessSchema.parse(await response.json());
  }
  async session() {
    const session = await this.request("/api/session", apSessionSchema);
    this.csrf = session.authenticated ? session.csrfToken : "";
    return session;
  }
  async login(code: string) {
    const session = await this.request("/api/session", apSessionSchema, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    this.csrf = session.authenticated ? session.csrfToken : "";
    return session;
  }
  async logout() {
    await this.request("/api/session", { parse: () => undefined }, { method: "DELETE" });
    this.csrf = "";
  }
  list(offset = 0) { return this.request(`/api/invoices?offset=${offset}`, invoiceListSchema); }
  detail(id: string) { return this.request(`/api/invoices/${encodeURIComponent(id)}`, invoiceDetailSchema); }
  audit(id: string) { return this.request(`/api/invoices/${encodeURIComponent(id)}/audit`, auditSchema); }
  reviewerExamples() { return this.request("/api/reviewer/examples", reviewerExamplesSchema); }
  evaluateExample(exampleId: string) { return this.request("/api/reviewer/evaluate", reviewerEvaluationSchema,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ exampleId }) }); }
  treasury() { return this.request("/api/treasury", treasuryViewSchema); }
  vendors(offset = 0) { return this.request(`/api/vendors?offset=${offset}`, vendorListSchema); }
  purchaseOrders(offset = 0) { return this.request(`/api/purchase-orders?offset=${offset}`, purchaseOrderListSchema); }
  policy() { return this.request("/api/policy", policyViewSchema); }
  saveVendor(id: string | null, input: CreateVendor | UpdateVendor) { return this.request(id === null ? "/api/vendors" : `/api/vendors/${encodeURIComponent(id)}`,
    vendorRecordSchema, { method: id === null ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); }
  savePurchaseOrder(id: string | null, input: CreatePurchaseOrder | UpdatePurchaseOrder) { return this.request(id === null ? "/api/purchase-orders" : `/api/purchase-orders/${encodeURIComponent(id)}`,
    purchaseOrderSchema, { method: id === null ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); }
  savePolicy(input: UpdatePolicy) { return this.request("/api/policy", policyViewSchema,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); }
  setPaused(paused: boolean, reason?: string) { return this.request("/api/treasury/pause", { parse: () => undefined }, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused, reason: reason ?? (paused ? "Operator paused new submissions" : "Operator resumed policy-controlled submissions") }) }); }
  imageUrl(id: string) { return `${this.baseUrl}/api/invoices/${encodeURIComponent(id)}/image`; }
  upload(file: File, key: string, hint: string) {
    const form = new FormData(); form.append("invoice", file);
    if (hint.trim()) form.append("purchaseOrderHint", hint.trim());
    return this.request("/api/invoices", uploadResultSchema, { method: "POST", headers: { "idempotency-key": key }, body: form });
  }
  correct(id: string, input: InvoiceCorrection) { return this.request(`/api/invoices/${encodeURIComponent(id)}`, invoiceMutationResultSchema,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); }
  evaluate(id: string, input: InvoiceEvaluation) { return this.request(`/api/invoices/${encodeURIComponent(id)}/evaluate`, invoiceMutationResultSchema,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); }
  reject(id: string, input: InvoiceCommand) { return this.request(`/api/invoices/${encodeURIComponent(id)}/reject`, invoiceMutationResultSchema,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); }
  reconcile(id: string, reason: string) { return this.request(`/api/payments/${encodeURIComponent(id)}/reconcile`, paymentReconciliationResultSchema,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) }); }
  approve(id: string, decisionId: string, reason: string, offer: ApprovalOffer) {
    return this.request(`/api/invoices/${encodeURIComponent(id)}/approve`, approvalResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decisionId, reason, expectedVersion: offer.expectedVersion, termsHash: offer.termsHash })
    });
  }
}
