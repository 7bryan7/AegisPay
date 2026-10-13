import { expect, test } from "@playwright/test";

test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => console.error(`Browser error: ${error.message}`));
});

test("operator uploads a synthetic invoice through the API and sees honest pending state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Treasury workspace" })).toBeVisible();
  await page.getByLabel("Access code").fill("synthetic-operator-code");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Invoice image").setInputFiles("fixtures/synthetic-invoice.png");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await expect(page.getByRole("heading", { name: "Invoice detail" })).toBeVisible();
  await expect(page.getByText("No verified decision yet.")).toBeVisible();
  await expect(page.getByText("No transfer initiated.", { exact: true })).toBeVisible();
  await expect(page.getByText("synthetic invoice received", { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/ap-dashboard.png", fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "View invoice" }).click();
  await expect(page.getByRole("heading", { name: "Invoice detail" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export activity" }).click();
  expect((await download).suggestedFilename()).toMatch(/activity.json$/);
  await page.getByLabel("Invoice image").setInputFiles("fixtures/synthetic-invoice.png");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await expect(page.getByRole("status")).toContainText("already saved");
  await expect(page.getByRole("button", { name: "View invoice" })).toHaveCount(1);
});

test("reviewer sees no private invoices or upload control", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await page.getByLabel("Access code").fill("synthetic-reviewer-code");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Reviewer access is isolated from private data.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Upload invoice" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View invoice" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/ap-mobile.png", fullPage: true });
});

test("backend outage is visible without fabricated balances", async ({ page }) => {
  await page.route("**/api/session", (route) => route.abort());
  await page.goto("/dashboard");
  await expect(page.getByRole("status")).toContainText("Backend unavailable");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
});

test("synthetic approval and settlement are visible with exportable evidence and pause controls",async({page})=>{
  await page.goto("/dashboard");
  await page.getByLabel("Access code").fill("synthetic-operator-code");
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await page.getByRole("button",{name:"Resume treasury",exact:true}).click();
  await expect(page.getByRole("button",{name:"Pause treasury",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Pause treasury",exact:true}).click();
  await page.getByLabel("Purchase order reference (optional)").fill("SYNTHETIC-PAYMENT-SCENARIO");
  await page.getByLabel("Invoice image").setInputFiles("fixtures/synthetic-invoice-2.png");
  await page.getByRole("button",{name:"Save invoice",exact:true}).click();
  await expect(page.getByText("Synthetic amount exceeds automatic threshold.",{exact:false})).toBeVisible();
  await page.getByLabel("Operator approval rationale").fill("Synthetic test approval");
  await page.getByRole("button",{name:"Approve invoice",exact:true}).click();
  await expect(page.getByText("Synthetic settlement fixture. No real transfer occurred.",{exact:true})).toBeVisible();
  await expect(page.getByText("synthetic payment settled",{exact:true})).toBeVisible();
  const downloaded=page.waitForEvent("download");
  await page.getByRole("button",{name:"Export activity",exact:true}).click();
  const stream=await(await downloaded).createReadStream();let json="";
  for await(const chunk of stream) json+=String(chunk);
  expect(JSON.parse(json)).toMatchObject({payment:{state:"SETTLED",verificationReference:"synthetic-receipt-not-chain-evidence"}});
});
