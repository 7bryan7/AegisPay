import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApApp } from "../apps/server/src/ap/app.js";
import { createFixtureStore, fixtureConfig } from "../tests/support/ap-fixture.js";

// Explicit manual-test harness. The production entrypoint never imports this
// store. No database, extraction worker or live payment adapter is constructed.
const webOrigin = "http://127.0.0.1:3200";
const config = { ...fixtureConfig, PORT: 4200, WEB_ORIGIN: webOrigin,
  SESSION_SECRET: randomBytes(32).toString("hex") };
const app = express();
const samples = new Map([ ["invoice-1.png", "synthetic-invoice.png"], ["invoice-2.png", "synthetic-invoice-2.png"] ]);
app.get("/samples/:name", (request, response) => {
  const filename = samples.get(request.params.name);
  if (!filename) { response.sendStatus(404); return; }
  response.download(fileURLToPath(new URL(`../fixtures/${filename}`, import.meta.url)));
});
app.use(createApApp(config, createFixtureStore()));
const server = app.listen(config.PORT, "127.0.0.1");
await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });

const web = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)),
  "dev", "apps/web", "--hostname", "127.0.0.1", "--port", "3200"], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:4200" }
});
console.log(`
Local synthetic demo: ${webOrigin}
Operator code: ${fixtureConfig.DEMO_ACCESS_CODE}
Reviewer code: ${fixtureConfig.REVIEWER_ACCESS_CODE}
Sample images: http://127.0.0.1:4200/samples/invoice-1.png
               http://127.0.0.1:4200/samples/invoice-2.png
For simulated approval/settlement, upload sample 2 with PO reference SYNTHETIC-PAYMENT-SCENARIO.
No model, database or payment provider is used. Records reset on restart. Ctrl+C stops the demo.
`);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  web.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
web.once("error", () => { process.exitCode = 1; stop(); });
web.once("exit", (code) => { if (!stopping) process.exitCode = code ?? 1; stop(); });
