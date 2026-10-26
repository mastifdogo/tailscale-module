-- Also answer plain http:// on port 80 (redirect to https, or proxy on older Tailscale).
ALTER TABLE settings ADD COLUMN serve_http BOOLEAN NOT NULL DEFAULT true;
