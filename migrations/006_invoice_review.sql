-- Forward-only review history; original model extraction is not operator-editable.
ALTER TABLE ap_obligations ADD COLUMN original_extraction jsonb;
ALTER TABLE ap_obligations ADD COLUMN owner_corrections jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(owner_corrections) = 'object');
UPDATE ap_obligations SET original_extraction = raw_extraction WHERE raw_extraction IS NOT NULL;

CREATE TABLE ap_invoice_revisions (
  business_id text NOT NULL,
  obligation_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  actor_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('CORRECT', 'EVALUATE', 'REJECT')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  raw_extraction jsonb,
  corrections jsonb NOT NULL CHECK (jsonb_typeof(corrections) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, obligation_id, version),
  FOREIGN KEY (business_id, obligation_id) REFERENCES ap_obligations(business_id, id)
);
CREATE TABLE ap_invoice_commands (
  business_id text NOT NULL,
  obligation_id uuid NOT NULL,
  command_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, obligation_id, command_id),
  FOREIGN KEY (business_id, obligation_id) REFERENCES ap_obligations(business_id, id)
);
CREATE TRIGGER ap_invoice_revisions_append_only BEFORE UPDATE OR DELETE ON ap_invoice_revisions
  FOR EACH ROW EXECUTE FUNCTION ap_reject_mutation();
CREATE TRIGGER ap_invoice_revisions_no_truncate BEFORE TRUNCATE ON ap_invoice_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION ap_reject_mutation();
CREATE TRIGGER ap_invoice_commands_append_only BEFORE UPDATE OR DELETE ON ap_invoice_commands
  FOR EACH ROW EXECUTE FUNCTION ap_reject_mutation();
CREATE TRIGGER ap_invoice_commands_no_truncate BEFORE TRUNCATE ON ap_invoice_commands
  FOR EACH STATEMENT EXECUTE FUNCTION ap_reject_mutation();

CREATE FUNCTION ap_preserve_original_extraction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.original_extraction IS NOT NULL AND NEW.original_extraction IS DISTINCT FROM OLD.original_extraction THEN
    RAISE EXCEPTION 'original extraction cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ap_original_extraction_guard BEFORE UPDATE ON ap_obligations
  FOR EACH ROW EXECUTE FUNCTION ap_preserve_original_extraction();
