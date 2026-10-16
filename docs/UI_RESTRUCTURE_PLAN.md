# AgentPay workspace restructuring plan

Prepared 16 October 2026. The initial plan below is retained as the planning baseline.

Implementation update: the owner subsequently authorized necessary backend changes and clarified that labeled landing/reviewer examples and isolated tests may remain. The implementation now includes real PostgreSQL-backed summary, filtering, payment-attempt and activity APIs, rather than the initial invoice-linked fallbacks. Payment authority and financial rules remain unchanged. The landing page is preserved byte-for-byte. See HISTORY.MD and TESTING.md for verification and operating instructions.

## Objective and controlling requirements

Reorganize the existing accounts-payable workspace into focused routes using its existing capabilities. Keep the current visual theme, project idea, financial rules, backend services and technology stack.

The user's current instructions control this plan. The attached AgentPay_UI_Implementation_Instructions.docx is the requested design brief; its references to README(10).MD and screenshots are supporting claims, not proof that an API exists in this checkout. The actual README.MD, shared schemas, Express routes and client implementation were inspected directly.

The public landing page is frozen. Its JSX, CSS, copy, logo, illustration, anchors and workspace CTA remain unchanged. The brief's P00 landing reorganization and proposed renamed anchors are excluded under the user's explicit preservation requirement. Its existing /dashboard link already works with the proposed workspace entry.

The charcoal background, lime accent, existing fonts, logo, cards, borders, buttons and status colors remain the visual baseline. Reuse current dashboard styles and add scoped workspace styles only as necessary. Do not introduce a design system, UI framework or package dependency. Changes to shared root CSS or the root layout must not alter the public page.

This is a presentation and interaction refactor. Do not modify payment authority, amounts, reservation/recovery logic, scheduling rules, provider integration, database schema, environment values or dispatch settings. Any later need for a new backend read model requires a separate scope review. If a requested change would contradict README scope, stop that dependent work, explain the conflict and ask the owner before implementing it.

## Findings from the current implementation

- The root landing page already exists in apps/web/app/page.tsx with scoped landing.module.css. Preserve both.
- The authenticated application currently concentrates sign-in, inbox/upload, treasury, invoice detail, approval and audit in apps/web/app/dashboard/page.tsx. The sidebar has one Treasury workspace entry.
- AdministrationControls already implements vendor, purchase-order and policy forms. InvoiceReviewControls implements corrections, reevaluation/re-extraction, rejection and targeted reconciliation. ReviewerExamples supplies isolated synthetic examples.
- PayablesApi already wraps session, invoice list/detail/upload, private source image, audit, exact approval, review actions, treasury, vendor/PO lists and create/update actions, policy and reconciliation.
- Express implements PATCH /api/purchase-orders/:id. PO editing is supported and can be moved into a dedicated screen without inventing an endpoint.
- Invoice list pages contain up to 25 records, nextOffset, obligation state, decision and latest payment state. They do not contain business-wide attention counts, a full payment ledger or all prior payment attempts.
- There is no GET /api/payments list or GET /api/activity global feed. The only payment-specific route is reconciliation of an existing intent. Audit exports are per invoice.
- Treasury exposes authoritative financial overview, holds, commitments, daily and category headroom, snapshot block/time and unavailable status. Use these values directly; never reconstruct treasury totals from the inbox.
- Invoice detail exposes extraction, corrections, decisions, versions, approval offer and latest payment evidence. It does not guarantee a full resolved vendor/PO snapshot, all registry revisions or every historical payment attempt. Render only returned fields and link to existing records where possible.
- /ready exposes aggregate provider dependency readiness, storage, authentication, extraction/payment worker flags and dispatch state. It does not independently certify Gemini, Circle and Arc as three separate healthy integrations. A client readiness wrapper is needed, not a new diagnostics backend.
- The client currently keeps error message/status but drops structured code/requestId/retryable metadata. Preserve available safe error fields in the client to improve conflict and unavailable feedback without changing server behavior.
- The actual obligation enum uses EXTRACTING, not the brief's historical ANALYZING wording. Category settled-spend accounting uses the current UTC month; daily budget uses the UTC day. Preserve these meanings and label them accurately.

## Proposed navigation and page contracts

No more than seven primary operator navigation items. Settings/Status and sign-out live in the footer or account area. Route-aware active states and an accessible mobile drawer replace the single static active link.

| Navigation | Route | Content and data boundary |
|---|---|---|
| Overview | /dashboard | Treasury snapshot, loaded-invoice attention preview, five recent invoices and readiness. No fabricated global totals or activity feed. |
| Invoices | /dashboard/invoices | Existing paginated inbox; search/filter/sort explicitly limited to returned records. Separate lifecycle, decision and payment badges. |
| Upload invoice | /dashboard/invoices/new | Contextual child route, not another primary item. PNG/JPEG upload, local preview, optional PO hint, stable request identity and navigation to returned obligation ID. |
| Invoice detail | /dashboard/invoices/[id] | Private source/facts, available vendor/PO evidence, decision, review actions, exact approval, latest payment and per-invoice activity/export. |
| Action Center | /dashboard/actions | Approval, hold, schedule and rejection tabs over loaded invoice pages; detail supplies reasons and next evaluation. Pagination and coverage are visible. |
| Payments | /dashboard/payments | Invoice-linked payment index using returned latest payment states. Opening a row retrieves that invoice's payment evidence. No claim of complete historical attempts. |
| Treasury | /dashboard/treasury | Server-authored position, holds, commitments, snapshot/freshness, daily/monthly category headroom, policy editor and pause/resume confirmation. |
| Business Records | /dashboard/records | Entry page or redirect to vendors, with Vendors and Purchase Orders subnavigation. |
| Vendors | /dashboard/records/vendors | Existing paginated registry and versioned create/edit/block controls. No KYC certification or unavailable association joins. |
| Purchase Orders | /dashboard/records/purchase-orders | Existing list, create/edit, acceptance evidence, essential/service period fields and exact verified discounts. No partial billing or multiple invoices per PO. |
| Activity and Audit | /dashboard/activity | Invoice selector/links opening existing private timelines and per-invoice JSON export. No invented cross-invoice chronology or global export. |
| Settings and Status | /dashboard/settings | Session/sign-out, actual readiness fields, mode, privacy notice and policy shortcut. No environment/secret editor. |
| Reviewer examples | /reviewer | Role-isolated examples and fixed-clock evaluation; never loads operator records or spending controls. Sign-in remains at the existing workspace gate. |

P00 in the brief is preserved as-is. P01 is handled by the existing session mechanism inside a shared entry gate. P02 through P13 map to the routes above, with the document's conditional fallbacks applied.

## Implementation sequence and estimate

Estimates are focused engineering hours for one implementer, including relevant verification in each phase. They are not elapsed-time guarantees or a promise to meet an external event deadline.

| Phase | Deliverable | Estimate |
|---|---|---|
| 1 | Record API/field inventory, theme and screenshot baselines; map brief requirements; hash landing assets; identify reuse boundaries | 3–4 h |
| 2 | Shared session/API state, reusable workspace shell, seven-item navigation, page header, mobile drawer, sign-out and route/role guards | 6–8 h |
| 3 | Overview, dedicated inbox/upload, bounded loading/refresh, truthful page-scoped filters/counts, private image preview and direct invoice navigation | 7–10 h |
| 4 | Invoice detail sections, source/original/corrected evidence, confirmations, exact approval offer, pre-submission review actions, latest payment and audit | 9–13 h |
| 5 | Action Center and Treasury, current snapshot metrics, policy placement, freshness/unavailable feedback and reasoned pause/resume dialog | 6–9 h |
| 6 | Vendor/PO screens, supported edit drawers, invoice-linked Payments and Activity fallbacks, per-invoice export | 7–10 h |
| 7 | Settings/Status, reviewer-only route, safe redirects and session-expiry behavior across direct routes | 3–5 h |
| 8 | Integrated role/action/regression coverage, desktop/mobile/keyboard checks, production build, landing comparison and documentation | 6–9 h |
| Base total | Scoped frontend restructuring and verification | 47–68 h |
| Contingency | Existing component coupling, request races and browser regressions | 8–12 h |
| Planned total | Including contingency | 55–80 h |

At eight focused hours per working day, budget approximately seven to ten working days. The first navigable shell and overview/inbox/upload preview should be reviewable after phases 1–3, approximately 16–22 focused hours. The full amount includes the remaining detail/action/administration flows and integrated verification.

Assumptions: keep the existing backend and dependencies; use invoice-linked Payments/Audit fallbacks; provide no new global aggregate APIs; do not add screenshots or branding changes to the frozen landing page. Deployment, user-run value-moving tests, external provider outages and new features are outside this redesign estimate. Re-estimate after phase 1 only if inspection finds a material issue not already covered here.

## Implementation details that protect existing behavior

### Shared state and route changes

Extract shared session/API handling before splitting routes so CSRF and signed sessions continue working across navigation. Keep tokens in memory, never local storage. Clear private state after logout, expiry or role change. Do not fetch operator-only data while resolving or rendering reviewer access. Backend authorization remains authoritative; UI route guards are additional presentation protection.

Support direct navigation, refresh and browser back/forward on each route. Preserve the intended internal route through sign-in using validated local destinations. Abort or ignore stale reads after route changes so one invoice's data cannot appear on another detail page. Poll only relevant visible processing/pending views at a bounded interval and respect existing rate limits.

### Reusable components

Reuse and extract WorkspaceShell, PageHeader, StatusChip, MoneyDisplay, EmptyState, EvidenceRow, ConfirmDialog, AuditTimeline, DataFreshness and DetailDrawer. Reuse existing forms with new wrappers rather than maintaining parallel mutation implementations. Show one contextual primary action per page.

MoneyDisplay formats canonical string/bigint amounts with six-decimal precision; no Number conversion for money. Overview cash/headroom/holds come from treasury read models. An attention number derived from an invoice page must say it covers loaded invoices. Never present that as the total business backlog. An empty filtered page does not establish that no matching records exist elsewhere.

### Owner confirmations and financial controls

Approval displays the current exact offer, amount/recipient/network/token, expected obligation version and terms hash, and collects a reason. Never synthesize or silently refresh-and-submit stale terms. Corrections and registry/policy edits preserve current-version and reason/evidence requirements. Pause/resume collects the operator's reason and explains its effect; the existing server already accepts a reason, so only the client wrapper and UI need adjustment.

Keep invoice lifecycle, decision and payment lifecycle visually distinct. Pending/scheduled are not success. UNKNOWN and PENDING have no Pay Again action. Reconciliation targets the existing intent. Unsubmitted edits may invalidate authorization, but cannot reverse an already submitted transfer.

### Conditional data and fallbacks

Payments shows invoice-linked latest payment evidence only. Activity shows the selected invoice's audit. Do not silently enumerate every invoice and issue hundreds of detail/audit requests to manufacture global feeds. Registry version fields are available; historical revision browsing is shown only if an existing safe read contract supports it. Otherwise show the current version and invoice-linked evidence without a history claim.

Overview's recent-activity preview is omitted or replaced by a link to invoice activity because there is no global event query. Per-provider status is not inferred from an aggregate flag. Missing evidence, unavailable cash or an expired image is shown as unavailable with an appropriate explanation, not fabricated content or a false success message.

## Acceptance and verification

1. Landing JSX/CSS and relevant shared visual baseline remain unchanged; compare before/after screenshots at the same desktop/mobile sizes and verify its existing CTA/anchors.
2. Each workspace link works on direct load, refresh, back navigation and keyboard; active route and mobile drawer behavior are correct. No dead navigation items.
3. Operator and reviewer deep links enforce the existing separation. Unauthorized roles cannot fetch private data or mutate records through the backend.
4. Image upload preserves request identity, prevents duplicate clicks, routes to queued detail, and handles 409/422/503 states with safe server feedback. Local preview URLs are released when replaced/unmounted.
5. Detail distinguishes source extraction, normalized facts and owner correction evidence. Missing values remain visibly missing. Original facts are retained.
6. Approval/correction/rejection/PO/vendor/policy/pause flows preserve existing request contracts, exact terms, current versions and reasons. Conflicts require explicit review, not automatic mutation retry.
7. Treasury values are server-authored, precise and freshness-labeled. Daily and category accounting periods remain correct. Pending holds survive refresh/restart and never become browser-computed disposable money.
8. Payments/Audit pages identify their invoice-linked coverage. Export remains per invoice; no private image or token enters public storage, telemetry or source.
9. Run lint, workspace/root typechecks, meaningful existing API/domain/PostgreSQL tests, production build and fixture/durable browser journeys appropriate to the final changes. Add focused navigation, role, stale-request and confirmation coverage where it proves new behavior. Use isolated test providers; browser tests must not send payments through the configured live database.
10. Compare screenshots for the shell, inbox, detail, treasury, forms and reviewer experience at desktop/mobile sizes, including loading, empty, conflict, forbidden, unavailable and pending/unknown states.

## Scope conflicts and decisions

- Landing changes in the document conflict with the user's explicit freeze: exclude all P00 changes and keep current anchors. No clarification is needed to follow the user's stated priority.
- More workspace routes than the README's four original sections are a navigation change over the same AP capabilities, not new financial scope. Keep the seven-primary-item limit.
- A complete global payments ledger, global activity feed, global attention totals or individually verified integration dashboard is not supported by the current read contracts. Use the document's permitted fallback. If the owner later requires those full versions, explain the backend read-model work and request clarification before adding it.
- Screenshots referenced by the brief are not embedded in the supplied DOCX. Use the actual current application as the design baseline; do not invent a new theme.
- Keep existing AgentPay Treasury branding. Do not rename the product based on the AegisPay folder or document title.
- No PDF/email ingestion, direct Send USDC form, bulk approvals, new tenant management, partial billing, compliance certification or new infrastructure.

## Next action

Begin phase 1 only when the owner asks to implement this plan. Current request is planning; no application implementation, live provider call, credential change, approval, payment or deployment was performed for this review.
