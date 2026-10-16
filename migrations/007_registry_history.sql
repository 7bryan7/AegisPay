CREATE TABLE ap_registry_revisions (
  business_id text NOT NULL REFERENCES ap_treasuries(business_id),
  kind text NOT NULL CHECK (kind IN ('VENDOR','PURCHASE_ORDER','POLICY')),
  entity_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  actor_id text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  previous_record jsonb,
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id,kind,entity_id,version)
);
CREATE TRIGGER ap_registry_revisions_append_only BEFORE UPDATE OR DELETE ON ap_registry_revisions
  FOR EACH ROW EXECUTE FUNCTION ap_reject_mutation();
CREATE TRIGGER ap_registry_revisions_no_truncate BEFORE TRUNCATE ON ap_registry_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION ap_reject_mutation();
