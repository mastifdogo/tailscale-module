# Tailscale for Ledger

A Ledger module that connects your Tailscale tailnet to your books.

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

## Setup

1. Install the module: Ledger → Settings → Modules → `mastifdogo/tailscale-module` → Add.
2. In the Tailscale admin console, create read-only credentials:
   - **OAuth client** (recommended, doesn't expire): Settings → OAuth clients →
     Generate, with scopes **`devices:core:read`** and **`users:read`**.
   - or an **API access token** (Settings → Keys). These expire after at most 90 days.
3. Open **Tailscale** in Ledger's sidebar → **Settings**, choose the
   authentication type, paste the credentials and **Save**. The connection is
   tested right away.
   Leave **Tailnet** as `-` to use the tailnet the credentials belong to.

Without `users:read` the devices still sync and the Users tab stays empty
(the sync shows a warning).

Credentials are stored in the module's own database schema (`mod_tailscale`).
They are only sent to `api.tailscale.com`, never returned to the browser
(only the last 4 characters are shown), and never logged.
**Remove saved credentials** in Settings clears them.

## Billing

Turn on **Record the monthly subscription in the ledger** in Settings and set:

| Setting | Default | |
|---|---|---|
| Price per user / month | 6.00 | Tailscale's Starter plan price; use 18.00 for Premium, 0.00 if you only pay a flat fee |
| Flat fee / month | 0.00 | Added once per month |
| Currency | USD | Tailscale bills in USD |
| Remind me on day | 1 | Day of the month the dashboard to-do appears |
| Expense account (debit) | — | An active **expense** account in that currency |
| Paid from (credit) | — | An active **asset** (bank) or **liability** (credit card, payables) account in that currency |

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

All under `/api/v1/m/tailscale`, logged-in users only:

| | |
|---|---|
| `GET /status` | connection state, counts, last sync, this month's charge |
| `POST /sync` | sync now |
| `GET /devices`, `GET /users`, `GET /syncs` | snapshots and the last 20 syncs |
| `GET /settings`, `PUT /settings` | settings (secrets masked); `PUT` takes any subset, secret `null` = clear |
| `GET /accounts` | Ledger accounts for the account pickers |
| `GET /charges`, `POST /charges` | charges; `POST {period?, entry_date?, seats?, memo?}` |
| `POST /charges/:id/reverse` | reverse a posted charge |
| `DELETE /charges/:id` | discard a charge stuck in `pending` |

## Releasing

1. Bump `version` in `ledger-module.json` (and add a new `migrations/NNN_*.sql`
   for schema changes, never edit `001_init.sql`).
2. `git tag v1.0.0 && git push origin v1.0.0`
3. Create a GitHub Release from the tag (not a draft or pre-release).
   Ledger picks it up on its update schedule or with **Update modules now**.

Requires Ledger ≥ 0.7.0. No build step and no npm dependencies.
