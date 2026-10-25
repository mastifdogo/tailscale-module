-- Allow any address on this server (and HTTPS targets) as Ledger's address; the module validates it.
ALTER TABLE settings DROP CONSTRAINT settings_serve_target_check;
ALTER TABLE settings ADD CONSTRAINT settings_serve_target_check
    CHECK (serve_target IS NULL OR serve_target ~ '^(http|https\+insecure)://[^/[:space:]]{1,100}$');
