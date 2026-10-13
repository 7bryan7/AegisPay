-- Operational liveness only; this mutable table is not payment/audit evidence.
CREATE TABLE ap_worker_status (
  business_id text PRIMARY KEY REFERENCES ap_treasuries(business_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  extraction_available boolean NOT NULL,
  payment_available boolean NOT NULL,
  dispatch_enabled boolean NOT NULL,
  healthy boolean NOT NULL
);
