-- Owned, deterministic pagination for workspace read models. No financial state changes.
CREATE INDEX ap_invoice_workspace_order ON ap_obligations (business_id, created_at DESC, id DESC);
CREATE INDEX ap_payment_workspace_order ON ap_payment_intents (business_id, created_at DESC, id DESC);
CREATE INDEX ap_activity_workspace_order ON ap_events (business_id, created_at DESC, event_key DESC);
CREATE INDEX ap_decision_workspace_latest ON ap_decisions (business_id, obligation_id, obligation_version, evaluated_at DESC, id DESC);
