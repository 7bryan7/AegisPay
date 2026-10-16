# Full README implementation plan

Prepared 15 October 2026 from the README and current code. This is a plan, not a completion claim. The previous reduced-MVP cuts do not define the requested implementation scope.

## Scope and estimate

Implement all specified AP workflows and Section 10 API contracts, including the previously deferred discount path, policy/registry administration and invoice corrections. Preserve the README's deliberate exclusions: no PDF/email ingestion, AR collections, partial payments, FX, cross-chain transfers, ERP integration or custom custody contract. Optional Q&A and external compliance integrations are not mandatory AP acceptance criteria; local-registry screening remains explicitly labeled.

Estimated remaining engineering effort: **60–90 focused hours**, approximately **8–12 eight-hour working days**, including automated verification and contingency. This assumes one implementer, reuse of the existing stack and no new integration/provider architecture. It is not an elapsed-time or calendar-date guarantee.

Live acceptance is an additional **4–8 focused hours after credentials, wallet funding and owner evidence are available**, excluding account provisioning, service outages and waiting for access. Unexpected provider incompatibilities may require further implementation and re-estimation. A deployment/pilot/video requires real accounts, consented participation and review; those external outcomes cannot be guaranteed by code work.

## Ordered work and exit criteria

| Phase | Effort | Work | Exit evidence |
|---|---:|---|---|
| 1. Requirement matrix and shared contracts | 6–8 h | Map README requirements to code/tests; define correction provenance, version/conflict contracts, administration inputs, safe reconciliation results and expanded evidence DTOs. Design forward migrations after 005; preserve old migrations and existing payment identities. | Every mandatory requirement maps to an implementation and acceptance test; schema upgrade works from existing data. |
| 2. Invoice lifecycle and payment controls | 10–14 h | Implement PATCH correction, explicit re-evaluation, operator rejection and manual reconciliation. Preserve original extraction separately from owner corrections. Require versions/reasons; append history; invalidate only unsubmitted authorization. Add approval confirmation version/hash and pause rationale contracts while retaining server-derived authoritative terms. | Corrected invoices re-evaluate; stale edits/approvals conflict; rejection releases only unsubmitted holds; reconciliation cannot send; submitted/unknown payments remain protected during concurrent edits. |
| 3. Vendor, PO and policy administration | 8–12 h | Add business-scoped vendor reads/create/update, PO reads/create and versioned evidence updates needed by the workflow, and policy updates. Include approved/blocked state, verified addresses, aliases, acceptance evidence and audited reasons. Add owner controls in the existing dashboard. | Concurrent changes have one valid version; address/PO/policy changes invalidate unsubmitted decisions/approvals; no invoice text or reviewer can mutate trusted records; old settled terms stay intact. |
| 4. Complete obligation and decision behavior | 10–16 h | Carry service descriptions/periods, line items and payment terms from existing raw extraction into normalized evidence/review. Add similarity-based duplicate review. Implement owner-verified discount terms, expiry, integer opportunity-cost comparison and allowable planner candidates. Persist nominal amount, discount adjustment and actual payout distinctly. Add an essential-obligation flag with conservative defaults and configurable protection/cash-cost terms where required. | Similar invoices hold; a model cannot invent a discount; expired/unverified discounts cannot pay; caps apply to exact payout; discounted full settlement closes the obligation/PO without a fictitious residual; cash/terms changes alter decisions correctly. |
| 5. Treasury, invoice detail and audit completion | 8–12 h | Expose spendable cash, due obligations, category/day headroom, fees, snapshot age/block, decisions/alternatives/next evaluation, approval versions, timeline details and explorer links. Build correction/reject/reconcile controls and the four dashboard sections using the existing UI stack. Expand the private export with required redacted evidence. | UI values agree with trusted backend accounting; stale/unavailable data is explicit; monetary precision survives large values; export binds the invoice, decision, approval and verified payment; no secrets/private source blobs escape. |
| 6. Isolated reviewer experience | 4–6 h | Supply sanitized examples and reproducible isolated evaluations. Separate reviewer fixtures from all private treasury/worker/payment paths. Expose meaningful reasons/evidence without write/spend controls. | Reviewer can inspect the promised examples and outcomes; API/browser tests prove no access to operator records, corrections, registry/policy changes, approvals or live dispatch. |
| 7. Integration, hardening and handoff | 8–12 h | Run clean install/lint/types/build, new domain/API tests, real PostgreSQL concurrency/migration/recovery coverage and browser journeys. Test actual worker restart/wakeup using a controlled clock/provider boundary. Verify local configuration and deployment/proxy setup where testable without cloud credentials. Update README, testing guide and release-evidence structure. | Every mandatory offline acceptance row passes; unsafe/unknown/restart behavior cannot double-submit; full browser workflow works with durable storage and isolated providers; setup is reproducible and limitations are explicit. |
| Contingency | 6–10 h | Resolve cross-module regressions, provider-contract assumptions discoverable offline and migration/recovery edge cases. | No known blocking implementation/test defects remain; unresolved external items are separately recorded. |
| **Total** | **60–90 h** | **Implementation and automated verification** | **Ready for the user's configured acceptance testing, not yet proof of live settlement.** |

Tests accompany each phase; the final phase is an integrated regression, not the first time the new behavior is exercised. The user does not need to perform manual testing between phases.

## Financial invariants throughout

- Keep integer micro-USDC and exact immutable stored transfer terms/provider keys.
- Lock treasury before financial state changes; preserve one in-flight transfer per treasury.
- Never update a submitted transfer to match later registry/policy/invoice edits. Preserve historical evidence and reconcile unresolved outcomes.
- Mutations use expected versions and audited reasons. Changed unsubmitted terms cancel/release safely and enqueue a new evaluation; they never reuse an old approval.
- An expired lease is not proof of failure. No retry/resend for SUBMITTING, PENDING, UNKNOWN or SETTLED.
- A correction is evidence for re-verification, not permission to bypass PO, vendor, liquidity, hard limits or duplicates.
- Fixture/model output cannot choose arbitrary destinations, URLs, signing calls or authoritative policy.

## Integration gaps identified at planning time (now addressed offline)

The initial gaps were the narrow treasury/audit DTOs, omitted normalized service/line-item/payment-term context, and missing PO discount/essential terms. Those source implementations and their offline acceptance checks now exist; see the completed requirement matrix.

The final matrix must also verify required HTTP conflict/domain error codes, pagination/retention behavior, authenticated source-image delivery, pause audit reasons, approval confirmation terms and actual database-backed browser flows. Passing the current in-memory demo must not conceal missing persistence integration.

## Milestones and test handoff

1. **Backend lifecycle complete:** phases 1–3; administrative changes are versioned and safe against concurrent dispatch.
2. **Full product behavior complete:** phases 4–6; richer verification/discount/accounting, full dashboard and reviewer isolation exist.
3. **Implementation complete and offline verified:** phase 7 plus resolved contingency; all required code and automated checks pass. User testing begins here after .env, database and owner enrollment are configured.
4. **Live acceptance complete:** actual configured Gemini extraction and one bounded Circle/Arc payout, independently verified receipt, duplicate refusal and scheduling/recovery evidence. This milestone requires real external access and may expose fixes that mocks cannot establish.
5. **Release evidence complete:** exact build reference, versions, setup names without values, test results, sanitized audit exports, real provider/hash/explorer references, restart evidence and truthful limitations. Pilot consent/feedback and publication/video/submission are separate real-world deliverables, not inferred from code completion.

The completion report must distinguish milestones 3 and 4. The README's full completion gate cannot be marked passed merely because the code builds or fixture tests pass.

## 15 October implementation checkpoint

Phases 1–6 now have source implementations: versioned invoice review, exact approvals, registry/PO/policy administration, enriched invoice evidence, conservative similarity review, owner-verified exact discounts, essential flags, full-ledger treasury views, private audit projections and six isolated reviewer examples. The user selected exact discounted amount plus expiry; terms must explicitly settle the nominal invoice in full. Cash-preservation cost defaults to zero annual basis points and is disclosed.

Latest recorded domain/API regression: 246 tests; PostgreSQL: 46 tests. These are checkpoint results, not the final acceptance claim. Phase 7 now includes a new disposable-database browser harness and a separately restarted synthetic worker; final lint/types/build/browser regression and documentation checks remain in progress. Live extraction/settlement, deployment and genuine pilot/release evidence remain externally dependent and unverified.

## Final offline handoff — 15 October 2026

Phases 1–7 are implemented and offline verified: 247 regular tests, 47 PostgreSQL tests, 6 fixture browser journeys, 1 PostgreSQL-backed browser journey with a separate worker-process restart, lint, typechecks and production build passed. The durable browser test exports synthetic evidence and proves exact approval consumption, administration persistence, correction/re-evaluation, schedule persistence and no second intent across restart.

The app is ready for the user's configured local testing after `.env`, migrations through 008 and owner enrollment. This does not mark live acceptance or external release/pilot deliverables complete. Source fingerprints and explicit live acceptance fields are described in RELEASE_EVIDENCE.md. No real extraction or transfer was run.
