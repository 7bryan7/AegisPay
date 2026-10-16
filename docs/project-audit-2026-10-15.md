# Project audit — 15 October 2026

> This records the initial audit before the subsequent fixes. For current commands and limitations, see [TESTING.md](TESTING.md) and the later history entry. The route failure, heartbeat/configuration issues and dependency advisories below were addressed during the testing-preparation follow-up; the original findings are preserved here as evidence.

## Verdict

The project runs locally and its core accounts-payable implementation has substantial automated coverage. It is **not a completed, release-ready payment product**. Local compilation, application startup, domain/API tests and real PostgreSQL tests pass. The checked-in browser suite has one failing route assumption. Actual Gemini extraction and Circle/Arc settlement remain unverified in this checkout.

This is a code and executable-check assessment, not a proof that every possible defect has been found. No live model inference, wallet creation, funding, transfer or deployment was performed.

## Architecture and delivered behavior

- npm workspaces: `packages/core` contains Zod contracts, integer money handling, obligation verification, policy, approvals and treasury accounting.
- `apps/server` runs an Express AP API with signed operator/reviewer sessions, origin and CSRF checks, bounded PNG/JPEG uploads, idempotency, invoice/detail/image reads, approval, pause/resume and activity export.
- PostgreSQL migrations 001–005 supply legacy and AP tables, constraints, immutable payment terms, audit guards, reservations and worker status.
- A separate worker implements extraction, independent vendor/PO matching, planning, scheduling, reservation, dispatch, reconciliation and retention cleanup. `npm run dev` and `npm run start` do not start this worker.
- Gemini adapters and a bounded planner exist. Circle developer-controlled-wallet submission and independent Arc receipt checking exist. Financial decisions revalidate stored terms and policy under database locks.
- `/dashboard` is the AP interface. `/` still serves the inherited Hedera/ENS/x402 marketing site.

## Checks actually executed

Environment: Linux, Node 22.23.3 and npm 10.9.9. The package engine requires Node 22.x and npm >=10. The version files pin Node 22.23.2; the tested installed patch satisfies the engine range.

| Check | Result |
|---|---|
| `npm ci --include=dev --no-fund --no-audit` | Passed; 915 packages installed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm test -- --maxWorkers=2` | Passed: 30 files, 230 tests |
| `npm run test:postgres` with isolated `AP_TEST_DATABASE_URL` | Passed: 35 tests against a disposable PostgreSQL 17 container |
| `npm run build` | Passed: shared core, server and Next.js production builds |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` | 3 passed, 1 failed |
| Temporary copy of failing browser scenario using `/dashboard` | Passed: upload, reload, export and duplicate detection |
| `PAYMENT_MODE=fixture npm run seed:payables -- --file fixtures/payables.fixture.json --actor fixture-owner --check` | Passed; no database connection |
| `npm run start` | API and web started successfully |
| GET `http://localhost:3000/` and `/dashboard` | Both HTTP 200; legacy homepage and AP dashboard respectively |
| GET `http://localhost:4000/health` | HTTP 200 |
| GET `http://localhost:4000/ready` | Expected HTTP 503: authentication, storage and workers unconfigured |
| GET `http://localhost:4000/api/session` | HTTP 200; `authenticated:false`, `loginAvailable:false` |
| `npm run doctor` | Expected exit 1: missing environment, healthy worker and Circle setup |
| `npm audit --json` | 37 flagged packages: 5 critical, 20 high, 5 moderate, 7 low |

Initial sandbox runs could not access npm or localhost and could not start test servers. Installation and network-dependent tests were rerun with the required permissions. The successful results above are from those reruns. Pure compilation and lint passed in the sandbox.

The regular Vitest configuration excludes PostgreSQL tests and the legacy `apps/web/lib/hedera-wallet-payment.test.ts`. PostgreSQL was checked separately; the excluded legacy wallet test was not run.

The browser fixture store simulates approval and settlement. Its successful synthetic settlement is not a Circle transfer or proof that the database-backed worker completes an actual payment.

## Findings and remaining completion work

1. **Live acceptance is unfinished.** No root `.env` exists in this checkout. Gemini account/model availability, Circle credentials and wallet identity, actual transfer encoding, live Arc receipt compatibility and a real end-to-end extraction/payment have not been demonstrated here. Mocked adapter and SDK wire tests do not establish provider acceptance. See the README's deferred live acceptance section.

2. **The checked-in browser suite fails.** `tests/e2e/scaffold.spec.ts:8` opens `/` and expects the `Treasury workspace` heading. `apps/web/app/page.tsx` renders the legacy landing page; the workspace lives at `/dashboard`. A temporary test copy changing only that navigation passed the complete upload scenario. The original test was left unchanged, so `npm run test:e2e` still fails as checked in.

3. **Dependencies need security review before release.** npm's audit reports 37 affected package entries, including critical findings for `next`, `protobufjs`, `proxy-addr`, `shell-quote` and the dependent `concurrently` entry. Other findings include active upload/image dependencies and the large inherited wallet tree. Counts include dependency propagation and are not 37 independently proven application exploits. Reachability was not exhaustively assessed, and no automatic fixes or version changes were applied. Raw results are saved beside this report.

4. **Deployment configuration does not match the full AP application.** `render.yaml` defines only the API service, uses legacy ENS/Hedera/Blocky402 settings, omits the AP worker service and omits AP-specific provider configuration. A separate web deployment file exists, but an always-running worker and correctly configured AP infrastructure still need an integrated deployment setup. `/health` proves the HTTP server responds, not financial readiness.

5. **Product migration remains visibly incomplete.** The homepage and its wallet UI still advertise the inherited Hedera workflow while the server entrypoint and treasury dashboard use Arc USDC. Several older README paragraphs also contradict later checkpoint updates. The latest history records are useful context but should not replace current test evidence.

6. **Operational editing and reviewer features are limited.** Registry/PO/policy enrollment is insert-only. There is no dashboard flow to correct extracted invoice facts, re-extract cached facts, or edit existing vendor/PO/policy records. Reviewer sessions deliberately return an empty isolated view; a browsable sanitized review dataset is absent. Advanced policy editing, Q&A and discounts were cut or deferred. These limits matter when real invoices need correction, even though the restricted MVP has substantial backend behavior.

7. **Worker heartbeat can expire during a healthy long batch.** `scripts/worker.ts` records its heartbeat after processing up to ten obligations, while each model extraction can wait up to 45 seconds and planning/network calls add time. The API requires a heartbeat younger than 90 seconds. A busy healthy worker can therefore be shown as unavailable. This is a static-code finding; a long-running load simulation was not performed.

8. **Some configuration and status fields are misleading.** The worker sleeps a hard-coded 30 seconds despite the example's `WORKER_POLL_MS`. Upload byte/pixel limits are hard-coded in the AP route and processing path despite the example's limit variables. `/health` and server startup log always say `dispatchEnabled:false`, even though worker configuration can enable dispatch; use `/ready` and authenticated treasury state for operational dispatch visibility. Dashboard sign-in/upload messages also retain unconditional setup/unavailable wording.

9. **Local fixture mode is limited.** Setting `PAYMENT_MODE=fixture` and enrolling the bundled manifest enables synthetic storage/UI exploration, but the normal worker does not inject a fake extractor/planner/settlement adapter. Automatic synthetic settlement is provided by test fixtures only. Missing extraction configuration produces an explicit hold, not a completed invoice workflow.

## Run locally: web and API preview

From the repository root:

```bash
cd /home/bryan/Desktop/AegisPay
node --version                    # use Node 22.x
npm ci --include=dev
npm run build -w @agentpay/core
npm run dev
```

Open `http://localhost:3000/dashboard`. The API uses `http://localhost:4000`. Use `localhost` consistently because the default trusted browser origin is exactly `http://localhost:3000`.

The shared core build is required on a fresh checkout because other workspaces import its `dist` exports. The dev command does not build or watch core. Rebuild core after changing shared code.

This preview starts with no credentials, but signing in and storing invoices require the following setup.

## Run locally: database-backed synthetic workspace

The following creates a separate local development database with persistent Docker storage. The password shown is only a local example. Docker must be running and accessible to your account; the audit host needed permission to access its Docker socket.

```bash
docker run --name aegispay-local-db \
  -e POSTGRES_USER=agentpay \
  -e POSTGRES_PASSWORD=agentpay_local_only \
  -e POSTGRES_DB=agentpay \
  -p 127.0.0.1:5432:5432 \
  -v aegispay-local-pgdata:/var/lib/postgresql/data \
  -d postgres:17

cp -n .env.payables.example .env
```

If port 5432 is occupied, choose a different host port and update `DATABASE_URL`. For subsequent runs of this same container, use `docker start aegispay-local-db` instead of creating it again.

Edit the root `.env` with these values, preserving the other template settings:

```dotenv
NODE_ENV=development
DATABASE_URL=postgresql://agentpay:agentpay_local_only@localhost:5432/agentpay
BUSINESS_ID=local-business
WEB_ORIGIN=http://localhost:3000
PAYMENT_MODE=fixture
PAYMENT_DISPATCH_ENABLED=false
SESSION_SECRET=PASTE_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
DEMO_ACCESS_CODE=CHOOSE_AN_OPERATOR_CODE_AT_LEAST_12_CHARACTERS
```

Generate a secret locally with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`. Choose a distinct reviewer code of at least 12 characters if reviewer access is wanted.

Then run:

```bash
npm run build -w @agentpay/core
npm run db:migrate
npm run seed:payables -- --file fixtures/payables.fixture.json --actor fixture-owner --check
npm run seed:payables -- --file fixtures/payables.fixture.json --actor fixture-owner
npm run dev
```

Sign in at `http://localhost:3000/dashboard` with your `DEMO_ACCESS_CODE`. This supports synthetic treasury records, invoice uploads, listing, details, audit and pause/resume. It does not automatically extract or settle invoices. The bundled manifest and PNG assets are independent examples, not guaranteed matching payable evidence.

If you change the API origin, supply `NEXT_PUBLIC_API_BASE_URL` in `apps/web/.env.local`; Next runs from that workspace and does not automatically read the root `.env` for public build values. The default already points to `http://localhost:4000`.

## Production build and worker commands

For a local production build:

```bash
npm run build
npm run start
```

Run the worker in another terminal when the database and intended records are configured:

```bash
cd /home/bryan/Desktop/AegisPay
npm run worker
```

For real extraction, configure the Gemini key, explicit model ID and exact base URL from `.env.payables.example`. Fixture mode never invokes the real model. For a full testnet workflow, use a separate database with owner-verified enrollment and matching `PAYMENT_MODE=arc_testnet`, the intended Circle wallet/key/entity secret, Arc address/RPC/chain/token and planning/fee settings. Do not reuse fixture identities or simply switch their mode: enrollment refuses overwriting existing treasury terms. New treasuries start paused.

Keep dispatch disabled while checking setup. `npm run doctor` is read-only but can call configured external services; successful readiness still does not establish live settlement. Real payment dispatch requires deliberate configuration of `PAYMENT_DISPATCH_ENABLED=true`, an unpaused treasury and eligible verified obligations.

## Reproduce verification

```bash
npm run lint
npm run typecheck
npm test -- --maxWorkers=2
npm run build
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
npm audit
```

The browser command assumes installed Google Chrome. Alternatively install Playwright Chromium with `npx playwright install chromium` and run `npm run test:e2e`. The original route mismatch remains until fixed.

For PostgreSQL coverage, create a separate disposable test database, set `AP_TEST_DATABASE_URL` to it, then run `npm run test:postgres`. Never point this at the application database. The suite creates and removes its own random schema.

## Audit side effects

Dependencies and ignored compiler/test artifacts were generated. A disposable PostgreSQL container was started, used only for the 35-test suite and stopped with automatic removal; its image remains cached in Docker. The application API/web processes and browser test servers were stopped. A temporary diagnostic test was removed. The original source, dependency versions, lockfile and credentials were not changed. This report, the dependency audit JSON and an appended history entry are the durable audit outputs.
