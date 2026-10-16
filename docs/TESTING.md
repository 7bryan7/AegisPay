# Local testing

Use Node 22.x and npm 10 or newer. Install locked dependencies once:

```bash
cd /home/bryan/Desktop/AegisPay
npm ci --include=dev
```


## Current workspace structure

Redesign verification on 16 October: **250 regular tests, 52 PostgreSQL tests, six fixture browser journeys, one PostgreSQL-backed browser/worker-restart journey, production build, typechecks and lint passed**. Final reporting queries and desktop/mobile rendering were also checked against the configured application without payment actions.

For actual configured operation, use `npm run dev` and a separate `npm run worker`, then open **http://localhost:3000/dashboard**. Apply all forward migrations through **009** with `npm run db:migrate`; 009 adds reporting indexes and does not change financial terms. The current configured database has already received it.

The operator sidebar provides Overview, Invoices, Action Center, Payments, Treasury, Business Records, and Activity and Audit, plus Settings and Status in the footer. Upload is `/dashboard/invoices/new`; each stored invoice has `/dashboard/invoices/[id]`. Vendor and PO forms live under `/dashboard/records`; policy and reasoned pause/resume live in Treasury. Approvals and rejection now have explicit confirmation dialogs. Sign-in on a direct route preserves that destination, and reviewer sessions do not mount operator views.

Operational counts and filters come from authenticated PostgreSQL queries across the business, not from the current inbox page. Payments enumerates stored attempts, including failed/cancelled ones; activity is a paginated owned event feed. Treasury metrics still use the complete ledger and fresh Arc evidence. No screen falls back to mock balances, companies, payments or success. Empty/unavailable data is shown explicitly. Previously authorized synthetic database records retain their test identity; they are not genuine business usage.

Reviewer examples remain explicitly synthetic at `/reviewer`. Automated fixtures and the optional `npm run demo` harness are isolated test tools, not configured operational data. The in-memory demo does not implement the new global reporting APIs, so those panels report unavailable in that harness; use the configured database or disposable database-backed browser test for complete reporting coverage. The public landing page is unchanged.

Read-only backend additions: `GET /api/workspace/summary`, `GET /api/workspace/invoices` (server search/decision/lifecycle filters), `GET /api/payments` (optional state), and `GET /api/activity` (optional invoice UUID). Lists use 25-record pagination. All are operator-only, business-scoped and return allowlisted typed data. No new raw-transfer endpoint exists.

## Isolated UI test harness

```bash
npm run demo
```

Open **http://127.0.0.1:3200**. The home route shows the product landing page; choose **Open treasury workspace** to reach the dashboard.

- Operator code: `synthetic-operator-code`
- Reviewer code: `synthetic-reviewer-code`
- Download [sample 1](http://127.0.0.1:4200/samples/invoice-1.png) or [sample 2](http://127.0.0.1:4200/samples/invoice-2.png) while the demo is running.

Owner administration and durable evidence use the database-backed application below; the in-memory demo supplies limited review/payment UI fixtures.

This is an isolated, loopback-only manual-test harness with in-memory synthetic data. It does not use your database, Gemini or Circle credentials, and cannot send a real payment. Stop it with Ctrl+C; its records reset on restart. It uses ports 3200/4200, separate from development (3000/4000) and automated browser tests (3100/4100).

### Manual acceptance checklist

1. Sign in as operator. Open Invoices → Upload invoice and upload sample 1 without a PO reference. Open the invoice: it should show pending extraction and no transfer. Reload, open it again, and export its activity JSON.
2. Return to the upload page and upload sample 1 again. Expect a duplicate warning and one stored invoice.
3. Return to the upload page and upload sample 2 with the PO reference `SYNTHETIC-PAYMENT-SCENARIO`. Expect a synthetic approval decision. Enter a rationale, review its exact terms, and confirm approval. With the treasury paused, no transfer should appear.
4. Open Treasury, resume it with a reason and confirmation, then return to the invoice. The approved sample becomes **synthetically settled**, with an explicit notice that no real transfer occurred. Export its evidence JSON.
5. Sign out and sign in as reviewer. Expect no private invoices, upload controls or spending controls. Open Reviewer access and use “Load reviewer examples” to evaluate six isolated synthetic policy cases, including duplicate refusal and a verified discount.
6. Stop and restart the demo. Its invoices should be gone.

The synthetic decision is selected by the special PO reference, not extracted from the image. This harness tests interaction and failure states, not real invoice recognition, database durability or chain settlement.

## Automated checks

Verified on 15 October 2026: lint/typecheck, **247 regular tests, 47 PostgreSQL tests,
6 Chromium fixture journeys, 1 PostgreSQL-backed Chromium journey with a real
worker-process restart, and the production build** all passed. Earlier clean
lockfile installation and dependency audit passed (zero known advisories).
Actual Gemini/Circle/Arc acceptance was not run.

Stop `npm run demo` before running the production build or browser suite: they
use the same Next.js workspace and development build directory.

```bash
npm run lint
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run test:e2e
npm run test:db
npm run test:e2e:db
npm audit
```

On a fresh machine, install the browser before `test:e2e`:

```bash
npm exec playwright install chromium
```

Alternatively use installed Chrome: `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`.

`test:db` requires accessible Docker. It creates a PostgreSQL 17 container on a random loopback port, waits for it, runs the actual PostgreSQL suite and removes its container. It never uses the application database or a preexisting `AP_TEST_DATABASE_URL`. No Compose plugin is required. If Docker reports a permission error, grant your account the intended Docker access before running the command.

If you already maintain a separate disposable PostgreSQL test database, set `AP_TEST_DATABASE_URL` and run `npm run test:postgres` instead. It must differ from `DATABASE_URL`.

## Database-backed development

The demo is separate from the application entrypoint. To exercise durable storage:

```bash
cp -n .env.payables.example .env
```

Configure your intended local `DATABASE_URL`, `SESSION_SECRET` (at least 32 characters), `DEMO_ACCESS_CODE` (at least 12 characters), and `BUSINESS_ID`. Keep `PAYMENT_DISPATCH_ENABLED=false`. For the bundled synthetic enrollment set `PAYMENT_MODE=fixture` and `BUSINESS_ID=local-business`.

```bash
npm run build -w @agentpay/core
npm run db:migrate
npm run seed:payables -- --file fixtures/payables.fixture.json --actor fixture-owner --check
npm run seed:payables -- --file fixtures/payables.fixture.json --actor fixture-owner
npm run dev
```

Open **http://localhost:3000/dashboard**. Use `localhost` consistently with the configured trusted origin. `npm run dev` now builds core automatically. If shared core code changes, rebuild it before refreshing the apps.

Run `npm run worker` in another terminal to exercise queued processing/retention. Normal fixture mode intentionally has no synthetic extraction/planning/settlement adapters: invoices remain held or pending. The manual demo above supplies those UI fixtures separately. Do not expect `/ready` to become financially ready in fixture mode.

For a production-style local build use `npm run build`, then `npm run start`. The worker still runs separately. If you change the public API URL, put `NEXT_PUBLIC_API_BASE_URL` in `apps/web/.env.local` before building; default is `http://localhost:4000`.

## Live acceptance remains separate

**Configured checkpoint, 16 October 2026:** This checkout's private `.env` now connects through Supabase Session pooler. Migrations through 008 and explicitly synthetic treasury/vendor/PO enrollment are complete. The local dashboard/API and worker were started, readiness and doctor passed, and actual Gemini extraction succeeded for `.local/synthetic-arc-invoice.png` (0.10 testnet USDC). The invoice is already in the inbox; uploading it again is rejected as a duplicate. These local runtime files are ignored and are not bundled fixtures for a fresh clone.

Open **http://localhost:3000/dashboard**, and sign in using your private `DEMO_ACCESS_CODE`. If the processes have stopped, run `npm run dev` and, in a separate terminal, `npm run worker` from the repository root. Keep `PAYMENT_DISPATCH_ENABLED=false` for inspection/extraction testing. Resuming the treasury in the dashboard does not enable this environment flag. A bounded actual payment and independently verified settlement remain outstanding acceptance work.

**Subsequent owner opt-in, 16 October:** At the user's request, this checkout's private dispatch flag was enabled and the API/dashboard/worker restarted. Readiness confirms `dispatchEnabled=true`; the treasury is resumed. The synthetic 0.10-USDC invoice requires explicit dashboard approval before payment. No approval or transfer was performed by the assistant during enablement. To return to inspection-only testing, set `PAYMENT_DISPATCH_ENABLED=false` and restart the API and worker; pausing the treasury in the dashboard also stops new submissions while reconciliation continues.

Real extraction requires your configured Gemini key and an available vision/structured-output model. Real testnet settlement additionally requires the intended Circle developer EOA wallet, entity secret and API key, verified Arc settings, owner-verified vendor/PO enrollment and explicit dispatch opt-in. Use a separate development database; do not convert fixture records into live identities.

`npm run doctor` makes read-only checks against configured dependencies. Never treat a green fixture suite or liveness endpoint as live settlement evidence. Apply all forward migrations through 008 before using corrections, registry/PO/policy editing, discounts, treasury summaries or audit history. The owner dashboard exposes these controls; each mutation requires its current version and a reason.

The Render blueprint now defines API and background-worker services using shared values via service references, following the [Render Blueprint specification](https://render.com/docs/blueprint-spec). Frontend hosting is separate. Cloud deployment, migration and end-to-end production-cookie testing were not performed; review service plans and supply settings before deploying.

## Full-scope controls and durable browser test

`npm run test:e2e:db` creates a fresh PostgreSQL 17 container, starts the real API/store on 4300 and dashboard on 3300, and launches a separate synthetic worker. The browser edits registry/policy records, approves exact terms, exports durable settlement evidence, creates a future PO, corrects its invoice, and checks the schedule survives worker termination/restart without another payment. Model/provider/receipt adapters are explicit test doubles; no real external calls or transfers occur. It removes its database afterward. Run it sequentially with the normal browser suite/build because all share the Next workspace.

In database-backed development, use **Load administration** for vendor/PO/policy changes. Discounts live on the independently verified PO: exact USDC payout, valid-through UTC date, verification time/reference and full settlement agreement. The original nominal amount remains unchanged. Default annual cash-preservation cost is zero; change the policy basis points when a documented cost is appropriate. Existing POs default to essential, protecting accepted open commitments due within seven days.

For invoices, supply a review reason and independent reference when correcting facts. Evaluation/re-extraction/rejection invalidate old unsubmitted authorization. Submitted/unknown/settled transfers cannot be edited or resent. Review similar invoice references and reject duplicates or correct independently verified facts. Manual reconciliation only checks an existing unresolved intent.

Treasury spendable cash requires fresh Arc evidence and verified inclusion of existing transfers. Missing/stale evidence is unavailable, not zero. The decision detail retains the historical snapshot separately. The private activity export includes allowlisted decision versions, approvals, correction history, fee/cash/discount evidence and verified receipt references. Reviewer simulations never access those records.


## Invoice review layout

Open `/dashboard/invoices` and select **View invoice**. The redesigned detail page separates source/facts/current verification and stored decision evidence from the decision/payment sidebar. Check the real source hash, metadata and private image link; expand vendor/PO checks; review exact approval terms; supply independent evidence and a rationale for corrections. Audit/treasury/policy outages show unavailable panels without hiding the invoice; unavailable audit data disables export. The timeline shows 20 loaded events initially, with an explicit expand/collapse control. Mobile places decision/actions before evidence and payment/treasury/scope after it. See [the layout and data semantics](INVOICE_REVIEW_REDESIGN.md). Existing confirmation, dispatch and unresolved-payment rules still apply.


## Action Center layout

Open `/dashboard/actions`. The Filter invoices panel is removed; use the queue cards to select approval, hold, scheduled, rejected or all open actions. Sort by due date or exact amount and select a row. Its payment-action card loads actual invoice detail. Approve exact terms should open the current exact payout/recipient/version confirmation, with a required reason. Cancel first and verify no approval/payment is created. Reject and Re-evaluate similarly require reasons and explicit confirmation. Check unavailable/expired offers, stale versions, and disabled actions for submitted/unresolved/settled/rejected records. Confirm Close/Escape cannot dismiss an in-flight card command. Use only isolated fixtures for automated financial mutations. Configured approvals may proceed through the existing worker when dispatch is enabled. See [Action Center semantics](ACTION_CENTER.md).
