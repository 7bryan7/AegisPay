-- Separate AP records; legacy tinybar tables and migrations keep their meaning.
-- Application writes must lock the stable treasury row before financial changes.
CREATE DOMAIN ap_micro_usdc AS numeric
  CHECK (VALUE >= 0 AND VALUE <= 99999999999999999999 AND VALUE = trunc(VALUE));
-- An unconstrained numeric plus checks rejects fractions instead of silently
-- rounding them as NUMERIC(20,0) would. It has the same integer value range.

CREATE TABLE ap_treasuries (
  business_id text PRIMARY KEY,
  wallet_id text NOT NULL UNIQUE,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$' AND wallet_address <> '0x0000000000000000000000000000000000000000'),
  chain_id integer NOT NULL CHECK (chain_id = 5042002),
  token_address text NOT NULL CHECK (token_address = '0x3600000000000000000000000000000000000000'),
  payment_mode text NOT NULL DEFAULT 'disabled' CHECK (payment_mode IN ('disabled', 'fixture', 'arc_testnet')),
  paused boolean NOT NULL DEFAULT true,
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  worker_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ap_vendors (
  business_id text NOT NULL REFERENCES ap_treasuries(business_id),
  id text NOT NULL,
  name text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(aliases) = 'array'),
  status text NOT NULL CHECK (status IN ('APPROVED', 'BLOCKED')),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$' AND address <> '0x0000000000000000000000000000000000000000'),
  address_version integer NOT NULL DEFAULT 1 CHECK (address_version > 0),
  chain_id integer NOT NULL CHECK (chain_id = 5042002),
  category text NOT NULL,
  settlement_currency text NOT NULL CHECK (settlement_currency IN ('USD', 'USDC')),
  settlement_agreement_reference text NOT NULL CHECK (length(btrim(settlement_agreement_reference)) > 0),
  verification_reference text NOT NULL CHECK (length(btrim(verification_reference)) > 0),
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (business_id, id)
);

CREATE TABLE ap_purchase_orders (
  business_id text NOT NULL,
  id text NOT NULL,
  vendor_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  amount_micro_usdc ap_micro_usdc NOT NULL CHECK (amount_micro_usdc > 0),
  outstanding_micro_usdc ap_micro_usdc NOT NULL,
  description text NOT NULL,
  due_date date NOT NULL,
  delivery_accepted boolean NOT NULL DEFAULT false,
  acceptance_reference text,
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, id, vendor_id),
  FOREIGN KEY (business_id, vendor_id) REFERENCES ap_vendors(business_id, id),
  CHECK (outstanding_micro_usdc <= amount_micro_usdc),
  CHECK (NOT delivery_accepted OR (acceptance_reference IS NOT NULL AND length(btrim(acceptance_reference)) > 0))
);

CREATE TABLE ap_obligations (
  business_id text NOT NULL REFERENCES ap_treasuries(business_id),
  id uuid NOT NULL,
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  purchase_order_hint text,
  raw_extraction jsonb,
  normalized jsonb,
  vendor_id text,
  purchase_order_id text,
  normalized_invoice_number text,
  amount_micro_usdc ap_micro_usdc CHECK (amount_micro_usdc > 0),
  currency text CHECK (currency IN ('USD', 'USDC')),
  issue_date date,
  due_date date,
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'EXTRACTING', 'OPEN', 'SETTLED', 'REJECTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  next_evaluation_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, input_sha256),
  UNIQUE (business_id, idempotency_key),
  FOREIGN KEY (business_id, vendor_id) REFERENCES ap_vendors(business_id, id),
  FOREIGN KEY (business_id, purchase_order_id, vendor_id) REFERENCES ap_purchase_orders(business_id, id, vendor_id),
  CHECK (purchase_order_id IS NULL OR vendor_id IS NOT NULL),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (issue_date IS NULL OR due_date IS NULL OR issue_date <= due_date)
);
CREATE UNIQUE INDEX ap_obligation_identity ON ap_obligations (business_id, vendor_id, normalized_invoice_number)
  WHERE vendor_id IS NOT NULL AND normalized_invoice_number IS NOT NULL;
CREATE UNIQUE INDEX ap_obligation_po ON ap_obligations (business_id, purchase_order_id)
  WHERE purchase_order_id IS NOT NULL AND status <> 'REJECTED';
CREATE INDEX ap_obligation_work ON ap_obligations (next_evaluation_at, lease_expires_at)
  WHERE status IN ('RECEIVED', 'EXTRACTING', 'OPEN');

CREATE TABLE ap_inputs (
  business_id text NOT NULL,
  obligation_id uuid NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5000000),
  image_bytes bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (business_id, obligation_id),
  FOREIGN KEY (business_id, obligation_id) REFERENCES ap_obligations(business_id, id),
  CHECK (octet_length(image_bytes) = byte_size)
);

CREATE TABLE ap_decisions (
  business_id text NOT NULL,
  id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  obligation_version integer NOT NULL CHECK (obligation_version > 0),
  action text NOT NULL CHECK (action IN ('PAY_NOW', 'SCHEDULE', 'HOLD', 'REQUIRE_APPROVAL', 'REJECT')),
  candidate jsonb,
  reason text NOT NULL,
  evidence_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_ids) = 'array'),
  model_version text,
  prompt_version text,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  vendor_address_version integer CHECK (vendor_address_version > 0),
  purchase_order_version integer CHECK (purchase_order_version > 0),
  treasury_snapshot jsonb NOT NULL,
  evaluated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, id, obligation_id),
  FOREIGN KEY (business_id, obligation_id) REFERENCES ap_obligations(business_id, id),
  CHECK (expires_at > evaluated_at)
);

CREATE TABLE ap_approvals (
  business_id text NOT NULL,
  id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  terms_hash text NOT NULL CHECK (terms_hash ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL,
  role text NOT NULL CHECK (role = 'OPERATOR'),
  granted boolean NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, decision_id),
  UNIQUE (business_id, id, decision_id, obligation_id),
  FOREIGN KEY (business_id, decision_id, obligation_id) REFERENCES ap_decisions(business_id, id, obligation_id),
  CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '24 hours'),
  -- Approval expiry is checked before submission; settlement may arrive later.
  CHECK (consumed_at IS NULL OR (granted AND consumed_at >= granted_at))
);

CREATE TABLE ap_payment_intents (
  business_id text NOT NULL REFERENCES ap_treasuries(business_id),
  id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  approval_id uuid,
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  provider_idempotency_key uuid NOT NULL UNIQUE,
  provider_id text UNIQUE,
  transaction_hash text UNIQUE CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  amount_micro_usdc ap_micro_usdc NOT NULL CHECK (amount_micro_usdc > 0),
  fee_allowance_micro_usdc ap_micro_usdc NOT NULL,
  actual_fee_micro_usdc ap_micro_usdc,
  state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED', 'SUBMITTING', 'PENDING', 'UNKNOWN', 'SETTLED', 'FAILED', 'CANCELLED')),
  lease_owner text,
  lease_expires_at timestamptz,
  submitted_at timestamptz,
  settled_at timestamptz,
  provider_state text,
  receipt_evidence jsonb,
  failure_evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  FOREIGN KEY (business_id, decision_id, obligation_id) REFERENCES ap_decisions(business_id, id, obligation_id),
  FOREIGN KEY (business_id, approval_id, decision_id, obligation_id) REFERENCES ap_approvals(business_id, id, decision_id, obligation_id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (state NOT IN ('SUBMITTING', 'PENDING', 'UNKNOWN', 'SETTLED') OR submitted_at IS NOT NULL),
  CHECK (state <> 'SETTLED' OR (provider_state = 'COMPLETE' AND provider_state IS NOT NULL AND provider_id IS NOT NULL AND transaction_hash IS NOT NULL AND receipt_evidence IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK (state <> 'FAILED' OR failure_evidence IS NOT NULL)
);
CREATE UNIQUE INDEX ap_one_active_intent ON ap_payment_intents (business_id, obligation_id)
  WHERE state IN ('RESERVED', 'SUBMITTING', 'PENDING', 'UNKNOWN', 'SETTLED');
CREATE UNIQUE INDEX ap_one_inflight_treasury ON ap_payment_intents (business_id)
  WHERE state IN ('RESERVED', 'SUBMITTING', 'PENDING', 'UNKNOWN');

CREATE TABLE ap_reservations (
  business_id text NOT NULL,
  intent_id uuid NOT NULL,
  amount_micro_usdc ap_micro_usdc NOT NULL CHECK (amount_micro_usdc > 0),
  fee_micro_usdc ap_micro_usdc NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'CONSUMED', 'RELEASED')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (business_id, intent_id),
  FOREIGN KEY (business_id, intent_id) REFERENCES ap_payment_intents(business_id, id),
  CHECK ((status = 'HELD') = (finished_at IS NULL))
);

CREATE TABLE ap_events (
  business_id text NOT NULL REFERENCES ap_treasuries(business_id),
  event_key text NOT NULL,
  actor_id text NOT NULL,
  entity_id text NOT NULL,
  entity_version integer NOT NULL CHECK (entity_version > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, event_key)
);

CREATE FUNCTION ap_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AP audit/decision records are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER ap_events_append_only BEFORE UPDATE OR DELETE ON ap_events FOR EACH ROW EXECUTE FUNCTION ap_reject_mutation();
CREATE TRIGGER ap_events_no_truncate BEFORE TRUNCATE ON ap_events FOR EACH STATEMENT EXECUTE FUNCTION ap_reject_mutation();
CREATE TRIGGER ap_decisions_append_only BEFORE UPDATE OR DELETE ON ap_decisions FOR EACH ROW EXECUTE FUNCTION ap_reject_mutation();
CREATE TRIGGER ap_decisions_no_truncate BEFORE TRUNCATE ON ap_decisions FOR EACH STATEMENT EXECUTE FUNCTION ap_reject_mutation();

CREATE FUNCTION ap_protect_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment intents cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF ROW(NEW.business_id, NEW.id, NEW.obligation_id, NEW.decision_id, NEW.approval_id,
         NEW.terms, NEW.request_fingerprint, NEW.provider_idempotency_key, NEW.amount_micro_usdc, NEW.fee_allowance_micro_usdc)
     IS DISTINCT FROM
     ROW(OLD.business_id, OLD.id, OLD.obligation_id, OLD.decision_id, OLD.approval_id,
         OLD.terms, OLD.request_fingerprint, OLD.provider_idempotency_key, OLD.amount_micro_usdc, OLD.fee_allowance_micro_usdc) THEN
    RAISE EXCEPTION 'payment terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id)
     OR (OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash) THEN
    RAISE EXCEPTION 'payment identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> NEW.state AND NOT (
    (OLD.state = 'RESERVED' AND NEW.state IN ('SUBMITTING', 'CANCELLED')) OR
    (OLD.state = 'SUBMITTING' AND NEW.state IN ('PENDING', 'UNKNOWN', 'SETTLED', 'FAILED')) OR
    (OLD.state = 'PENDING' AND NEW.state IN ('UNKNOWN', 'SETTLED', 'FAILED')) OR
    (OLD.state = 'UNKNOWN' AND NEW.state IN ('PENDING', 'SETTLED', 'FAILED'))
  ) THEN RAISE EXCEPTION 'unsafe payment state transition' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ap_intent_guard BEFORE UPDATE OR DELETE ON ap_payment_intents FOR EACH ROW EXECUTE FUNCTION ap_protect_intent();
