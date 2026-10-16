# Invoice review layout

The invoice inbox remains the searchable, server-filtered entry point at `/dashboard/invoices`. Selecting an invoice opens `/dashboard/invoices/[id]` in the reference-inspired review layout. The existing charcoal/lime theme, landing page and financial rules are preserved.

The detail page groups actual records into summary cards, source evidence, normalized facts, current verification, historical decision evidence, corrections and a chronological activity timeline. The desktop sidebar contains the current decision, eligible exact approval, export, recorded payment state, current treasury information and approval scope. On mobile, decision/actions appear first, evidence follows, then payment/treasury/scope. Existing confirmation and reason requirements remain in force.

## Data semantics

- Source metadata is projected from the owned obligation, retained input and original `INVOICE_RECEIVED` actor. It includes the real SHA-256, MIME type, byte count and retention availability. Original filenames are not stored and are not invented. PNG/JPEG remain the supported upload formats.
- Current combined obligation verification calls the existing deterministic vendor/PO/invoice verifier against the current linked records. It does not reauthorize payment, perform external sanctions screening, or replace historical decision evidence. A settled PO's current outstanding amount may differ from its historical decision evidence.
- Similar-invoice references are displayed when recorded. No references does not produce a fabricated duplicate-check pass or a rolling-window claim.
- Decision evidence, versions, alternatives, discount terms and treasury snapshots come from the stored decision. Current treasury/policy information is explicitly separate. Neither represents a promise of future funding.
- Approval binds one invoice/version and exact terms. No global approval is offered. Approval cannot bypass hard limits, reserves, duplicate guards or verification.
- Payment progress highlights only the current recorded state. Other milestones require activity evidence; they are not marked complete based on an assumed sequence. UNKNOWN, FAILED and CANCELLED remain explicit states. A transaction hash alone is not settlement proof.
- Corrections retain independent evidence references, rationale, version binding and existing idempotency. Submitted/unresolved/settled payments retain their edit restrictions.
- The timeline initially shows the last 20 loaded events in chronological order, with an explicit count and expand/collapse control. The existing 500-record export/section limit remains visible when reached.
- Failure to load audit, treasury or policy does not hide the invoice. Unavailable panels say so; audit export is disabled when its data is unavailable. An invoice-request failure still produces an error, with no sample fallback.

## Verification

Use `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:db`, `npm run test:e2e`, `npm run test:e2e:db`, and `npm run build`. Database commands create disposable databases; browser transfers use isolated synthetic adapters. Stop the configured Next development server before browser/build checks because Next prevents multiple dev instances in one application directory. Restore `npm run dev` afterward. These checks do not establish real Circle/Arc settlement acceptance.
