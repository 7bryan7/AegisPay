<p align="center">
  <img src="assets/agentpay-banner.svg" alt="AgentPay — ENSv2 identifies, AI selects, x402 requests payment, Blocky402 facilitates, Hedera settles" width="100%"/>
</p>

<p align="center">
  <b>Autonomous AI service router — discover services through ENSv2, choose within budget, and pay with HBAR.</b>
</p>

<p align="center">
  <a href="https://docs.ens.domains/ensv2/overview/"><img src="https://img.shields.io/badge/ENSv2-Identity%20%26%20Discovery-5577FF?style=flat-square" alt="ENSv2 — Identity and Discovery"/></a>
  <a href="https://hedera.com/"><img src="https://img.shields.io/badge/Hedera-HBAR%20Settlement-00C990?style=flat-square" alt="Hedera — HBAR Settlement"/></a>
  <a href="https://x402.org/"><img src="https://img.shields.io/badge/x402-Payment%20Gate-000000?style=flat-square" alt="x402 — Payment Gate"/></a>
  <a href="https://blocky402.com/"><img src="https://img.shields.io/badge/Blocky402-Verification%20%26%20Settlement-FF526B?style=flat-square" alt="Blocky402 — Verification and Settlement"/></a>
  <br/>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Next.js-000000?style=flat-square&amp;logo=nextdotjs&amp;logoColor=white" alt="Next.js"/>
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/ETHOnline%202026-8B00F5?style=flat-square" alt="ETHOnline 2026"/>
</p>

# 🤖 AgentPay (Old project version)

### Discover a service by its ENS identity. Choose within budget. Pay with HBAR. Get the result.

**ETHOnline 2026 · ENSv2 + Hedera · TypeScript · x402 · Blocky402**

AgentPay is an AI service router. Give the agent an invoice and a spending limit; it discovers registered extraction services, resolves their live ENS records, compares current offers, and pays the selected service on Hedera before receiving the result.

> 🌐 ENS identifies → 🧭 AgentPay selects → 💸 Blocky402 settles on Hedera → 📄 Service returns the result

**Implementation status: working Alpha + Beta flow, September 12, 2026.** The Node 22 npm workspace contains a replaceable minimal Next.js console, an Express API/provider process, shared strict schemas and policy, and versioned PostgreSQL migrations. Supabase migrations `001_initial.sql` and `002_browser_runs.sql` are applied. Alpha is enrolled as `alpha.ocr.agentpayapp.eth` and Beta as `beta.ocr.agentpayapp.eth`; both resolve live ENSv2 records on Sepolia and point to the deployed Gemini 3.6 Flash provider/API at [agentpay-api-sbwi.onrender.com](https://agentpay-api-sbwi.onrender.com). The operator CLI has independently recorded a real ENS → x402 → Blocky402 → Hedera Testnet → Gemini run with exact synthetic-fixture output. The owner has also reported a successful local HashPack mobile QR payment and extraction through the browser flow; that browser transaction was not independently inspected because no transaction reference was supplied.

The browser API now provides pre-payment readiness, durable private image retention, atomic budget reservation, session ownership, idempotency, wallet-signed execution, status, cancellation, Mirror Node reconciliation, and authenticated extraction recovery without a second payment. Reown supplies only the WalletConnect relay/project identity between the web app and HashPack mobile; HashPack keeps the key and approves the native Hedera transaction, while AgentPay validates terms and Blocky402 verifies and settles it. The frontend remains an intentionally plain integration harness whose backend hooks live in `apps/web/lib/agentpay.ts`. Frontend deployment, the ENS endpoint-only permission demonstration, the expired-input cleanup job, and the remaining failure/concurrency/restart evidence are still outstanding.

**Scope decision:** the prototype integrates ENSv2 identity/discovery with Hedera Testnet settlement. Cross-chain receipt contracts, on-chain reputation scoring, and additional marketplace infrastructure are outside the current build. Application history is stored in PostgreSQL.

---

## 📚 Contents

- [The problem and the MVP](#-the-problem-and-the-mvp)
- [Hackathon requirements and deadline](#-hackathon-requirements-and-deadline)
- [Scope and acceptance criteria](#-scope-and-acceptance-criteria)
- [Workflow and architecture](#-workflow-and-architecture)
- [ENSv2 integration](#-ensv2-integration)
- [Routing and agent behavior](#-routing-and-agent-behavior)
- [Hedera and x402 integration](#-hedera-and-x402-integration)
- [State, storage, and recovery](#-state-storage-and-recovery)
- [Recommended stack and layout](#-recommended-stack-and-layout)
- [API contract](#-api-contract)
- [Build timeline](#-build-timeline)
- [Setup and run instructions](#-setup-and-run-instructions)
- [Testing and troubleshooting](#-testing-and-troubleshooting)
- [Demo and submission](#-demo-and-submission)
- [Limitations and roadmap](#-limitations-and-roadmap)
- [References](#-references)

## 🧩 The problem and the MVP

An agent usually uses whichever API its developer configured. Adding another provider often means another account, credential, and billing integration. AgentPay explores a different interface: services publish resolvable identities, quote a price, and accept payment per call.

Our single MVP task is **invoice extraction from one PNG or JPEG image**. The service returns structured fields such as invoice number, currency, subtotal, tax, and total. Both demo providers must actually process the supplied image; a canned response is only permitted in clearly labeled offline tests.

Example user request:

> “Read this invoice and return its number and total. Spend no more than 0.05 HBAR.”

The agent chooses between two team-operated demo services. The services can use different extraction configurations or upstream models. We disclose that they are demo providers and do not claim that independent commercial providers have joined.

The user does not need an API key for the selected AgentPay service. The team may still use a paid model API behind that service and for the agent's task interpretation. Those upstream costs and credentials remain the team's responsibility.

## 🏆 Hackathon requirements and deadline

The event runs **September 4–16, 2026**, but the official submission deadline is **September 13, 2026 at 12:00 p.m. EDT / 16:00 UTC / 9:30 p.m. IST**. The event end date is not the build deadline. As of this document's date, prioritize the compressed plan below. Recheck the Hacker Dashboard and official announcements before submission.

| Selected track | Integration evidence to deliver |
|---|---|
| Hedera — AI & Agentic Payments | A live x402-gated service, a real paid request on Hedera testnet, Blocky402 settlement, setup/payment documentation, and a demo |
| ENS — Best Use of ENSv2 | ENSv2 on Sepolia with functional record resolution and meaningful use of v2 permissions or namespaces |

Use a public repository and a **2–4 minute narrated demo video**, which satisfies the event's stricter duration requirement. Select both sponsors in the submission form and explain their integrations separately. Keep incremental commit history, identify starter code, and disclose AI-assisted development. Classic/From Scratch eligibility depends on when project-specific work began; document existing work honestly rather than assuming eligibility.

Sources: [event](https://ethglobal.com/events/ethonline2026), [submission guide](https://ethglobal.com/events/ethonline2026/info/details), [Hedera track](https://ethglobal.com/events/ethonline2026/prizes/hedera), [ENS track](https://ethglobal.com/events/ethonline2026/prizes/ens).

## 🎯 Scope and acceptance criteria

### Must ship

- [x] One invoice-image task, one agent, two actual extraction services.
- [x] A persistent directory containing ENS names, with operator-controlled enrollment.
- [x] Live ENSv2 reads for capability, endpoint, payment network, and recipient.
- [ ] An ENSv2 demonstration in which an operator can update an endpoint but cannot change the recipient record.
- [x] Selection based on valid capability, current availability, current price, and a hard budget limit.
- [x] One HBAR payment path through Blocky402 on Hedera Testnet.
- [x] A result linked to its provider, routing explanation, and actual settlement transaction through the independently recorded CLI smoke path.
- [x] Durable request tracking, bounded retries, and duplicate-payment prevention.
- [ ] A deployed interface and service with documented setup and failure states.
- [ ] Retention: a general cleanup job removes expired invoice inputs and results after `RESULT_RETENTION_HOURS` while preserving unresolved payment, reservation, and accounting records.
- [ ] Privacy: verified redaction from logs and UI of credentials, database URLs, signed payment payloads, session credentials, model credentials, and invoice content.

### Explicitly deferred

Reputation scores, payment/event registries, custom settlement contracts, token launches, multi-agent negotiation, streaming payments, arbitrary wallet onboarding, workspaces, subscriptions, and a general-purpose chat platform.

The MVP needs **no custom Solidity contract**. It uses existing ENSv2 contracts through scripts and existing Hedera/x402 tooling. Add a custom contract only after an approved requirement demonstrates why it is necessary.

## 🔄 Workflow and architecture

### User journey

```mermaid
flowchart TD
    A[User supplies invoice and budget] --> B[Agent identifies invoice extraction]
    B --> C[Directory enumerates registered ENS names]
    C --> D[Resolve live ENSv2 records on Sepolia]
    D --> E[Fetch public offers and validate candidates]
    E --> F{Any eligible provider within budget?}
    F -->|No| G[Explain why no payment was made]
    F -->|Yes| H[Select provider deterministically]
    H --> I[Selected service returns HTTP 402]
    I --> J[Validate actual quote and reserve budget]
    J --> K[HashPack signs exact Hedera payload through Reown]
    K --> L[Blocky402 verifies and settles on Hedera]
    L --> M[Service extracts invoice fields]
    M --> N[Return result and settlement evidence]
    N --> O[Persist execution history in database]
```

### Components and responsibilities

```mermaid
flowchart LR
    UI[Next.js console] --> API[Express browser API]
    UI --> REOWN[Reown WalletConnect relay]
    REOWN <--> WALLET[HashPack mobile]
    API --> ROUTER[Readiness + deterministic policy]
    ROUTER --> DIR[PostgreSQL provider directory]
    ROUTER --> ENS[ENSv2 / Sepolia]
    WALLET --> UI
    UI --> API
    API --> SERVICE[x402-gated provider route]
    SERVICE --> FAC[Blocky402 facilitator]
    FAC --> HEDERA[Hedera Testnet]
    SERVICE --> MODEL[Actual extraction model]
    API --> DB[(PostgreSQL)]
    SERVICE --> DB
```

Sepolia is used for names and permissions. Hedera is used for payments. **No assets are bridged between them.** The backend connects the two through application logic.

| Source | What it is authoritative for |
|---|---|
| Application directory | Which provider names are enrolled in this prototype |
| ENSv2 records | The provider's currently published service configuration |
| Service's validated x402 requirements | The amount and terms of the specific payment request |
| Hedera settlement evidence | Whether the transfer succeeded |
| Database | Application observations, budget reservations, and result recovery |

## 🌐 ENSv2 integration

### Names, enumeration, and records

The current Sepolia namespace is:

```text
agentpayapp.eth
└── ocr.agentpayapp.eth
    ├── alpha.ocr.agentpayapp.eth  # enrolled and live
    └── beta.ocr.agentpayapp.eth   # enrolled and live
```

A subname uses dots, such as `alpha.ocr.agentpayapp.eth`; `/ocr/alpha` is a URL path, not an ENS hierarchy. `ENS_PARENT_NAME` is currently `agentpayapp.eth`.

ENS does not provide a global “find all OCR providers” query. The operator enrolls names through a CLI. The database lists those names; the router resolves their live records before use. It must not silently substitute endpoints or recipients from a hard-coded map when ENS is unavailable.

Implemented application-specific text-record schema:

| Text-record key | Example value | Meaning |
|---|---|---|
| `agentpay.schema` | `1` | Metadata schema version |
| `agentpay.capability` | `invoice-extraction,invoice-qa` | Comma-separated supported tasks |
| `agentpay.endpoint` | `https://provider.example/providers/alpha` | Base URL for offer and execution routes |
| `agentpay.payment.network` | `hedera:testnet` | Accepted payment network |
| `agentpay.payment.asset` | `0.0.0` | Native HBAR in the Hedera x402 scheme |
| `agentpay.payment.recipient` | `0.0.REPLACE_ME` | Existing service recipient account |
| `agentpay.active` | `true` | Provider-published availability flag |

These keys are **our convention**, not a claim of an ENS standard. Current price comes from the service offer and is checked again against the selected endpoint's 402 response. Do not put raw invoices or secrets in ENS records.

### Integration order

1. Choose an ENSv2-ready library version from the official readiness documentation. Record and pin the tested version.
2. Fund a dedicated Sepolia owner account; obtain the test registration token if required by the deployed registrar.
3. Register or configure the owned parent and two provider subnames using the current ENSv2 registration flow.
4. Resolve the active resolver for each name, set the records above, and read them back.
5. Give a separate operator only the permissions required to edit `agentpay.endpoint` on the chosen provider name. Keep recipient control with the owner.
6. Prove that the operator can change the endpoint, cannot change `agentpay.payment.recipient`, and loses its edit ability after revocation.
7. Enroll each normalized provider name in the application directory. Resolve the records dynamically during routing.

Do not assume a subname owner automatically has permission to edit a shared parent resolver. Avoid hard-coded resolver implementation addresses; look up the active resolver before writes. Use the supported library's resolution path, including CCIP-Read where applicable.

After an endpoint update, invalidate the application cache and show that the next request reaches the new allowed endpoint. The deployment's endpoint-origin allowlist remains an independent restriction: delegated record rights do not grant unrestricted backend network access.

References: [ENS app guide](https://docs.ens.domains/ensv2/tutorial-app-developers/), [Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/), [Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/).

## 🧭 Routing and agent behavior

The current router does not use an LLM to make payment decisions. Strict code recognizes two supported tasks — `invoice-extraction` (structured fields) and `invoice-qa` (one natural-language question about the invoice) — resolves enrolled providers, enforces eligibility and budget policy, and deterministically chooses the cheapest valid offer. Gemini is invoked only by the paid provider to extract structured invoice fields or answer a question about the invoice image. It never receives a private key, wallet session, payment signature, or unrestricted transfer tool.

The browser boundary exposes typed discovery, preview, run, execute, reconcile, and recovery calls through `apps/web/lib/agentpay.ts`. Preview is read-only. Execute accepts only the wallet signature for the server-issued payment intent and revalidates it before forwarding the request.

### Initial policy

1. Read names from the enrolled directory and resolve current ENS metadata.
2. Require supported schema, active state, exact capability, allowed endpoint origin, `hedera:testnet`, native HBAR, and a valid recipient.
3. Fetch bounded public offers; mark unavailable providers as unavailable, not unreliable.
4. Exclude offers above the remaining task budget or per-request cap.
5. Select the lowest eligible HBAR price. Break ties by normalized ENS name so results are reproducible.
6. Receive and validate the selected provider's actual 402 requirements. Re-resolve the critical ENS recipient/network records before signing. If records or terms differ from the accepted selection, return `QUOTE_CHANGED` without signing; refresh offers at most once and rerun selection.

Example explanation: “Alpha was available and quoted 0.01 HBAR, below your 0.05 HBAR limit. Beta quoted 0.02 HBAR.” These are illustrative prices, not live market facts.

There is no quality or historical reliability score in this MVP. Current availability is only a recent observation. The UI should display the evidence timestamp, quote, and exclusions rather than a fabricated reputation rating.

Use integer tinybars internally and decimal strings at API boundaries: **1 HBAR = 100,000,000 tinybars**. Example defaults to implement are 5,000,000 tinybars per request, 20,000,000 per task, and 100,000,000 per UTC day for the shared agent account. Operator policy is authoritative; a prompt or client request may only lower a limit.

## 💸 Hedera and x402 integration

### Payment flow

```mermaid
sequenceDiagram
    participant U as Browser console
    participant W as HashPack via Reown
    participant A as AgentPay API
    participant S as Extraction service
    participant B as Blocky402
    participant H as Hedera Testnet
    participant M as Extraction model
    U->>A: Create run with invoice, payer, and budget
    A->>S: Unsigned request with request ID
    S-->>A: HTTP 402 + payment requirements
    Note over A: Validate terms and reserve budget
    A-->>U: Exact payment intent
    U->>W: Request sign-only approval
    W-->>U: Signed native Hedera payload
    U->>A: Execute reserved run with payment signature
    A->>S: Forward same request with signed payment payload
    S->>B: Verify payload against requirements
    B-->>S: Verification result
    S->>B: Settle verified payment
    B->>H: Co-sign and submit transfer
    H-->>B: Settlement outcome
    B-->>S: Successful settlement + transaction reference
    S->>M: Extract invoice fields
    M-->>S: Structured result
    S-->>A: Result + settlement evidence
    A-->>U: Stored result, route trace, and settlement evidence
```

The facilitator submits the co-signed transfer. Do not perform a separate manual HBAR transfer and then invoke x402: that creates a second payment path.

For this MVP, require confirmed settlement before starting paid model work or granting the result. Inspect middleware behavior; a successful `/verify` response or a local signature is not settlement. If the SDK's default lifecycle differs, use its supported hooks to enforce the intended ordering and test it.

### Integration order

1. Create a dedicated Hedera Testnet ECDSA payer and service recipient accounts; fund the payer with faucet HBAR.
2. Configure the facilitator as `https://api.testnet.blocky402.com`.
3. Inspect `/supported` and require `exact`, x402 v2, and `hedera:testnet`. Read the advertised fee-payer information; never hard-code it from this document.
4. Register compatible versions of the official x402 core, Hedera, fetch, and Express packages.
5. Implement one service route that returns 402 before payment and one backend client that handles signing and retrying.
6. Validate terms before the payment wrapper can sign. Restrict the signer to the selected existing recipient and exact quoted amount.
7. Persist the attempted transaction identity before submission. Verify real settlement and return its transaction reference with the result.
8. Test one successful request before adding the second provider or polishing the UI.

Blocky402 documents HBAR as asset `0.0.0`, with amounts in tinybars. Follow the installed SDK for header names and response parsing: examples from different x402 generations are not interchangeable. Keep the actual payer distinct from the facilitator fee payer; a transaction ID or settlement field may identify the latter.

The linked Hedera starter is useful reference code, but its defaults may select a different testnet facilitator. Configure Blocky402 explicitly and document reused code and its license.

References: [Blocky402 testnet](https://blocky402.com/docs/testnet/), [live capabilities](https://api.testnet.blocky402.com/supported), [Hedera x402 specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md), [Hedera starter](https://github.com/hedera-dev/x402-inference-pay-per-request-poc).

## 🗄️ State, storage, and recovery

Track payment and service execution independently. A paid request can fail during extraction.

```mermaid
stateDiagram-v2
    [*] --> UNPAID
    UNPAID --> RESERVED: Terms validated and budget locked
    RESERVED --> SUBMITTING: Signed attempt persisted
    RESERVED --> FAILED: Cancelled before submission
    SUBMITTING --> SETTLED: Confirmed successful transfer
    SUBMITTING --> FAILED: Definitive failed transfer
    SUBMITTING --> UNKNOWN: Timeout or ambiguous response
    UNKNOWN --> SETTLED: Reconciliation confirms success
    UNKNOWN --> FAILED: Reconciliation proves no successful transfer
    SETTLED --> [*]
    FAILED --> [*]
```

`UNKNOWN` is not a failure and is not permission to pay again. Hold the budget reservation and reconcile the original transaction. An immediate “not found” response may reflect propagation delay and is not sufficient proof of failure.

Execution states: `NOT_STARTED`, `RUNNING`, `SUCCEEDED`, `FAILED`. Once settled, a same-request retry resumes or returns the stored execution result; it does not charge again. Use a database claim/lease so concurrent retries cannot both start extraction. Persist results before marking execution complete.

| Table | Minimum fields |
|---|---|
| `providers` | Normalized ENS name, enrollment status, creation time |
| `runs` | Run ID, session ID, task, capability, budget tinybars, input reference/hash, routing snapshot, timestamps |
| `requests` | Request ID, run ID, provider name, actual payer, input hash, quote snapshot, execution status, result/error, execution lease |
| `payments` | Request ID, attempt ID, amount/asset/network/recipient, payment status, transaction reference, timestamps |
| `budget_reservations` | Payer, run, request, reserved amount, reservation status, UTC accounting day |

Use PostgreSQL constraints and transactions, not an in-memory flag, for deduplication and budget accounting. Lock the payer budget row while checking settled spend plus outstanding reservations and creating a new reservation. Task and day limits must hold across sessions, workers, and concurrent requests. Carry unresolved reservations across UTC day boundaries when calculating available balance. Do not release uncertain reservations on an arbitrary timeout or reset.

Bind idempotency to the verified payer, provider, request ID, and canonical input hash. Reject the same ID with different input. Prevent one settlement transaction from unlocking another request. A request ID alone is not authorization to read an invoice or retrieve its result.

Keep fixture images only for the demo. Do not put invoice contents on-chain. Persist private inputs and results server-side with a short configured retention period; redact them from public traces. If durable execution recovery uses an uploaded image, that image must survive a server restart until the run expires.

## 🛠️ Recommended stack and layout

| Layer | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript, Node.js 22 project target, npm workspaces | Shared types and a small tooling surface; verify dependency engines during scaffolding |
| Web | Next.js 16, React 19, plain CSS | Minimal replaceable console with upload, route preview, QR pairing, payment trace, and result |
| Backend | Express on Node | Long-running orchestration and straightforward x402 middleware |
| Routing | Strict TypeScript policy and typed API boundaries | Deterministic eligibility, cheapest-offer selection, and payment controls |
| Extraction | Vercel AI SDK with Google provider, Gemini 3.6 Flash | Schema-validated structured invoice output after settlement |
| ENS | ENSv2-ready viem; ENSjs only if write helpers simplify setup | Resolution and narrowly scoped administration |
| Payment | `@x402/core`, `@x402/fetch`, `@x402/express`, `@x402/hedera` | Existing protocol implementation |
| Hedera | SDK version compatible with the chosen x402 packages | Account/transaction tooling; Agent Kit is optional, not mandatory |
| Browser wallet | Hedera WalletConnect, Reown relay, HashPack mobile | Non-custodial QR pairing and sign-only native Hedera approval |
| Persistence | PostgreSQL on Supabase; `pg` and SQL migrations | Durable requests, transactions, reservations, and recovery |
| Validation/tests | Zod, Vitest, Playwright | Boundary validation, policy tests, and one browser journey |
| Hosting | Next.js on Vercel; Node backend/providers on Render | Matches the team's initial plan; verify runtime limits and persistence |

No separate microservices are necessary initially. Host both provider routes in the same backend process, with separate provider configurations and recipients. Separate their directories in code so they can be deployed independently later. Use a durable database from the first real payment.

Current implemented layout:

```text
AgentPay/
├── README.md
├── AGENTS.md
├── package.json                  # root scripts + npm workspaces
├── package-lock.json
├── .env.example                  # placeholders only
├── apps/
│   ├── web/                      # Next.js console, port 3000
│   │   ├── app/                  # minimal page, layout, and CSS
│   │   └── lib/                  # replaceable API + HashPack/x402 adapters
│   └── server/                   # Express API + provider routes, port 4000
│       └── src/
│           ├── auth/
│           ├── browser/
│           ├── ens/
│           ├── extraction/
│           ├── http/
│           ├── payments/
│           ├── persistence/
│           ├── readiness/
│           ├── recovery/
│           ├── routing/
│           └── security/
├── packages/core/                # shared schemas and pure helpers
├── scripts/                      # doctor, ENS setup, enrollment, smoke tests
├── migrations/                   # versioned, non-destructive SQL migrations
├── fixtures/                     # synthetic invoices and expected extraction
├── tests/                        # unit, integration, browser
└── docs/                         # decisions, evidence, AI/reuse attribution
```

## 🔌 API contract

The implemented browser and provider routes use JSON errors shaped as `{ code, message, requestId, retryable }`, without secrets or private stack traces. See `docs/browser-integration.md` for the replacement-UI contract.

| Route | Purpose | Spending behavior |
|---|---|---|
| `GET /health` | Process liveness; no secrets | None |
| `POST /api/session` | Validate the demo access code and issue a signed, short-lived HttpOnly session | None |
| `GET /api/session` | Restore session and CSRF state | None |
| `DELETE /api/session` | Close the current session | None |
| `GET /api/services` | Directory entries plus validated live ENS metadata | None |
| `POST /api/route` | Preview eligible candidates and selection | None |
| `POST /api/runs` | Persist the image and atomically reserve budget with `Idempotency-Key` | None; creates an unsigned payment intent only |
| `GET /api/runs/:id` | Session-scoped status, trace, and result | None; never restarts payment |
| `POST /api/runs/:id/execute` | Validate and forward one wallet-signed x402 payload | May settle the one reserved payment |
| `POST /api/runs/:id/cancel` | Release an unsigned reservation | None |
| `POST /api/runs/:id/reconcile` | Check an ambiguous original transaction on Hedera Mirror Node | None; never signs or resubmits |
| `POST /api/runs/:id/recover` | Retry extraction for an authenticated settled run with no result | None; one model call, never a new payment |
| `GET /providers/:id/offer` | Public capability, current price, network, asset, recipient | None |
| `POST /providers/:id/extract` | x402-gated raw PNG/JPEG extraction returning the validated invoice schema | Requires a valid payment for a new request; request `Content-Type` must match the actual image |

Implement upload handling inside the run API: accept one PNG/JPEG, validate actual file type and dimensions, cap encoded/decoded size, and compute a canonical hash. Do not accept arbitrary remote image URLs in the MVP. Offer requests do not receive the invoice; only the selected execution service receives it.

Run creation uses multipart fields `task`, `maxSpendTinybars`, `payerAccountId`, and `invoice`. The backend generates the run/request IDs. The session-scoped idempotency key maps retries to the existing run; reuse with changed content returns `409`.

The run recovery route uses the signed HttpOnly session that created the run as its narrowly scoped recovery credential, requires CSRF and exact browser origin checks, verifies the same session owns the run, and accepts only a settled payment with a consumed reservation and missing result. It must not grant access from a public transaction ID alone.

For the hosted demo, gate run creation and execution with a server-validated demo access code and a short-lived session. The browser payer remains the user's HashPack account; neither the demo code nor Reown grants custody or pays on the user's behalf. The dedicated server-funded payer is limited to the operator CLI smoke path and is never exposed to the browser. Enforce rate limits, exact browser origins, session ownership, and global spend limits. Public x402 provider calls still require their own payment and must have bounded inference cost. This is demo access control, not general account onboarding.

## 🗓️ Build timeline

### Delivery plan: September 9–13, 2026

The foundation, Alpha ENS/provider path, real CLI settlement, browser API, and local HashPack flow are complete. The remaining critical path is frontend deployment and deployed validation, then Beta enrollment, ENS permission evidence, and the failure/concurrency checks. All times below are IST; the final deadline remains the official one above.

| Date | Concrete work | Exit gate |
|---|---|---|
| Sep 9 — foundations | Scaffold workspaces and env validation; connect PostgreSQL; create test accounts; establish ENS and Blocky402 integration boundaries | Completed |
| Sep 10–11 — first complete flow | Build the Alpha extraction route, deterministic routing, durable payment/request state, recovery, Render deployment, and browser signing path | Completed for the CLI; local browser completion is owner-reported |
| Sep 12 — verification and delivery | Deploy the minimal frontend; align Vercel, Reown, and Render origins; run deployed checks; prove ENS permissions and key failure states; build the expired-input cleanup job; record retention/privacy evidence; record the demo | Beta enrolled and verified; invoice-QA capability implemented and tested; frontend deploy + remaining evidence pending |
| Sep 13 — buffer | Fix submission blockers only; verify video/repository/live URL and sponsor selections | Submit well before 9:30 p.m. IST; retain confirmation |

The published schedule lists check-in #2 at **Sep 11, 9:29 a.m. IST**. Confirm it in the dashboard. [Event schedule](https://ethglobal.com/events/ethonline2026#schedule)

### Seven-day plan: only if a full seven-day build window is confirmed

This plan is not evidence of a deadline extension. If beginning Sep 9, its final two days are after the currently published submission deadline and belong to post-submission work.

| Day | Work | Acceptance test |
|---|---|---|
| 1 | Scaffold, database, test accounts, ENS and payment integration proofs | Real 402 → settlement → response; actual ENS record read |
| 2 | One real extraction service and agent tool execution | Invoice result produced through the paid route |
| 3 | Second provider, directory, current-offer selection, ENS delegation | Budget filters work; record update changes endpoint |
| 4 | Durable state, idempotency, payer recovery, and concurrency | Duplicate calls cannot cause two transfers or two executions |
| 5 | UI trace, deployment, origin controls, timeout/error handling | End-to-end deployed test plus budget-exceeded and provider-down demos |
| 6 | Regression tests, fresh setup, docs, attribution, rehearsal | Another teammate follows setup successfully |
| 7 | Record, submit, and retain a buffer | Correct public artifacts and both track explanations |

### Time-boxed decisions

- If payment is not working by the first day's end, stop adding features and resolve the signer/facilitator path with sponsor support. Do not substitute a fake payment or another facilitator silently.
- If ENS resolution works but delegation fails, inspect resolver permissions and library compatibility before inventing a custom naming contract.
- If inference hosting is difficult, use one accessible upstream vision API behind the real paid service and disclose the wrapper. Do not spend the deadline training or hosting a new model.
- Cut animations, filters, and extra pages before cutting payment recovery, budget enforcement, or live ENS integration.

## 🚀 Setup and run instructions

> **Day 1 scaffold available:** the commands below now exist. Read-only and offline commands can be run after `npm ci`; live commands still require non-placeholder configuration and the explicit authorization described below.

### 1. Prerequisites

- Node.js 22 and npm, with dependency engine compatibility verified during setup.
- An owned ENSv2 Sepolia namespace, Sepolia ETH, and any required test registrar token.
- One dedicated Hedera Testnet payer and existing recipient accounts, funded with test HBAR.
- A PostgreSQL database and an accessible extraction-model endpoint.
- A Gemini Developer API key for the schema-validated extraction adapter.
- Read access to Blocky402's testnet facilitator and to the Sepolia RPC.

### 2. Install after scaffolding

From the repository root:

```bash
node --version
npm --version
npm ci
test -e .env || cp .env.example .env
```

The scaffolding step must create `package.json`, `.env.example`, and the lockfile first. Use `npm install` once when creating the initial lockfile; subsequent clean installs use `npm ci`. Never overwrite an existing `.env` when repeating setup.

### 3. Configure environment

Proposed root `.env.example` contents; placeholders must be replaced locally:

```dotenv
NODE_ENV=development
PORT=4000
WEB_ORIGIN=http://localhost:3000
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/agentpay

# Identity: read-only application configuration
ENS_RPC_URL=https://YOUR_SEPOLIA_RPC
ENS_CHAIN_ID=11155111
ENS_PARENT_NAME=YOUR_OWNED_PARENT.eth

# Payment: server-only dedicated testnet payer for operator CLI smoke tests
HEDERA_NETWORK=hedera:testnet
HEDERA_AGENT_ACCOUNT_ID=0.0.REPLACE_ME
HEDERA_AGENT_PRIVATE_KEY=REPLACE_WITH_TESTNET_ECDSA_KEY
BLOCKY402_FACILITATOR_URL=https://api.testnet.blocky402.com
PAYMENT_ASSET=0.0.0

# Providers hosted by this backend
ALPHA_RECIPIENT_ACCOUNT_ID=0.0.REPLACE_ME
BETA_RECIPIENT_ACCOUNT_ID=0.0.REPLACE_ME
ALPHA_PRICE_TINYBARS=1000000
BETA_PRICE_TINYBARS=2000000
PROVIDER_ALLOWED_ORIGINS=http://localhost:4000

# Gemini Developer API extraction adapter; keep the AI Studio key server-side
EXTRACTION_MODEL_BASE_URL=https://generativelanguage.googleapis.com/v1beta
EXTRACTION_MODEL_API_KEY=REPLACE_WITH_GEMINI_API_KEY
EXTRACTION_MODEL_ID=gemini-3.6-flash

# Server policy; client requests cannot raise these caps
MAX_SPEND_PER_REQUEST_TINYBARS=5000000
MAX_SPEND_PER_TASK_TINYBARS=20000000
MAX_SPEND_PER_DAY_TINYBARS=100000000
MAX_INPUT_BYTES=5000000
MAX_INPUT_PIXELS=20000000
RESULT_RETENTION_HOURS=24
DEMO_ACCESS_CODE=REPLACE_WITH_RANDOM_DEMO_CODE
SESSION_SECRET=REPLACE_WITH_RANDOM_SECRET
```

The backend and scripts use one explicit loader for the root `.env`. The web app receives only `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, set in the ignored `apps/web/.env.local` for local use or the frontend host's build environment for deployment. Reown identifies the dapp and transports the WalletConnect pairing/session messages between the browser and HashPack; it does not hold keys, approve transactions, choose recipients or amounts, or settle payments. Its project ID is public configuration, not a wallet secret. **Never copy backend secrets into `NEXT_PUBLIC_*`.** Pass backend secrets directly through the hosting platform in production.

ENS owner/operator signing keys belong in a separate local, ignored setup environment loaded only by ENS administration scripts. They must never be required by the running web app or backend. Provider receivers do not need private keys merely to receive native HBAR. Validate identifiers and reject placeholder values at startup.

Copy `.env.ens-setup.example` to the ignored `.env.ens-setup` only when preparing an authorized Sepolia record update. It inherits `ENS_RPC_URL` and `ENS_CHAIN_ID` from `.env`; keep the signer and other write-only values in `.env.ens-setup`. The Day 1 setup command updates records on an already registered name through its currently active resolver; it deliberately does not assume ownership, deploy a resolver, or register a name automatically.

Localhost origins are allowed only in explicit development mode. The hosted service must use HTTPS and explicit origin allowlists. Configure database TLS according to the provider; do not disable certificate verification to make a connection work.

### 4. Required script interface

These are project scripts to implement, not commands supplied automatically by the listed libraries.

| Command | Contract | Side effects |
|---|---|---|
| `npm run doctor` | Validate env presence without printing values; check DB, RPC, facilitator capabilities, and model readiness | Read-only requests; no paid inference |
| `npm run db:migrate` | Apply versioned SQL migrations | Database schema changes |
| `npm run ens:setup -- --dry-run` | Print a redacted testnet registration/record/delegation plan | Read-only |
| `npm run ens:setup -- --apply` | Execute the reviewed ENSv2 testnet setup | Sepolia transactions |
| `npm run ens:verify` | Resolve configured names and check records | Read-only |
| `npm run directory:add -- --name alpha.ocr.YOUR_PARENT.eth` | Validate ENS metadata and enroll one name | Database insert/update |
| `npm run dev` | Start web on 3000 and server on 4000 | Local processes |
| `npm run lint` | Run ESLint directly | Read-only |
| `npm run typecheck` | Type-check all workspaces | No external writes |
| `npm test` | Run offline unit/integration tests | Isolated test data only |
| `npm run test:e2e` | Browser test using explicit fixtures/mocks | Isolated test data only |
| `npm run smoke:testnet -- --dry-run` | Check live ENS and unsigned 402 requirements | No payment |
| `npm run smoke:testnet -- --pay` | Execute one capped real testnet invoice request | Testnet HBAR transfer; possible upstream model cost |
| `npm run recover:paid-extraction -- --dry-run --request-id <id>` | Validate a failed synthetic smoke request already backed by one settled payment | Database reads only |
| `npm run recover:paid-extraction -- --apply --request-id <id>` | Lease and retry only the extraction for that settled synthetic request | Database writes; one model inference; no payment |
| `npm run build` | Build shared package, server, and web | Local build output |
| `npm run start` | Start built web/server processes | Runtime requests may spend only through authorized flow |

The `--apply` and `--pay` modes must be deliberate opt-ins, print their target network and non-secret account IDs, enforce configured caps, and reject mainnet. Do not run them against unspecified accounts.

### 5. Start and verify after implementation

```bash
npm run doctor
npm run db:migrate
npm run ens:setup -- --dry-run
```

After reviewing the setup plan and authorizing the named testnet changes:

```bash
npm run ens:setup -- --apply
npm run ens:verify
```

Enroll both actual provider names using `directory:add`, then:

```bash
npm run dev
```

Open [the local console](http://localhost:3000). Check [backend health](http://localhost:4000/health), unlock the demo session, choose the supplied synthetic invoice, enter a budget, and run the task. A separate terminal can run:

```bash
npm run smoke:testnet -- --dry-run
```

Before using the HashPack button, create `apps/web/.env.local` with `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000` and a Reown project ID in `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, then restart the development process. The console exposes one wallet option: scan its QR with HashPack mobile using a funded Hedera Testnet payer account. QR pairing and route preview are read-only; the final signing action can spend the displayed Testnet HBAR amount.

Run `npm run smoke:testnet -- --pay` only when the configured testnet payer, cap, recipients, and upstream model costs are approved. The smoke test must report the actual settlement transaction and validate the returned extraction schema.

If a synthetic smoke request settles but extraction fails, do not run the paid command again. First run the recovery command in `--dry-run` mode with the exact request ID. Its `--apply` mode requires separate authorization for one model inference, acquires a database execution lease, and can complete only a request whose original payment is still `SETTLED` with a `CONSUMED` reservation. It never creates or submits a payment.

Both smoke modes use the same pre-payment readiness gate. For each ENS candidate, the gate retries its public offer for up to 90 seconds with bounded per-attempt timeouts, then re-resolves ENS and fetches a fresh offer. After selection it sends an unsigned request and requires exact x402 network, asset, amount, recipient, and flow terms. Paid mode can create a run or reserve budget only after that gate passes, and aborts if the validated offer/402 snapshot becomes stale before reservation. Wake-up retries are read-only and never carry a payment payload.

### 6. Deploy

Build and test first. The root `render.yaml` defines the backend as a native Node 22 web service in Render's Singapore region, the closest available Render region to the configured Supabase Seoul (`ap-northeast-2`) project. Its build explicitly includes development dependencies because TypeScript and the server declaration packages are build-time tools even though the runtime uses `NODE_ENV=production`. It builds only the shared core and server workspaces, starts `@agentpay/server`, and checks `/health`. It deliberately disables automatic deploys and selects Render's free plan so importing the Blueprint cannot opt into a paid compute plan; choose an always-on plan explicitly if required for judging.

In Render, create a Blueprint from this repository. Supply every value marked `sync: false` during the initial Blueprint creation; Render does not prompt for newly added `sync: false` values on later syncs. Copy values from the private runtime `.env`, never from `.env.ens-setup`, and do not commit them. Use the eventual Vercel HTTPS origin for `WEB_ORIGIN`. For the first backend boot, set `PROVIDER_ALLOWED_ORIGINS` to an explicit temporary HTTPS origin; as soon as Render assigns the service URL, replace it with that exact origin and redeploy before publishing ENS endpoint records. Render supplies `PORT`, and the Blueprint generates a separate production `SESSION_SECRET`.

The three `EXTRACTION_MODEL_*` variables are required by the implemented extraction and recovery paths; there is no separate runtime agent-model adapter. Continue using the existing Supabase `DATABASE_URL`; the Blueprint does not create or replace the database. On the web host, configure `NEXT_PUBLIC_API_BASE_URL` with the Vercel HTTPS origin itself and `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` with the Reown project ID, and add `apps/web/vercel.json` with a rewrite that proxies `/api/:path*` to the deployed Render HTTPS origin. The browser then talks only to the Vercel origin, so the session cookie stays first-party and works in browsers that block third-party cookies (Safari, Firefox strict mode, Chrome with blocking enabled); the backend still receives the same `Origin` header and validates it against `WEB_ORIGIN`. Add that exact web origin to the Reown project allowlist and set the backend's `WEB_ORIGIN` to the same value; `PROVIDER_ALLOWED_ORIGINS` remains the Render service origin because provider endpoints are called server-side. Update ENS endpoint records only after the backend URL and allowlist agree, then rerun the deployed smoke test. Ensure the backend stays available during asynchronous judging and that redeploys preserve request/payment state.

Do not rely on a developer laptop's local model for the final live service unless its availability is deliberately arranged and documented. Keep a recording of a genuine successful run as evidence; it does not replace the live-service requirement.

## 🧪 Testing and troubleshooting

### Required tests

- Routing excludes wrong capability, invalid ENS records, disallowed origins, wrong network/asset, and unaffordable quotes.
- A changed quote or recipient cannot pass through an automatically signing fetch wrapper unchecked.
- Over-budget requests and concurrent requests cannot exceed task or shared-payer limits.
- A 402 request alone performs no extraction and creates no payment.
- `/verify` success without settlement cannot unlock the result.
- Repeating an idempotency key returns the same run; changed input returns `409`.
- One transaction cannot unlock two requests; concurrent retries cannot both execute the model.
- Lost settlement responses produce `UNKNOWN`, preserve reservations, and reconcile before any further spend.
- A process restart preserves paid requests and permits authorized result recovery.
- ENS operator endpoint edits succeed; recipient edits and revoked permissions fail.
- A real synthetic invoice produces schema-valid fields and a real Hedera transaction reference.

### Troubleshooting map

| Symptom | Check first | Correct response |
|---|---|---|
| ENS resolves to nothing | Sepolia chain, normalized name, v2-ready client, actual record presence | Fix resolution; report unavailable instead of substituting hard-coded data |
| ENS record edit reverts | Active resolver and name/key-specific roles | Verify permission scope; ownership alone may not grant shared-resolver write rights |
| ENS change is not reflected | Transaction finality, current resolver, cache | Refresh the active resolver and invalidate cached metadata |
| Facilitator rejects payment | `/supported`, SDK version, fee payer, signature type, amount units, recipient | Compare the redacted request against current scheme docs |
| Repeated 402 responses | Header/version mismatch, expired quote, invalid payload | Stop bounded retry loop and expose a structured error |
| Quote differs from offer | Provider configuration or update during selection | Do not sign; refresh and reselect within the existing budget |
| Settlement status is unclear | Original transaction identity and network evidence | Keep `UNKNOWN`; reconcile the same attempt |
| Paid request has no result | Execution status and provider recovery record | Resume/retrieve the same paid request; do not charge again |
| Duplicate charges | Database uniqueness, signer entry point, payment-wrapper retries | Stop paid testing and fix deduplication before continuing |
| Local app works, deployment fails | Secrets by process, allowed origins, RPC/CCIP-Read access, DB TLS, service sleep/timeouts | Reproduce against deployed URLs and fix the failing boundary |

Do not log private keys, signed payment payloads, full invoice images, or database credentials. Useful logs include run/request IDs, stage, duration, network, redacted error code, and settlement reference.

## 🎥 Demo and submission

Aim for approximately three minutes:

| Time | Show |
|---|---|
| 0:00–0:20 | Explain the task and show a synthetic invoice plus budget |
| 0:20–0:55 | Two real ENS provider names, resolved records, live offers, and selection reason |
| 0:55–1:40 | 402 challenge, signing, Blocky402 settlement, and returned invoice fields |
| 1:40–2:10 | Actual transaction link and a same-request recovery without a second charge |
| 2:10–2:45 | Operator changes an allowed endpoint record; recipient edit is rejected; next resolution uses the change |
| 2:45–3:00 | State the two sponsor roles and current prototype limitations |

If the permission demo needs more time, use up to four minutes. Use real narration and comply with the event's video requirements. Do not show real credentials or personal invoices on screen.

Before submission, fill in a verified deployment record in this repository containing the public app URL, service URL, actual Sepolia names, resolver/registry references, Hedera testnet transaction, tested dependency versions, demo link, and source commit. Do not invent these identifiers while the implementation is incomplete.

- [ ] Fresh-install instructions match actual scripts and environment names.
- [ ] Both provider paths work on the deployed backend.
- [ ] ENSv2-specific behavior and Blocky402 settlement are visible.
- [ ] Public repository has a suitable license, incremental history, reuse attribution, and AI-use disclosure.
- [ ] Only confirmed features are described as implemented.
- [ ] Correct sponsor selections, public video, live URLs, and submission confirmation are retained.

## ⚠️ Limitations and roadmap

This is a controlled testnet prototype with a centrally enrolled directory. Its browser flow uses a user-controlled Hedera Testnet account in HashPack; a separate dedicated server-side payer exists only for operator CLI smoke tests. Reown relays the QR wallet session and never has custody. This is not a permissionless market or production wallet product. An ENS identity proves control of records, not service honesty or model quality. A successful transfer proves payment, not correct extraction.

The database is application-owned history, not decentralized reputation. Payments and model execution are not an atomic operation: a provider can fail after settlement. The MVP supports recovery and explicit failure reporting; automatic refunds and dispute resolution are future work. Never display “refunded” without a confirmed refund transfer.

Post-hackathon priorities are better outcome measurements, independent provider onboarding, refund policies, production-grade wallet/session hardening, and additional capabilities.

## 🔗 References

- [ETHOnline 2026 overview and schedule](https://ethglobal.com/events/ethonline2026)
- [ETHOnline submission requirements](https://ethglobal.com/events/ethonline2026/info/details)
- [Hedera prize requirements](https://ethglobal.com/events/ethonline2026/prizes/hedera)
- [ENS prize requirements](https://ethglobal.com/events/ethonline2026/prizes/ens)
- [ENSv2 overview](https://docs.ens.domains/ensv2/overview/)
- [ENSv2 app integration](https://docs.ens.domains/ensv2/tutorial-app-developers/)
- [ENSv2 contract/setup guide](https://docs.ens.domains/ensv2/tutorial-contract-developers/)
- [Blocky402 testnet guide](https://blocky402.com/docs/testnet/)
- [Blocky402 networks and assets](https://blocky402.com/docs/networks/)
- [Hedera exact-payment specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)
- [Hedera inference starter](https://github.com/hedera-dev/x402-inference-pay-per-request-poc)
- [Hedera documentation](https://docs.hedera.com/)
- [HashScan Testnet](https://hashscan.io/testnet)

Planning source: the team's original README and hackathon-info PDF, revised to reflect the decision to ship ENS + Hedera only. Official requirements above were checked on September 9, 2026; reconfirm any subsequent changes in the event dashboard.
