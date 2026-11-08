# Tailscale for Ledger

A Ledger module that puts Ledger on your Tailscale tailnet and brings the tailnet into your books.

- **Ledger on the tailnet**: one click shares Ledger with your tailnet at
  `https://<server>.<tailnet>.ts.net` through Tailscale Serve, with a real HTTPS
  certificate, reachable only from your tailnet devices, never the public internet.
  A dashboard warning appears if it stops being shared.
- **Devices and users**: syncs the tailnet's machines and users from the Tailscale API
  (every 60 minutes by default, or with **Sync now**) and lists them with
  online status, OS and client version, Tailscale IP, tags and key expiry.
- **Dashboard alerts** on Ledger's dashboard, updated after every sync:
  - device keys that expire within 14 days (configurable), or have already expired
  - devices offline for more than 30 days (configurable, 0 = off)
  - devices or users waiting for approval
  - devices with a Tailscale client update available
  - a failed sync
- **Subscription bookkeeping** (optional): records the monthly Tailscale bill
  as a journal entry, *seats × price per user + flat fee*, with a dashboard
  to-do each month until it's recorded. Posted charges can be reversed.
- **Search**: tailnet devices (by name, IP, user, tag) and users show up in
  Ledger's search bar.

Requires **Ledger ≥ 0.11.1**. Configuration is on the module's tab under
**Settings → Tailscale**; the module's page has the Access, Overview, Devices,
Users and Billing tabs.

### Organizations

With several organizations (separate books) on one server:

- **Settings → Tailscale is per organization**: each organization's admins
  set its own API credentials, sync interval, alerts and billing. An
  organization without credentials simply has empty Devices and Users tabs.
  (Values saved before Ledger 0.11.1 belong to the main books.)
- Each organization syncs with its own credentials on its own schedule;
  **Sync now** syncs the organization you're in.
- Billing is per organization: turn it on in the books that pay for
  Tailscale and post the charge there.
- **The Access tab is server-wide**: one Ledger address on the tailnet. Only
  admins of the main books can share, stop sharing, log the server in or
  change Advanced; everyone else sees its state. The "not reachable on your
  tailnet" warning goes to every organization's dashboard.

### Who can do what

| | admin | bookkeeper | viewer |
|---|---|---|---|
| See everything | ✓ | ✓ | ✓ |
| Sync now, post or reverse a charge | ✓ | ✓ | |
| Share / stop sharing Ledger, log the server in, Access → Advanced | ✓ (of the main books) | | |
| Settings → Tailscale (credentials, alerts, billing) | ✓ (of that organization) | | |

## Put Ledger on your tailnet

The module drives the Tailscale daemon on the server Ledger runs on, through its
local socket (`/var/run/tailscale/tailscaled.sock`). One-time setup on that server:

```sh
curl -fsSL https://tailscale.com/install.sh | sh   # install Tailscale
sudo tailscale up                                  # join your tailnet
sudo tailscale set --operator=ledger               # let Ledger's service user manage Serve
```

Replace `ledger` with the user Ledger runs as. The **Access** tab shows the exact command.
Without `--operator`, Ledger can show the server's status but can't share it.

In the Tailscale admin console → **DNS**, turn on **MagicDNS** and **HTTPS Certificates**.

Then open **Tailscale → Access** in Ledger and click **Share Ledger on the tailnet** (admins only).
That's the same as running `tailscale serve --bg <ledger port>` on the server, plus
`http://<server>.<tailnet>.ts.net/` (and `http://<server>/`), which redirects to the
https address (Tailscale ≥ 1.92; older versions serve Ledger on plain http instead).
Before sharing, the module checks that the address really answers as Ledger.
Other Serve entries on the machine are left alone. **Stop sharing** removes only Ledger's.

Under **Advanced**:

| | Default | |
|---|---|---|
| Ledger address on this server | detected from the port Ledger listens on | A port (`3000`) or address (`127.0.0.1:3000`, `https://localhost:8443`) on this server. Addresses on other machines are refused |
| HTTPS port | 443 | 443, 8443 or 10000 (the ports Serve allows). Pick another if 443 is taken |
| tailscaled socket | `/var/run/tailscale/tailscaled.sock` | Change it if your distribution puts it elsewhere |
| Also answer plain http:// | on | Port 80; skipped if something else already uses it |

Notes:
- Requests arrive at Ledger with the original `Host` (`<server>.<tailnet>.ts.net`)
  over HTTPS. If your Ledger is configured with a fixed public URL or allowed hosts,
  add the tailnet address there.
- Who can reach it is governed by your tailnet ACLs. Everyone still signs in to Ledger.
- The module never turns on Funnel (public internet). If Funnel is enabled for
  Ledger's address by other means, the Access tab warns you.
- If Ledger runs in a container, mount the host's socket into it
  (`-v /var/run/tailscale:/var/run/tailscale`) and run Ledger as the operator user.

## Devices, users and billing setup

These use the Tailscale API (separate from the tailnet access above).

1. Install the module: Ledger → Settings → Modules → `mastifdogo/tailscale_module` → Add.
2. In the Tailscale admin console, create read-only credentials:
   - **OAuth client** (recommended, doesn't expire): Settings → OAuth clients →
     Generate, with scopes **`devices:core:read`** and **`users:read`**.
   - or an **API access token** (Settings → Keys). These expire after at most 90 days.
3. In Ledger, open **Settings → Tailscale**, choose the login type, paste the
   credentials and **Save**. The module syncs right away.
   Leave **Tailnet** as `-` to use the tailnet the credentials belong to.

Without `users:read` the devices still sync and the Users tab stays empty
(the sync shows a warning).

Credentials are secret fields in Ledger's settings form: write-only in the UI,
only sent to `api.tailscale.com`, never returned by the module's API, never logged.

Upgrading from 0.0.x: the first start of 0.1.1 copies your saved credentials,
alert and billing options into **Settings → Tailscale** and clears the copies of
the secrets in the module's own table.

## Billing

Turn on **Record the subscription in the ledger** under **Settings → Tailscale** and set:

| Setting | Default | |
|---|---|---|
| Price per user / month | 6.00 | Tailscale's Starter plan price; use 18.00 for Premium, 0.00 if you only pay a flat fee |
| Flat fee / month | 0.00 | Added once per month |
| Currency | USD | Tailscale bills in USD |
| Remind me on day of month | 1 | Day of the month the dashboard to-do appears |
| Expense account (debit) | — | Code of an active **expense** account in that currency |
| Paid from (credit) | — | Code of an active **asset** (bank) or **liability** (credit card, payables) account in that currency |

The Billing tab says what's missing or wrong (an account that doesn't exist,
is in another currency, a price that isn't an amount) until it can post.

### Accounts it expects

The module never creates accounts. A typical setup (USD):

| Code | Name | Type | Currency |
|---|---|---|---|
| `6400` | Software subscriptions | expense | USD |
| `2100` | Credit card (USD) | liability | USD |

If your books are in CAD and you want the charge in CAD, set the currency to
CAD and enter the converted price; amounts are never mixed across currencies.

### Posting a charge

**Billing** tab → pick the month and entry date, check the seats → **Post charge**.
That posts one balanced entry:

```
Dr 6400 Software subscriptions   12.00 USD
    Cr 2100 Credit card (USD)        12.00 USD
description: Tailscale subscription 2026-10   reference: tailscale:2026-10
```

- Seats default to *billable users*: members with status `active` (shared-in
  users and idle, suspended or pending members are not counted). Override the
  number if your invoice differs.
- Only one live charge per month. To correct one, **Reverse** it (posts a
  reversing entry dated today) and post again.
- A charge stuck as `pending` means Ledger stopped while posting. Look for an
  entry with reference `tailscale:<month>` in the journal; reverse it in Ledger
  if it exists, then **Discard** the pending charge.

## API

All under `/api/v1/m/tailscale`, logged-in users only (Ledger refuses non-GET requests from viewers; the `/node` changes are admin-only):

| | |
|---|---|
| `GET /node` | this server's Tailscale state and whether Ledger is shared |
| `POST /node/serve`, `DELETE /node/serve` | share / stop sharing Ledger on the tailnet |
| `PUT /node/settings` | `{serve_target?, serve_port?, socket_path?, serve_http?}` |
| `POST /node/login` | start an interactive login; returns `{auth_url}` |
| `GET /status` | your role, connection state, settings problems, counts, last sync, this month's charge |
| `POST /sync` | sync now |
| `GET /devices`, `GET /users`, `GET /syncs` | snapshots and the last 20 syncs |
| `GET /charges`, `POST /charges` | charges; `POST {period?, entry_date?, seats?, memo?}` |
| `POST /charges/:id/reverse` | reverse a posted charge |
| `DELETE /charges/:id` | discard a charge stuck in `pending` |

## Development

- `server.mjs` registers the routes; `lib.mjs` holds the parts that need
  neither Ledger nor tailscaled (address detection, Serve config, probes), tested
  by `npm test` (`node --test`, no dependencies).
- `sh .claude/skills/ledger-module/scripts/check.sh` runs Ledger's module checker
  (see `.claude/skills/ledger-module/SKILL.md`).
- No build step and no npm dependencies at runtime; `package.json` is only for tests.

## Releasing

1. Bump `version` in `ledger-module.json` and note the change below (add a new
   `migrations/NNN_*.sql` for schema changes, never edit a released one).
2. `git tag v<version> && git push origin v<version>`
3. Create a GitHub Release from the tag (not a draft or pre-release).
   Ledger picks it up on its update schedule or with **Update modules now**.

## Changes

- **0.2.0** — needs Ledger 0.11.1, where module settings are per organization:
  each organization syncs with its own credentials and schedule, alerts and
  billing follow its own settings, and saving the form syncs that organization.
  Tailnet sharing is managed by admins of the main books only. The one-time
  move of 0.0.x settings copies only values that were set, never old defaults.
- **0.1.1** — needs Ledger 0.11.0. Works with organizations (see above). Settings moved to Ledger's settings form
  (copied over automatically); admin-only Serve actions; devices and users in
  Ledger's search; drawn sidebar icon; UI renders API data as text only; tests.
- **0.0.4** — plain `http://` redirects to https; the target is checked to be Ledger before sharing.
- **0.0.3** — version bump.
- **0.0.2** — works under hardened systemd units; port detection via `/proc/self/net`.
- **0.0.1** — detects Ledger's port; accepts any address on this server.
- **0.0.0** — first release.
