import { writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { auditSchema } from "@agentpay/core";

test("durable owner workflow, exact approval, audit and scheduled worker restart", async ({ page }, testInfo) => {
  const pool = new Pool({ connectionString: process.env.AP_TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
  let worker: ChildProcess | null = null;
  function startWorker() {
    worker = spawn(process.execPath, ["--import", "tsx", "tests/e2e-durable/worker.ts"], { stdio: "inherit", env: {
      PATH: process.env.PATH, AP_TEST_DATABASE_URL: process.env.AP_TEST_DATABASE_URL
    } });
    return worker;
  }
  async function stopWorker() {
    if (!worker || worker.exitCode !== null) return;
    const child = worker;
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exit, setTimeout(5000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await exit; }
    worker = null;
  }
  const businessId = "synthetic-business";
  async function newSession(){
    await page.getByRole("button",{name:"Sign out",exact:true}).click();
    await page.getByLabel("Access code").fill("synthetic-operator-code");
    await page.getByRole("button",{name:"Sign in",exact:true}).click();
    await expect(page.getByRole("button",{name:"Sign out",exact:true})).toBeVisible();
  }

  try {
    startWorker();
    await page.goto("/dashboard");
    await page.getByLabel("Access code").fill("synthetic-operator-code");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.goto("/dashboard/records/vendors");
    await page.getByRole("button", { name: "Load administration", exact: true }).click();
    await page.getByRole("button", { name: "Edit vendor vendor", exact: true }).click();
    await page.getByLabel("Approved aliases, separated by commas").fill("Synthetic alias");
    await page.getByLabel("Vendor change reason").fill("Durable browser verifies registry history");
    await page.getByRole("button", { name: "Save vendor", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Vendor saved");
    await page.goto("/dashboard/treasury");
    await page.getByRole("button", { name: "Resume treasury", exact: true }).click();
    await page.getByLabel("Pause or resume reason").fill("Enable isolated durable acceptance");
    await page.getByRole("button", { name: "Confirm resume", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause treasury", exact: true })).toBeVisible();
    await page.goto("/dashboard/invoices/new");
    await page.getByLabel("Invoice image").setInputFiles("fixtures/synthetic-invoice.png");
    await page.getByRole("button", { name: "Save invoice", exact: true }).click();
    await expect.poll(async () => (await pool.query<{ action: string }>("SELECT action FROM ap_decisions WHERE business_id=$1 ORDER BY evaluated_at DESC LIMIT 1", [businessId])).rows[0]?.action,
      { timeout: 30000 }).toBe("REQUIRE_APPROVAL");
    await expect(page).toHaveURL(/\/dashboard\/invoices\/[a-f0-9-]+$/);
    const invoiceUrl=page.url();
    await newSession();
    await page.goto("/dashboard/actions");
    await expect(page.getByRole("button",{name:"Awaiting approval queue",exact:true})).toContainText("1");
    await expect(page.getByRole("heading",{name:"1 matching invoice",exact:true})).toBeVisible();
    await expect(page.getByRole("radio",{name:"Select invoice TEST-1",exact:true})).toBeChecked();
    await expect(page.getByRole("heading",{name:"Review guidance",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"On hold queue",exact:true}).click();
    await expect(page.getByRole("heading",{name:"No matching invoices",exact:true})).toBeVisible();
    await expect(page.getByRole("heading",{name:"Review guidance",exact:true})).toHaveCount(0);
    await expect(page.getByRole("heading",{name:"Filter invoices",exact:true})).toHaveCount(0);
    await page.getByRole("button",{name:"All open actions queue",exact:true}).click();
    await page.getByLabel("Sort by",{exact:true}).selectOption("amount_desc");
    await expect(page.getByRole("heading",{name:"1 matching invoice",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Approve exact terms",exact:true})).toBeEnabled();
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>{const nav=document.getElementById("workspace-nav");return nav&&getComputedStyle(nav).visibility==="hidden"&&new DOMMatrixReadOnly(getComputedStyle(nav).transform).m41 < -250;});
    await expect(page.getByRole("heading",{name:"1 matching invoice",exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath("action-center-mobile.png"),fullPage:true});
    await page.setViewportSize({width:1672,height:941});
    await page.screenshot({path:testInfo.outputPath("action-center-desktop.png"),fullPage:true});
    await page.getByRole("button",{name:"Approve exact terms",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"Approve exact payment terms",exact:true})).toContainText("1.500000 USDC");
    await expect(page.getByRole("button",{name:"Confirm exact approval",exact:true})).toBeDisabled();
    await page.getByRole("button",{name:"Close",exact:true}).click();
    expect((await pool.query("SELECT 1 FROM ap_payment_intents WHERE business_id=$1",[businessId])).rowCount).toBe(0);
    await page.getByRole("button",{name:"Reject",exact:true}).click();
    await expect(page.getByRole("button",{name:"Confirm rejection",exact:true})).toBeDisabled();
    await page.getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("button",{name:"Re-evaluate",exact:true}).click();
    await page.getByLabel("Action reason",{exact:true}).fill("Recheck isolated evidence before exact approval");
    await page.getByRole("button",{name:"Confirm re-evaluation",exact:true}).click();
    await expect.poll(async () => (await pool.query<{action:string}>("SELECT d.action FROM ap_decisions d JOIN ap_obligations o ON o.business_id=d.business_id AND o.id=d.obligation_id AND o.version=d.obligation_version WHERE o.business_id=$1 ORDER BY evaluated_at DESC LIMIT 1",[businessId])).rows[0]?.action,{timeout:30000}).toBe("REQUIRE_APPROVAL");
    await page.getByRole("button",{name:"Refresh",exact:true}).click();
    await page.getByRole("button",{name:"Approve exact terms",exact:true}).click();
    await page.getByLabel("Action reason",{exact:true}).fill("Exact durable synthetic approval from action card");
    await page.getByRole("button",{name:"Confirm exact approval",exact:true}).click();
    await expect.poll(async () => (await pool.query<{ state: string }>("SELECT state FROM ap_payment_intents WHERE business_id=$1", [businessId])).rows[0]?.state,
      { timeout: 30000 }).toBe("SETTLED");
    await newSession();
    await page.goto(invoiceUrl);
    await page.getByRole("button", { name: "Refresh invoice", exact: true }).click();
    await expect(page.getByText("Synthetic settlement fixture. No real transfer occurred.", { exact: true })).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export activity", exact: true }).click();
    const stream = await (await downloaded).createReadStream(); let content = "";
    for await (const chunk of stream) content += String(chunk);
    const audit = auditSchema.parse(JSON.parse(content));
    const evidencePath = testInfo.outputPath("synthetic-durable-audit.json");
    await writeFile(evidencePath, JSON.stringify({ synthetic: true, audit }, null, 2));
    await testInfo.attach("synthetic-durable-audit.json", { path: evidencePath, contentType: "application/json" });
    expect(audit.payment?.state).toBe("SETTLED");
    expect(audit.approvals?.[0]?.consumedAt).not.toBeNull();
    expect(audit.approvals?.[0]?.terms.vendorAddressVersion).toBe(2);
    expect(audit.decisions?.[0]?.treasury?.cash?.blockNumber).toBe("100");
    await page.goto("/dashboard/payments");
    await expect(page.getByRole("row").filter({hasText:"settled"})).toContainText("1.500000 USDC");
    await page.getByRole("button",{name:"View payment",exact:true}).click();
    await expect(page.getByRole("dialog")).toContainText("Payment evidence");
    await expect(page.getByRole("button",{name:"Pay again",exact:true})).toHaveCount(0);
    await page.getByRole("button",{name:"Close",exact:true}).click();
    await page.goto("/dashboard/activity");
    await expect(page.getByText("payment settled",{exact:true})).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Access code").fill("synthetic-operator-code");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.goto("/dashboard/treasury");
    await page.getByRole("button", { name: "Load administration", exact: true }).click();
    await page.getByLabel("Automatic payment maximum", { exact: true }).fill("2");
    await page.getByLabel("Policy change reason").fill("Allow future synthetic schedule");
    await page.getByRole("button", { name: "Save policy", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Policy saved");
    await page.goto("/dashboard/records/purchase-orders");
    await page.getByRole("button", { name: "Load administration", exact: true }).click();
    await page.getByRole("button", { name: "New purchase order", exact: true }).click();
    await page.getByLabel("Purchase order ID", { exact: true }).fill("future-po");
    await page.getByLabel("Purchase order vendor ID").fill("vendor");
    await page.getByLabel("Authorized amount, USDC").fill("1.5");
    await page.getByLabel("Purchase order due date").fill("2099-01-01");
    await page.getByLabel("Accepted service description").fill("Synthetic future service");
    await page.getByLabel("Delivery accepted", { exact: true }).check();
    await page.getByLabel("Independent acceptance reference").fill("synthetic:accepted-future");
    await page.getByLabel("Purchase order change reason").fill("Durable future scenario");
    await page.getByRole("button", { name: "Save purchase order", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Purchase order saved");
    await page.goto("/dashboard/invoices/new");
    await page.getByLabel("Invoice image").setInputFiles("fixtures/synthetic-invoice-2.png");
    await page.getByRole("button", { name: "Save invoice", exact: true }).click();
    await expect.poll(async () => (await pool.query<{ action: string }>("SELECT d.action FROM ap_decisions d JOIN ap_obligations o ON o.business_id=d.business_id AND o.id=d.obligation_id WHERE o.business_id=$1 AND o.normalized_invoice_number='FUTURE-2' ORDER BY d.evaluated_at DESC LIMIT 1", [businessId])).rows[0]?.action,
      { timeout: 30000 }).toBe("SCHEDULE");
    await page.getByRole("button", { name: "Refresh invoice", exact: true }).click();
    await expect(page.getByRole("region", { name: "Decision explanation", exact: true }).getByText("schedule", { exact: true })).toBeVisible();
    await page.getByLabel("Review reason").fill("Confirm independent service evidence");
    await page.getByLabel("Field to correct").selectOption("serviceDescription");
    await page.getByLabel("Corrected value", { exact: true }).fill("Accepted future service");
    await page.getByLabel("Independent evidence reference").fill("synthetic:accepted-future");
    await page.getByRole("button", { name: "Save correction", exact: true }).click();
    await expect.poll(async () => (await pool.query<{ action: string }>("SELECT d.action FROM ap_decisions d JOIN ap_obligations o ON o.business_id=d.business_id AND o.id=d.obligation_id AND o.version=d.obligation_version WHERE o.business_id=$1 AND o.normalized_invoice_number='FUTURE-2' ORDER BY d.evaluated_at DESC LIMIT 1", [businessId])).rows[0]?.action,
      { timeout: 30000 }).toBe("SCHEDULE");
    await page.getByRole("button", { name: "Refresh invoice", exact: true }).click();
    await expect(page.getByRole("region", { name: "Decision explanation", exact: true }).getByText("schedule", { exact: true })).toBeVisible();
    await stopWorker();
    const before = (await pool.query<{ version: number; next: string }>("SELECT version,next_evaluation_at::text AS next FROM ap_obligations WHERE business_id=$1 AND normalized_invoice_number='FUTURE-2'", [businessId])).rows[0]!;
    const restarted = startWorker();
    await setTimeout(1200);
    expect(restarted.exitCode).toBeNull();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Invoice detail", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Decision explanation", exact: true }).getByText("schedule", { exact: true })).toBeVisible();
    const after = (await pool.query<{ version: number; next: string }>("SELECT version,next_evaluation_at::text AS next FROM ap_obligations WHERE business_id=$1 AND normalized_invoice_number='FUTURE-2'", [businessId])).rows[0];
    expect(after).toEqual(before);
    expect((await pool.query("SELECT 1 FROM ap_payment_intents WHERE business_id=$1", [businessId])).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM ap_registry_revisions WHERE business_id=$1", [businessId])).rowCount).toBe(3);
    await newSession();
    await page.goto("/dashboard/actions");
    await page.getByRole("button",{name:"Scheduled queue",exact:true}).click();
    await expect(page.getByRole("region",{name:"Invoice payment actions",exact:true})).toContainText("FUTURE-2");
    await expect(page.getByRole("button",{name:"Approve exact terms",exact:true})).toBeDisabled();
    await page.getByRole("button",{name:"Reject",exact:true}).click();
    await page.getByLabel("Action reason",{exact:true}).fill("Reject isolated future invoice after restart verification");
    await page.getByRole("button",{name:"Confirm rejection",exact:true}).click();
    await expect.poll(async()=>(await pool.query<{status:string}>("SELECT status FROM ap_obligations WHERE business_id=$1 AND normalized_invoice_number='FUTURE-2'",[businessId])).rows[0]?.status).toBe("REJECTED");
    await page.getByRole("button",{name:"Rejected queue",exact:true}).click();
    await expect(page.getByRole("region",{name:"Invoice payment actions",exact:true})).toContainText("FUTURE-2");
    await expect(page.getByRole("button",{name:"Approve exact terms",exact:true})).toBeDisabled();
    await expect(page.getByRole("button",{name:"Reject",exact:true})).toBeDisabled();
    await expect(page.getByRole("button",{name:"Re-evaluate",exact:true})).toBeDisabled();
    expect((await pool.query("SELECT 1 FROM ap_payment_intents WHERE business_id=$1",[businessId])).rowCount).toBe(1);

  } finally { await stopWorker(); await pool.end(); }
});
