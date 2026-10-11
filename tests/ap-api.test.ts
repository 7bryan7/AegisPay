import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apSessionSchema, approvalResultSchema, uploadResultSchema } from "@agentpay/core";
import { createApApp } from "../apps/server/src/ap/app.js";
import { issueApSession, apCookie } from "../apps/server/src/ap/session.js";
import type { ApStore } from "../apps/server/src/ap/store.js";
import { createFixtureStore, fixtureConfig } from "./support/ap-fixture.js";

const servers: ReturnType<ReturnType<typeof createApApp>["listen"]>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});
async function start(store: ApStore | null = createFixtureStore(), config = fixtureConfig) {
  const server = createApApp(config, store).listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function login(base: string, code = fixtureConfig.DEMO_ACCESS_CODE) {
  const response = await fetch(`${base}/api/session`, { method: "POST", headers: { origin: fixtureConfig.WEB_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const body = apSessionSchema.parse(await response.json());
  if (!body.authenticated) throw new Error("expected authenticated fixture session");
  return { cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", "x-csrf-token": body.csrfToken, origin: fixtureConfig.WEB_ORIGIN };
}
async function form() {
  const data = new FormData(); const bytes = await readFile(new URL("../fixtures/synthetic-invoice.png", import.meta.url));
  data.append("invoice", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "synthetic.png"); return data;
}

describe("AP API boundary", () => {
  it("starts without credentials and refuses authentication and legacy payment routes", async () => {
    const base = await start(null, { ...fixtureConfig, DEMO_ACCESS_CODE: "", REVIEWER_ACCESS_CODE: "", SESSION_SECRET: "" });
    expect(await (await fetch(`${base}/api/session`)).json()).toEqual({ authenticated: false, loginAvailable: false });
    expect((await fetch(`${base}/ready`)).status).toBe(503);
    expect((await fetch(`${base}/api/session`, { method: "POST", headers: { origin: fixtureConfig.WEB_ORIGIN } })).status).toBe(503);
    expect((await fetch(`${base}/api/invoices`)).status).toBe(401);
    expect((await fetch(`${base}/providers/alpha/extract`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/api/runs`, { method: "POST" })).status).toBe(404);
  });
  it("preserves secure cookies and rejects untrusted origin and missing CSRF before upload", async () => {
    const store = createFixtureStore(); const spy = vi.spyOn(store, "upload"); const base = await start(store);
    const auth = await login(base);
    expect((await fetch(`${base}/api/invoices`, { method: "POST", headers: { ...auth, origin: "https://untrusted.example" }, body: await form() })).status).toBe(403);
    expect((await fetch(`${base}/api/invoices`, { method: "POST", headers: { cookie: auth.cookie, origin: auth.origin }, body: await form() })).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    const production = await start(null, { ...fixtureConfig, NODE_ENV: "production" });
    const response = await fetch(`${production}/api/session`, { method: "POST", headers: { origin: auth.origin, "content-type": "application/json" }, body: JSON.stringify({ code: fixtureConfig.DEMO_ACCESS_CODE }) });
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/); expect(response.headers.get("set-cookie")).toMatch(/Secure/);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
  });
  it("binds business and role in signed claims and isolates reviewer reads", async () => {
    const store = createFixtureStore(), list = vi.spyOn(store, "list"), upload = vi.spyOn(store, "upload");
    const base = await start(store), auth = await login(base, fixtureConfig.REVIEWER_ACCESS_CODE);
    expect(await (await fetch(`${base}/api/invoices`, { headers: auth })).json()).toEqual({ invoices: [], nextOffset: null });
    expect((await fetch(`${base}/api/invoices`, { method: "POST", headers: auth, body: await form() })).status).toBe(403);
    expect((await fetch(`${base}/api/invoices/00000000-0000-4000-8000-000000000001/audit`, { headers: auth })).status).toBe(403);
    expect((await fetch(`${base}/api/invoices/00000000-0000-4000-8000-000000000001/image`, { headers: auth })).status).toBe(403);
    expect(list).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
    const wrongBusiness = issueApSession(fixtureConfig.SESSION_SECRET, "another-business", "OPERATOR");
    expect((await fetch(`${base}/api/invoices`, { headers: { cookie: `${apCookie}=${wrongBusiness.token}` } })).status).toBe(401);
    const expired = issueApSession(fixtureConfig.SESSION_SECRET, fixtureConfig.BUSINESS_ID, "OPERATOR", 1);
    expect((await fetch(`${base}/api/invoices`, { headers: { cookie: `${apCookie}=${expired.token}` } })).status).toBe(401);
  });
  it("uploads through authenticated claims and preserves conflict status and strict fields", async () => {
    const store = createFixtureStore(), spy = vi.spyOn(store, "upload"), base = await start(store), auth = await login(base);
    const headers = { ...auth, "idempotency-key": "same-key" };
    const response = await fetch(`${base}/api/invoices`, { method: "POST", headers, body: await form() });
    expect(response.status).toBe(202); const saved = uploadResultSchema.parse(await response.json());
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ businessId: fixtureConfig.BUSINESS_ID, role: "OPERATOR" });
    expect((await fetch(`${base}/api/invoices`, { method: "POST", headers, body: await form() })).status).toBe(200);
    const changed = await form(); changed.append("purchaseOrderHint", "changed");
    expect((await fetch(`${base}/api/invoices`, { method: "POST", headers, body: changed })).status).toBe(409);
    const injected = await form(); injected.append("recipient", `0x${"1".repeat(40)}`);
    expect((await fetch(`${base}/api/invoices`, { method: "POST", headers, body: injected })).status).toBe(400);
    expect((await fetch(`${base}/api/invoices/${saved.obligationId}`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/invoices/${saved.obligationId}/audit`, { headers: auth })).status).toBe(200);
    const image = await fetch(`${base}/api/invoices/${saved.obligationId}/image`, { headers: auth });
    expect(image.status).toBe(200); expect(image.headers.get("cache-control")).toBe("no-store");
    expect(image.headers.get("content-type")).toContain("image/png");
    expect((await fetch(`${base}/api/invoices/${saved.obligationId}/image`)).status).toBe(401);
  });
  it("creates approval from the stored decision and rejects client-supplied terms", async () => {
    const store = createFixtureStore(), base = await start(store), auth = await login(base);
    const upload = await fetch(`${base}/api/invoices`, { method: "POST", headers: { ...auth, "idempotency-key": "approval-key" }, body: await form() });
    const { obligationId } = uploadResultSchema.parse(await upload.json());
    const decisionId = "00000000-0000-4000-8000-000000000002";
    const approved = await fetch(`${base}/api/invoices/${obligationId}/approve`, { method: "POST", headers: { ...auth, origin: auth.origin, "content-type": "application/json" },
      body: JSON.stringify({ decisionId, reason: "Budget exception reviewed", recipient: `0x${"f".repeat(40)}`, amountMicroUsdc: "1" }) });
    expect(approved.status).toBe(400);
    const valid = await fetch(`${base}/api/invoices/${obligationId}/approve`, { method: "POST", headers: { ...auth, origin: auth.origin, "content-type": "application/json" },
      body: JSON.stringify({ decisionId, reason: "Budget exception reviewed" }) });
    expect(valid.status).toBe(201);
    expect(approvalResultSchema.parse(await valid.json()).expiresAt).toBe("2026-10-10T06:00:00.000Z");
  });
  it("reports absent database truthfully and redacts backend errors", async () => {
    const base = await start(null), auth = await login(base);
    expect((await fetch(`${base}/api/invoices`, { headers: auth })).status).toBe(503);
    const store = createFixtureStore(); vi.spyOn(store, "ready").mockRejectedValue(new Error("private database password"));
    const broken = await start(store), session = await login(broken);
    const response = await fetch(`${broken}/api/invoices`, { headers: session });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private database password");
  });
});
