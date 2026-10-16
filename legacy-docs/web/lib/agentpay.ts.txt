export interface SessionState {
  authenticated: boolean;
  csrfToken?: string;
  expiresAt?: string;
}

export interface RoutePreview {
  capability: "invoice-extraction" | "invoice-qa";
  selected: {
    metadata: { name: string; endpoint: string; recipient: string; network: string; asset: string };
    offer: { amount: string; expiresAt: string };
  };
  readiness: Array<{ name: string; attempts: number; waitedMs: number }>;
  facilitator: { feePayer: string; x402Version: 2 };
  validatedAt: string;
}

export interface RunView {
  runId: string;
  requestId: string;
  status: string;
  provider: string;
  payerAccountId: string;
  amountTinybars: string;
  recipientAccountId: string;
  network: "hedera:testnet";
  asset: "0.0.0";
  paymentStatus: string;
  transactionReference: string | null;
  reservationStatus: string;
  result: unknown;
  error: unknown;
  paymentRequired?: unknown;
  expiresAt: string;
}

export interface HederaBrowserWalletAdapter {
  connect(options?: WalletConnectionOptions): Promise<{ accountId: string }>;
  createPaymentSignature(paymentRequired: unknown): Promise<string>;
  disconnect?(): Promise<void>;
  restore?(): Promise<string | undefined>;
}

export interface WalletConnectionOptions {
  onPairingUri?(uri: string): void;
}

declare global {
  interface Window {
    agentPayWallet?: HederaBrowserWalletAdapter;
  }
}

interface ApiErrorPayload {
  message?: string;
}

export class AgentPayApi {
  private csrfToken: string | undefined;

  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.csrfToken && init.method && init.method !== "GET") headers.set("x-csrf-token", this.csrfToken);
    const response = await fetch(new URL(path, this.baseUrl), { ...init, headers, credentials: "include" });
    const body = response.status === 204 ? undefined : await response.json() as T & ApiErrorPayload;
    if (!response.ok) throw new Error(body?.message ?? `Request failed with HTTP ${response.status}`);
    return body as T;
  }

  async getSession(): Promise<SessionState> {
    const session = await this.request<SessionState>("/api/session");
    this.csrfToken = session.csrfToken;
    return session;
  }

  async unlock(code: string): Promise<SessionState> {
    const session = await this.request<SessionState>("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code })
    });
    this.csrfToken = session.csrfToken;
    return session;
  }

  async logout(): Promise<void> {
    await this.request<void>("/api/session", { method: "DELETE" });
    this.csrfToken = undefined;
  }

  preview(task: string, maxSpendTinybars: string): Promise<RoutePreview> {
    return this.request("/api/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, maxSpendTinybars })
    });
  }

  createRun(input: { task: string; maxSpendTinybars: string; payerAccountId: string; invoice: File; question?: string }, idempotencyKey: string): Promise<RunView> {
    const form = new FormData();
    form.set("task", input.task);
    form.set("maxSpendTinybars", input.maxSpendTinybars);
    form.set("payerAccountId", input.payerAccountId);
    if (input.question) form.set("question", input.question);
    form.set("invoice", input.invoice);
    return this.request("/api/runs", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: form
    });
  }

  getRun(runId: string): Promise<RunView> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}`);
  }

  execute(runId: string, paymentSignature: string): Promise<RunView> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentSignature })
    });
  }

  cancel(runId: string): Promise<RunView> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  }

  reconcile(runId: string): Promise<RunView> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/reconcile`, { method: "POST" });
  }

  recover(runId: string): Promise<RunView> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/recover`, { method: "POST" });
  }
}
