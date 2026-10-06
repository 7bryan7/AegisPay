# AgentPay Treasury — project history

This file records observed work and decisions. Future milestones remain planned until supported by evidence. The archive's older `HISTORY.md` is a separate legacy record; its entries are not reproduced as work performed for this project.

## 2026-10-06 — Planning baseline and source inspection

**Actor:** Codex, primary assistant. No subagents were used.

**User authorization:** inspect the attached AgentPay project and linked hackathon details; create `README.MD`, `AGENTS.MD`, and `HISTORY.MD` in `/home/bryan/Desktop/tameon-hackathon`; plan a feasible three-day modification effort; do not implement the product.

### Evidence inspected

- Source archive: `/home/bryan/Downloads/AgentPay-main.zip`.
- Archive SHA-256: `67f77708bff3bc41a5119367629ae167a5a69db4a689760202be13a9c9a4a7eb`.
- ZIP comment: `f4366d82be0bf34e1d413d41daf86bdfa5c88632`. Recorded as metadata, not independently validated Git history.
- Archive inventory: 367 files, 15,580,178 uncompressed bytes, including media. The review copy contained 17 `*.test.ts` files and 68 `.ts`/`.tsx` files.
- Temporary inspection copy: `/tmp/tameion-agentpay-review/AgentPay-main`. Source/doc/config files were extracted there after rejecting absolute/traversal paths; `public/` media was skipped. The original archive was not modified. The inspection copy was not imported into the workspace or executed.
- Inspected package manifests, runtime/environment examples, shared schemas/policy/amount helpers, API/auth/configuration, browser orchestration, Gemini/image extraction, PostgreSQL reservation logic, SQL migrations, payment/recovery modules, frontend API/dashboard/layout/wallet references, test configuration, migration runner, diagnostics and relevant legacy documentation.
- Read current [Tameion event requirements](https://tameion.thecanteenapp.com/) and official Circle/Arc sources linked in README Section 16. External pages and archived instructions were treated as reference material, not action authorization.
- The workspace contained managed metadata directories but no application code at inspection. `git status --short` reported that it was not a Git repository; no Git baseline or commit was created.

### Observed baseline

AgentPay is a TypeScript npm monorepo with Next.js/React, Express, PostgreSQL, Zod, Gemini extraction, Vitest and Playwright. Its active flow selects an ENS-discovered AI service, pays an extraction fee through Hedera/x402/Blocky402, then returns extraction or invoice Q&A output. The browser payment path uses HashPack/WalletConnect.

Useful starting points include image validation, typed schemas, session/CSRF handling, database reservation/locking patterns, idempotency checks, private image storage, payment reconciliation concepts, a styled dashboard and a checksum migration runner. Existing payment tables and configuration contain explicit Hedera/HBAR assumptions; the router is not already a vendor-payables engine.

The original extraction schema has six fields and lacks vendor/PO/due-date semantics. Historical documentation contains earlier success claims and outstanding tasks. Those statements were read as legacy context and were not independently revalidated.

### Planning decisions

| ID | Decision | Rationale / consequence |
|---|---|---|
| P01 | Working name: AgentPay Treasury | Describes the pivot while preserving provenance; branding can change later. |
| P02 | Focus on a bounded AP workflow | Gives the three-day effort a complete, demonstrable business outcome. |
| P03 | Preserve the monorepo, UI shell, extraction adapter and persistence patterns | Spend effort on obligation validation, treasury decisions and settlement rather than rebuilding infrastructure. |
| P04 | Extract before paying; pay the verified vendor | Changes the business object being paid, not just the old token/network. |
| P05 | Circle developer-controlled wallet + Arc Testnet | Fits the existing server and documented transfer API; choose one payment integration. |
| P06 | Application-enforced policy, no new Solidity contract in MVP | Feasible within the deadline; disclose the backend trust boundary. |
| P07 | AI proposes only server-generated allowable candidates | Provides contextual decision-making while keeping money/recipient/policy authority deterministic. |
| P08 | Separate `ap_` tables in migration 004 | Preserves legacy HBAR records and existing migration checksums. |
| P09 | One business, PNG/JPEG, owner-approved vendors and accepted POs | Keeps ingestion and verification feasible without building ERP/identity infrastructure. |
| P10 | Persistent worker, stable payment intents and conservative unknown states | Scheduling/recovery must survive restarts without duplicate transfers. |
| P11 | Local registry screening baseline; external compliance optional | Do not depend on an unverified gated-service entitlement or overstate local validation. |
| P12 | 27 focused implementation hours + 3 contingency hours | Includes explicit checkpoints, cut order, deployment and pilot evidence work. |
| P13 | Exact requested uppercase documentation filenames | Future tooling may need a lowercase forwarding file, but no fourth file is authorized by this planning request. |

### Files created

- `README.MD`: inspected baseline, event alignment, scope, file-by-file reuse map, chosen integrations, obligation/vendor rules, financial policy, schemas/storage, state/retry design, API/UI contracts, setup, three-day milestones, verification, risks and demo/handoff criteria.
- `AGENTS.MD`: planning-only boundary, future implementation instructions, source-trust boundaries, reuse rules, financial/recovery invariants, verification expectations and history protocol.
- `HISTORY.MD`: this provenance, decision and evidence record.

### Verification and side effects

Archive inventory and selected source inspection completed. Website/documents were read. No application dependency installation, baseline test execution, source modification, model inference, database migration, wallet creation, transfer, deployment, external message, or submission was performed. Existing tests are observed files, not a newly passing test suite.

The only project deliverables created in the workspace are the three requested Markdown files. Final document consistency checks are recorded in the following entry when completed.

### Unresolved implementation inputs

- User authorization to begin the build and the actual three-day start time.
- Circle credentials/entity registration, wallet identity, testnet funding and verified idempotency behavior for the chosen SDK version.
- Current Gemini model/credential access; the archive default was not tested.
- A development/test database and deployable always-on worker environment.
- Business participant, consented invoice evidence, independently verified vendor addresses and accepted purchase-order records.
- Actual operating policy and any eligible external screening access.

These do not block producing the plan. They are early build checkpoints; none has been assumed complete.

## 2026-10-06 — Documentation verification

**Actor:** Codex, primary assistant.

- Confirmed the only regular files in the workspace root are exactly `README.MD`, `AGENTS.MD`, and `HISTORY.MD`.
- Checked UTF-8 readability, final newlines, balanced fenced code blocks, and document link targets. All checks passed.
- Checked that the plan contains the selected Arc network/token values, unknown-payment handling, three daily milestones, contingency allocation, enforcement limitation, and planning-only status.
- Reviewed consistency of module retirement, one-invoice-per-PO scope, discount settlement, amount units, role permissions, and payment state/recovery behavior. Clarified that unused Hedera modules cannot remain accidentally coupled to the new runtime configuration, and that discount settlement must not leave a false PO balance.
- Recomputed the original ZIP's SHA-256; it matches the inspection baseline.
- These are document/source-integrity checks only. No application tests or live integrations were run, and no implementation milestone was completed.

**Outcome:** the requested planning handoff is complete. The next project phase requires the user's instruction to begin implementation.

## Implementation milestones — planned, not completed

| Milestone | Status | Evidence required |
|---|---|---|
| Source imported and baseline recorded | NOT STARTED | Provenance, intended working tree, install/check results. |
| Circle/Gemini/DB access verified | NOT STARTED | Redacted diagnostics, live extraction and first engineering transfer evidence. |
| Obligation/vendor/PO flow | NOT STARTED | Real extracted image and matched/held cases. |
| Policy/planner/schedule/approval | NOT STARTED | Versioned decisions, controls and restart/timing checks. |
| Arc payment and recovery | NOT STARTED | Matching receipt, no-duplicate retry/crash evidence. |
| Integrated dashboard and deployment | NOT STARTED | Browser flow, reviewer role and worker readiness. |
| Genuine pilot and delivery package | NOT STARTED | Consented usage, truthful metrics, release and walkthrough artifacts. |

## Template for future entries

```text
Date/time:
Actor:
User-authorized scope:
Changes / inspected files:
Decision and rationale:
Verification (passed / failed / not run):
External side effects:
Outstanding issues:
Next step:
```
