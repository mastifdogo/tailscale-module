-- Publishing Ledger on the tailnet through the local tailscaled (Tailscale Serve).
ALTER TABLE settings
    ADD COLUMN socket_path  TEXT    NOT NULL DEFAULT '/var/run/tailscale/tailscaled.sock'
        CHECK (socket_path ~ '^/[A-Za-z0-9._/-]{1,200}$'),
    ADD COLUMN serve_target TEXT    CHECK (serve_target IS NULL OR serve_target ~ '^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$'),
    ADD COLUMN serve_port   INT     NOT NULL DEFAULT 443 CHECK (serve_port IN (443, 8443, 10000)),
    ADD COLUMN serve_wanted BOOLEAN NOT NULL DEFAULT false;  -- user turned it on; alert if it goes away
