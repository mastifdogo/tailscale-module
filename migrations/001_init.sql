-- Single settings row (id is always true).
CREATE TABLE settings (
    id                    BOOLEAN     PRIMARY KEY DEFAULT true CHECK (id),
    tailnet               TEXT        NOT NULL DEFAULT '-' CHECK (tailnet ~ '^[A-Za-z0-9._@-]{1,200}$'),
    auth_mode             TEXT        NOT NULL DEFAULT 'api_key' CHECK (auth_mode IN ('api_key', 'oauth')),
    api_key               TEXT,
    oauth_client_id       TEXT,
    oauth_client_secret   TEXT,
    sync_minutes          INT         NOT NULL DEFAULT 60 CHECK (sync_minutes = 0 OR sync_minutes BETWEEN 5 AND 1440),
    key_expiry_warn_days  INT         NOT NULL DEFAULT 14 CHECK (key_expiry_warn_days BETWEEN 1 AND 90),
    offline_warn_days     INT         NOT NULL DEFAULT 30 CHECK (offline_warn_days BETWEEN 0 AND 365),
    billing_enabled       BOOLEAN     NOT NULL DEFAULT false,
    price_per_user_cents  BIGINT      NOT NULL DEFAULT 600 CHECK (price_per_user_cents BETWEEN 0 AND 10000000),
    base_fee_cents        BIGINT      NOT NULL DEFAULT 0 CHECK (base_fee_cents BETWEEN 0 AND 10000000),
    currency              TEXT        NOT NULL DEFAULT 'USD' CHECK (currency IN ('CAD', 'USD')),
    expense_account       TEXT,
    payment_account       TEXT,
    bill_day              INT         NOT NULL DEFAULT 1 CHECK (bill_day BETWEEN 1 AND 28),
    updated_by            TEXT,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings DEFAULT VALUES;

-- Latest snapshot of the tailnet's devices (replaced on every sync).
CREATE TABLE devices (
    id                  TEXT        PRIMARY KEY,   -- Tailscale nodeId
    name                TEXT        NOT NULL,      -- MagicDNS name, e.g. laptop.tail1234.ts.net
    hostname            TEXT,
    os                  TEXT,
    user_login          TEXT,
    addresses           JSONB       NOT NULL DEFAULT '[]',
    client_version      TEXT,
    update_available    BOOLEAN     NOT NULL DEFAULT false,
    authorized          BOOLEAN     NOT NULL DEFAULT true,
    is_external         BOOLEAN     NOT NULL DEFAULT false,
    tags                JSONB       NOT NULL DEFAULT '[]',
    created             TIMESTAMPTZ,
    last_seen           TIMESTAMPTZ,
    expires             TIMESTAMPTZ,               -- NULL when key expiry is disabled
    key_expiry_disabled BOOLEAN     NOT NULL DEFAULT false,
    connected           BOOLEAN,
    synced_at           TIMESTAMPTZ NOT NULL
);

-- Latest snapshot of the tailnet's users.
CREATE TABLE users (
    id           TEXT        PRIMARY KEY,
    login_name   TEXT,
    display_name TEXT,
    type         TEXT,                             -- member | shared
    role         TEXT,
    status       TEXT,                             -- active | idle | suspended | needs-approval | ...
    device_count INT,
    last_seen    TIMESTAMPTZ,
    connected    BOOLEAN,
    created      TIMESTAMPTZ,
    synced_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE syncs (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    triggered_by TEXT        NOT NULL,             -- 'auto' or a username
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    ok           BOOLEAN,
    error        TEXT,
    warning      TEXT,
    device_count INT,
    user_count   INT
);

-- Monthly subscription charges posted to the ledger.
CREATE TABLE charges (
    id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    period            TEXT        NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    entry_date        DATE        NOT NULL,
    seats             INT         NOT NULL CHECK (seats >= 0),
    unit_price_cents  BIGINT      NOT NULL CHECK (unit_price_cents >= 0),
    base_fee_cents    BIGINT      NOT NULL CHECK (base_fee_cents >= 0),
    total_cents       BIGINT      NOT NULL CHECK (total_cents > 0),
    currency          TEXT        NOT NULL CHECK (currency IN ('CAD', 'USD')),
    expense_account   TEXT        NOT NULL,
    payment_account   TEXT        NOT NULL,
    memo              TEXT        CHECK (memo IS NULL OR length(memo) <= 200),
    status            TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'reversing', 'reversed')),
    entry_id          BIGINT,                      -- journal entry posted for it
    reversal_entry_id BIGINT,
    created_by        TEXT        NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One live charge per month; a reversed charge frees the month up again.
CREATE UNIQUE INDEX charges_one_live_per_period ON charges (period) WHERE status <> 'reversed';
