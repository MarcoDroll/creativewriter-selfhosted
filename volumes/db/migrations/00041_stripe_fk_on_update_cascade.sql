-- The upsert_stripe_customer_mapping RPC (00039) updates
-- stripe_customers.stripe_customer_id when a returning user starts a
-- new Stripe Checkout (Stripe Pricing Tables create a new cus_… for
-- every session). The default NO ACTION on the FKs from
-- subscription_cache and ai_usage blocks that update if any child
-- rows exist (e.g. a tier=none placeholder from the abandoned first
-- checkout) and surfaces as 23503 to the webhook handler. Add
-- ON UPDATE CASCADE so child rows follow the new customer id.

-- subscription_cache: FK was created inline in 00003 → auto-named
-- subscription_cache_stripe_customer_id_fkey on every install.
ALTER TABLE subscription_cache
  DROP CONSTRAINT IF EXISTS subscription_cache_stripe_customer_id_fkey;
ALTER TABLE subscription_cache
  ADD CONSTRAINT subscription_cache_stripe_customer_id_fkey
    FOREIGN KEY (stripe_customer_id)
    REFERENCES stripe_customers(stripe_customer_id)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ai_usage: table was originally created as ai_usage_daily in 00003
-- and renamed to ai_usage in 00009. Postgres does NOT auto-rename FK
-- constraint names when a table is renamed, so existing hosted DBs
-- still carry the constraint name ai_usage_daily_stripe_customer_id_fkey
-- while fresh self-hosted installs (whose 99-bootstrap schema declares
-- the table as ai_usage directly) carry ai_usage_stripe_customer_id_fkey.
-- Drop whichever exists and re-add under the canonical current-name form.
ALTER TABLE ai_usage
  DROP CONSTRAINT IF EXISTS ai_usage_daily_stripe_customer_id_fkey;
ALTER TABLE ai_usage
  DROP CONSTRAINT IF EXISTS ai_usage_stripe_customer_id_fkey;
ALTER TABLE ai_usage
  ADD CONSTRAINT ai_usage_stripe_customer_id_fkey
    FOREIGN KEY (stripe_customer_id)
    REFERENCES stripe_customers(stripe_customer_id)
    ON DELETE CASCADE ON UPDATE CASCADE;
