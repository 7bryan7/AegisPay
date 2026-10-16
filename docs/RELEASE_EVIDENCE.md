# Implementation and acceptance evidence

This checkout contains uncommitted implementation work on top of base commit
`ccc568aa46fb6fedc006faf5ce25e94f15e373c7`. The base commit alone does not identify
the delivered source. Run `npm run evidence:source` to generate
`docs/evidence/source-manifest.json`, containing per-file hashes and a source
fingerprint without reading environment secrets, uploads or runtime databases.
Regenerate it after source changes. It is source evidence, not a signed release
or a reproducible binary-build attestation.

## Offline evidence

- Meaningful domain/API tests: integer amounts, evidence/PO matching, versioned corrections, exact approvals, budgets, discounts/expiry, roles, CSRF and reviewer isolation.
- Disposable PostgreSQL tests: migrations, concurrent reservations/changes, unknown holds/recovery, immutable identities, settlement conflicts, discounted full settlement, similarity guards and private audit/treasury projections.
- Chromium fixture journeys: upload/reload/duplicates, corrections, approval/pause/simulated settlement, mobile reviewer isolation, outage and reviewer policy examples.
- PostgreSQL-backed Chromium journey: actual API/store, owner administration, exact approval/consumption, exported evidence, future PO/correction and a separately terminated/restarted synthetic worker preserving its schedule without a second intent.
- The durable browser test attaches `synthetic-durable-audit.json` under `test-results/postgres/`. A verified copy is included at `docs/evidence/synthetic-durable-audit.json`. It is marked synthetic. Test data, model output, provider states and receipts in that file are not real business or chain evidence.
- Exact verification results and corrections are appended to `HISTORY.MD`. Build/lint/typecheck results do not establish live provider compatibility.

Pinned primary integrations: Next.js 16.4.1, React 19.3.0, Circle developer-controlled Wallets SDK 10.8.1, Google AI adapter 4.0.67 and AI SDK 7.0.97. The configured model is selected by `EXTRACTION_MODEL_ID`. Actual extraction using the configured alias `gemini-flash-lite-latest` and prompt `payable-extraction-v1` succeeded on 16 October on an explicitly synthetic invoice. This alias is mutable; an immutable provider model revision was not captured.

## Configured local acceptance checkpoint — 16 October 2026

The owner's Supabase Session pooler is reachable. Migrations 001–008 have matching checksums; 004–008 were newly applied without changing 001–003. The configured Circle treasury identity matches enrollment, and a separate controlled developer EOA recipient was created and verified on ARC-TESTNET. A labeled synthetic vendor/accepted PO and 0.10-USDC invoice were enrolled/uploaded through the normal application. These are simulated business terms, not commercial activity or comprehensive vendor screening.

Actual Gemini extraction initially returned HTTP 400. Controlled probes isolated the nested line-item `maxItems: 200` constraint in the provider schema. The provider-facing schema now omits that bound while the canonical application parser still rejects more than 200 items. Actual worker extraction then stored the correct vendor, PO, dates, currency and 100000 micro-USDC with original source evidence and no owner corrections. The invoice was held with `AUTONOMY_PAUSED`. A duplicate upload under a different request key returned 409.

Readiness and all doctor checks passed; the dashboard returned HTTP 200. Focused extraction/planner tests passed (11 tests), including the actual SDK request boundary and oversized-output rejection; relevant lint, server/root typechecks and server build passed. Earlier broad offline results remain historical, not a rerun of every suite after this targeted fix.

Setup enrolled the treasury paused. A subsequent application pause-change event resumed it during verification; that concurrent change was preserved. The final configuration still has `PAYMENT_DISPATCH_ENABLED=false` and the database has zero payment intents. No transfer was submitted. Local API/dashboard and the separate dispatch-disabled worker were left running for testing. Private setup journals, invoice and diagnostic files remain ignored under `.local/`; no credentials or raw provider payloads are included here.

## Configured acceptance record to complete locally

Keep credentials and full private invoices out of any public evidence bundle. Record:

1. Source fingerprint/build reference, Node/npm versions, migration names and test results.
2. Configuration variable **names** from `.env.payables.example`, without values for secrets.
3. Owner verification/acceptance references and consent for any shared pilot evidence.
4. One actual Gemini extraction and its model/prompt version; inspect extracted fields and uncertainty.
5. One authorized bounded Arc Testnet payment: Circle ID/state, exact nominal/adjustment/payout, token/chain/wallet/recipient, independently matched receipt and verified explorer link.
6. Duplicate refusal, unsafe-policy refusal, scheduling/restart and unresolved-outcome evidence. Never retry an unresolved attempt merely to obtain a success example.
7. Sanitized private audit export, known provider/receipt limitations and actual deployment/cookie checks if deployed.
8. Genuine pilot feedback, publication and the reviewed video/submission if those release steps are pursued.

No real inference, wallet operation, transfer, deployment, pilot participation,
video, publication or event submission is claimed by the offline implementation.
The README's real-world completion gate remains open until configured acceptance
and the applicable release evidence exist.

## Workspace restructuring verification on 16 October 2026

The owner's later instruction authorized necessary backend reporting changes and required actual operational data. The owner explicitly retained labeled landing/reviewer examples and isolated test fixtures. The root page, landing CSS, root layout and global CSS match their pre-redesign SHA-256 baseline exactly.

Delivered dedicated workspace routes and operator-only PostgreSQL read models for full-business summary/action queues, server-filtered invoices, all stored payment attempts and a paginated allowlisted activity feed. No in-memory fallback is used in configured operation. Empty and unavailable results remain explicit. Current vendor/PO evidence is projected into private invoice detail. Existing financial authorization and provider submission paths remain intact. Migration 009 adds reporting indexes; it is applied to the configured database, with all migration checksums through 009 verified.

Verification: 250 regular tests across 34 files, 52 actual PostgreSQL tests, six updated fixture Chromium journeys and one PostgreSQL-backed Chromium/worker-restart journey passed. Production build, typechecks and lint passed; final overview queue changes were additionally covered by PostgreSQL tests/typechecks/lint and actual browser inspection. Final mobile CSS was checked in Chromium after visual review exposed inherited horizontal-sidebar styles. Desktop and mobile screenshots were inspected; no horizontal overflow or browser errors remained. Configured read-only navigation verified HTTP 200 on all nine primary/record/status screens plus invoice detail. Source fingerprint: f534d950494bb10db1d3dc87d84e653cad46ef544bf931d95d7ea2fc04341e9a.

At final read-only verification the database contained two open invoices, one awaiting approval and one held, and zero payment intents. Actual Arc cash was 40.000000 testnet USDC. Doctor passed all checks after restarting the worker; dispatch remains enabled and the treasury resumed according to the owner's earlier opt-in. No approval, raw transfer, fixture seed or policy change was made in the configured database for these checks. The enabled worker continued ordinary evaluation; the verification scripts only signed in, read and signed out. Actual independent live settlement remains unverified, and the presence of labeled synthetic records is not business traction.


## 16 October — Invoice review redesign

Reference-inspired invoice detail implementation passed 250 regular tests, 54 disposable PostgreSQL tests, seven fixture browser journeys and one PostgreSQL-backed browser/worker-restart journey. Full typecheck, lint and production build passed after final timeline changes. Configured read-only desktop/mobile QA confirmed real source metadata and current verification, HTTP 200, no browser errors, no horizontal mobile overflow and working activity expansion. Landing hashes are unchanged. No configured financial record was modified and no payment was submitted by this verification. Source fingerprint: `0f7a44223f99cbdf4fef9c2c7bf1fcc18f2262eb8038f486c56d6cda8351d966`. See [layout semantics](INVOICE_REVIEW_REDESIGN.md). Real settlement acceptance remains unverified.


## 16 October — Action Center redesign

Implemented reference-inspired actual-data queues, filters, global server sorting, selected invoice preview and recorded review guidance. Verification passed: 250 regular tests, 55 disposable PostgreSQL tests, eight fixture browser journeys, one database-backed approval/export/restart journey, typecheck, lint and production build. Configured read-only desktop/mobile QA passed with actual counts, no error panels, no page errors and no mobile overflow. Initial configured report unavailability was recorded in HISTORY; subsequent connection/read/query/browser checks passed. All preserved landing hashes are unchanged. No configured financial record or payment was changed. Source fingerprint `529542d5702a1fce318b2c67ef177dcc4513f2ba4c16625a2bc80d48bb5da44f`. See [Action Center semantics](ACTION_CENTER.md).


## 16 October — Action Center payment card

Removed the Filter invoices form and added selected-invoice exact approval, rejection and re-evaluation using the existing authoritative services. Commands refresh detail before a frozen, reasoned confirmation; pending dialogs resist Close/Escape, and stale/locked/unavailable conditions retain safeguards. Eight fixture browser journeys and the expanded PostgreSQL-backed synthetic payment/restart journey passed, along with typecheck, lint and production build. Configured read-only desktop/mobile checks passed with the panel absent, actual terms displayed, cancelled dialogs, zero browser errors and no overflow. Landing hashes remain unchanged. No configured financial command was submitted. Source fingerprint `0a6101f4a4c9ce7b0db9e1ab8456cfe72ab7389b415c9584deb1c4620b66f3cb`.
