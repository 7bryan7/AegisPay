import { apSessionSchema, approvalResultSchema, auditSchema, invoiceDetailSchema, invoiceListSchema, treasuryViewSchema, uploadResultSchema } from "@agentpay/core";

export class PayablesApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "PayablesApiError"; }
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
      throw new PayablesApiError(message, response.status);
    }
    return schema.parse(body);
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
  treasury() { return this.request("/api/treasury", treasuryViewSchema); }
  setPaused(paused: boolean) { return this.request("/api/treasury/pause", { parse: () => undefined }, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused }) }); }
  imageUrl(id: string) { return `${this.baseUrl}/api/invoices/${encodeURIComponent(id)}/image`; }
  upload(file: File, key: string, hint: string) {
    const form = new FormData(); form.append("invoice", file);
    if (hint.trim()) form.append("purchaseOrderHint", hint.trim());
    return this.request("/api/invoices", uploadResultSchema, { method: "POST", headers: { "idempotency-key": key }, body: form });
  }
  approve(id: string, decisionId: string, reason: string) {
    return this.request(`/api/invoices/${encodeURIComponent(id)}/approve`, approvalResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decisionId, reason })
    });
  }
}
