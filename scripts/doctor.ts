import { Client } from "pg";
import { loadApConfig } from "../apps/server/src/ap/config.js";
import { hasPlaceholder, jsonLog, loadRootEnv, safeErrorDetail } from "./shared.js";

loadRootEnv();
type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

const missing = ["DATABASE_URL", "BUSINESS_ID", "SESSION_SECRET", "DEMO_ACCESS_CODE"].filter((key) => hasPlaceholder(process.env[key]));
checks.push({
  name: "environment",
  ok: missing.length === 0,
  detail: missing.length === 0 ? "required runtime values are configured" : `missing or placeholder keys: ${missing.join(", ")}`
});

async function check(name: string, action: () => Promise<string>): Promise<void> {
  try {
    checks.push({ name, ok: true, detail: await action() });
  } catch (error) {
    checks.push({ name, ok: false, detail: safeErrorDetail(name, error) });
  }
}

if (!hasPlaceholder(process.env.DATABASE_URL)) {
  await check("database", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
    await client.connect();
    try {
      const result = await client.query("SELECT business_id FROM ap_treasuries WHERE business_id = $1", [process.env.BUSINESS_ID]);
      if (!result.rowCount) throw new Error("Treasury is not configured");
    } finally { await client.end(); }
    return "AP schema and configured treasury are accessible";
  });
}

try { loadApConfig(); checks.push({ name: "configuration", ok: true, detail: "AP settings are valid; blank credentials disable access" }); }
catch { checks.push({ name: "configuration", ok: false, detail: "AP configuration is invalid; check variable names and value formats" }); }
const workerMode = process.env.PAYMENT_MODE ?? "disabled";
const dispatchReady = workerMode === "arc_testnet" && !hasPlaceholder(process.env.CIRCLE_API_KEY) && !hasPlaceholder(process.env.ARC_RPC_URL);
checks.push({
  name: "workers",
  ok: true,
  detail: `Pipeline (extraction, planning, reservation, dispatch, reconciliation, retention) is runnable via npm run worker; mode=${workerMode}, dispatch=${dispatchReady ? "enabled" : "disabled"}`
});

for (const [name, urlKey, keyKey, modelKey] of [
  ["extraction-model", "EXTRACTION_MODEL_BASE_URL", "EXTRACTION_MODEL_API_KEY", "EXTRACTION_MODEL_ID"]
] as const) {
  if (!hasPlaceholder(process.env[urlKey]) && !hasPlaceholder(process.env[keyKey]) && !hasPlaceholder(process.env[modelKey])) {
    await check(name, async () => {
      const baseUrl = new URL(process.env[urlKey]!);
      if (baseUrl.protocol !== "https:" || baseUrl.hostname !== "generativelanguage.googleapis.com") {
        throw new Error("model endpoint must be the HTTPS Gemini Developer API");
      }
      const url = new URL(`${baseUrl.pathname.replace(/\/$/, "")}/models/${encodeURIComponent(process.env[modelKey]!)}`, baseUrl.origin);
      const response = await fetch(url, {
        headers: { "x-goog-api-key": process.env[keyKey]! },
        redirect: "error",
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error(`Gemini model metadata returned HTTP ${response.status}`);
      return `Gemini model metadata responded with HTTP ${response.status}; no inference invoked`;
    });
  }
}

if (!hasPlaceholder(process.env.ARC_RPC_URL)) {
  await check("arc-network", async () => {
    const rpcUrl = new URL(process.env.ARC_RPC_URL!);
    if (rpcUrl.protocol !== "https:" && rpcUrl.hostname !== "127.0.0.1" && rpcUrl.hostname !== "localhost") {
      throw new Error("RPC endpoint must use HTTPS");
    }
    const response = await fetch(rpcUrl.href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error(`RPC endpoint returned HTTP ${response.status}`);
    const data = (await response.json()) as { result?: string };
    const chainId = Number.parseInt(data.result ?? "0", 16);
    return `Arc network responded with chain ID ${chainId}`;
  });
}

if (!hasPlaceholder(process.env.CIRCLE_API_KEY) && !hasPlaceholder(process.env.CIRCLE_WALLET_ID)) {
  checks.push({
    name: "circle-wallet",
    ok: true,
    detail: `Circle wallet ID ${process.env.CIRCLE_WALLET_ID} configured for developer-controlled transfers`
  });
}

jsonLog({ ok: checks.every(({ ok }) => ok), checks });
if (checks.some(({ ok }) => !ok)) process.exitCode = 1;
