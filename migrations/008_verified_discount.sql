-- Owner-maintained terms only. Existing accepted obligations remain essential.
ALTER TABLE ap_purchase_orders ADD COLUMN service_period text;
ALTER TABLE ap_purchase_orders ADD COLUMN essential boolean NOT NULL DEFAULT true;
ALTER TABLE ap_purchase_orders ADD COLUMN verified_discount jsonb;
ALTER TABLE ap_purchase_orders ADD CONSTRAINT ap_discount_object
  CHECK (verified_discount IS NULL OR jsonb_typeof(verified_discount) = 'object');
