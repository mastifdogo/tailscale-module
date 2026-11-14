-- 0.6.0: the module is only Ledger's connection to the tailnet. It no longer
-- reads the Tailscale API, so its copies of API data go: the device and user
-- snapshots, their sync history, and the old API and billing columns of
-- settings (pre-0.1.0 values; 0.1.0 moved them to Ledger's settings form).
-- Past charges stay in "charges": their journal entries remain in the books.
DROP TABLE devices;
DROP TABLE users;
DROP TABLE syncs;
ALTER TABLE settings
    DROP COLUMN tailnet,
    DROP COLUMN auth_mode,
    DROP COLUMN api_key,
    DROP COLUMN oauth_client_id,
    DROP COLUMN oauth_client_secret,
    DROP COLUMN sync_minutes,
    DROP COLUMN key_expiry_warn_days,
    DROP COLUMN offline_warn_days,
    DROP COLUMN billing_enabled,
    DROP COLUMN price_per_user_cents,
    DROP COLUMN base_fee_cents,
    DROP COLUMN currency,
    DROP COLUMN expense_account,
    DROP COLUMN payment_account,
    DROP COLUMN bill_day,
    DROP COLUMN moved_to_ledger_settings,
    -- Set once the module has cleared the API settings and dashboard items.
    ADD COLUMN api_features_removed BOOLEAN NOT NULL DEFAULT false;
