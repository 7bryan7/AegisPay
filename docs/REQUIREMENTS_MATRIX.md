# README implementation and acceptance matrix

This tracks the full scope authorized on 15 October 2026. Existing test results
are a baseline; a requirement is complete only when its actual implementation
and meaningful tests exist. Live acceptance is never inferred from fixtures.

| Requirement | Implementation | Verification / remaining work |
|---|---|---|
| Integer money, byte-validated images, business ownership and private storage | Core schemas, ingestion, migrations 001–005, AP session boundary | Existing core/API/PostgreSQL coverage; preserve during changes |
| Vendor/PO/acceptance matching and settlement convention | Core verification and extraction worker | Normalized service/period/payment terms and source line items are retained; service period and line-item arithmetic tests added |
| Due-date decisions, budgets, protected obligations and bounded planner | Treasury accounting/planning and worker | Owner essential flags, exact verified discounts/cash-cost comparison, complete treasury views implemented; expiry/candidate/accounting tests added |
| Exact reservations, immutable provider identity, unknown-state holds and atomic receipt settlement | Payment authorization, reserve/dispatch/reconcile services | Existing database and SDK/receipt tests; configured live acceptance remains required |
| Versioned correction with independent owner evidence | invoice-review contracts, migration 006, obligations/review and worker integration | Core provenance/API permission tests; PostgreSQL correction/retry/lease/reservation tests added |
| Explicit evaluate/re-extract and reject | POST invoice evaluate/reject, versioned command/revision history | Database idempotency, stale-write, missing-input and submitted-payment guards tested; operator UI integrated |
| Manual reconciliation without submission | Targeted reconcile service and operator endpoint | Existing-intent/business targeting, missing provider setup and retained-hold cases tested; reconciliation has no submission path |
| Approval confirmation versions/hash and pause rationale | Exact stored approvals already enforced; pause reason contract added | Exact offer includes server terms/hash/version; browser confirms payout/recipient; stale confirmations and pause reasons tested |
| Vendor read/create/update | Administration contracts/service and AP routes | Forward registry audit migration 007; database/API permission and version tests pass; owner UI integrated |
| PO read/create and versioned evidence updates | Administration contracts/service and AP routes | Consumed/submitted POs protected; versioned evidence, essential/service/discount fields and owner UI implemented |
| Policy read/update and authorization invalidation | Administration service/routes under treasury lock | Treasury-lock race/invalidation tests pass; owner UI integrated |
| Invoice detail with source, corrections, alternatives, next evaluation and validation evidence | Expanded typed private detail and owner controls | Source/correction provenance, service/line items, alternatives, versions, next evaluation, snapshot and discount evidence shown |
| Treasury spendable cash, obligations, category/day headroom and snapshot evidence | Shared full-ledger accounting with a treasury-wide projection | Spendable/headroom/snapshot/commitments shown; unknown cash inclusion makes liquidity unavailable; database/core tests pass |
| Audit export, complete timeline and verified explorer links | Typed private versioned decision/approval/correction/evidence export | Allowlisted facts, decisions, approvals, correction history and payment evidence; verified explorer links only for settled live mode |
| Similar invoice review and verified early-payment discounts | Implemented with owner terms and conservative similarity review | Nominal/discount/payout remain distinct through authorization, budgets and full PO settlement; database/core tests pass |
| Sanitized reviewer examples and isolated evaluations | Six fixed-clock synthetic policy examples; private inbox remains isolated | Dedicated examples/evaluation routes never access private storage/providers; injection/CSRF/API isolation tests pass |
| Full browser acceptance with durable storage | Existing synthetic browser suite plus new disposable PostgreSQL/worker journey | All 6 fixture journeys and the real PostgreSQL/API/worker browser journey passed |
| Scheduling/restart/uncertain-outcome acceptance | Database leases and recovery tests exist | Scheduling/restart browser proof plus due/expiry clock tests and database unknown/recovery/concurrency tests passed |
| Reproducible local/deployment setup | Demo, disposable DB runner, AP/worker deployment template | Migrations through 008, clean installation, production build and local harnesses verified; setup/evidence docs complete; no cloud deployment claimed |
| Real extraction and bounded Circle/Arc settlement | Adapters exist; credentials/live acceptance deferred | Requires configured external access, verified owner evidence and explicit testnet operation |
| Release/pilot evidence | Templates/history and synthetic evidence exist | Offline source fingerprint and synthetic audit attachment prepared; real transaction/pilot/video/publication evidence remains external |

Explicit exclusions and optional integrations remain as stated in the README and
implementation plan. This matrix does not promote Q&A, external compliance,
PDF/email ingestion, ERP integration or custom custody to required AP features.
