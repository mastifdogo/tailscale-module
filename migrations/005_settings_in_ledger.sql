-- From 0.1.0 the API credentials, alert and billing options live in Ledger's
-- settings form for the module. The module copies them there once at startup,
-- then clears the secrets kept here; the Serve columns stay in use.
ALTER TABLE settings ADD COLUMN moved_to_ledger_settings BOOLEAN NOT NULL DEFAULT false;
