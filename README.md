# Tailscale for Ledger

A Ledger module that is Ledger's connection to your Tailscale tailnet: one
click shares Ledger at `https://<server>.<tailnet>.ts.net` through Tailscale
Serve, with a real HTTPS certificate, reachable only from your tailnet devices,
never the public internet. A dashboard warning appears if it stops being shared.

It only talks to Tailscale on the Ledger server itself; it doesn't use the
Tailscale API, so it needs no API keys and doesn't list your tailnet's devices
or users.

Requires **Ledger ≥ 0.11.1**. Everything is on the module's page in the sidebar.

### Who can do what

| | admin of the main books | everyone else |
|---|---|---|
| See whether and where Ledger is shared | ✓ | ✓ |
| Share / stop sharing, log the server in, Advanced | ✓ | |

Sharing is server-wide: with several organizations (separate books), it's
managed from the main books, and the "not reachable on your tailnet" warning
goes to every organization's dashboard.

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

Then open **Tailscale** in Ledger's sidebar and click **Share Ledger on the tailnet** (admins only).
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

## API

All under `/api/v1/m/tailscale`, logged-in users only; changes are for admins of the main books:

| | |
|---|---|
| `GET /node` | this server's Tailscale state, whether Ledger is shared, your role and whether you can change it |
| `POST /node/serve`, `DELETE /node/serve` | share / stop sharing Ledger on the tailnet |
| `PUT /node/settings` | `{serve_target?, serve_port?, socket_path?, serve_http?}` |
| `POST /node/login` | start an interactive login; returns `{auth_url}` |

## Development

- `server.mjs` registers the routes; `lib.mjs` holds the parts that need
  neither Ledger nor tailscaled (address detection, Serve config, probes), tested
  by `npm test` (`node --test`, no dependencies).
- `sh .claude/skills/ledger-module/scripts/check.sh` runs Ledger's module checker
  (see `.claude/skills/ledger-module/SKILL.md`).
- No build step and no npm dependencies at runtime; `package.json` is only for tests.

## Releasing

1. Bump `version` in `ledger-module.json` (features raise the middle number,
   fixes the last) and note the change below. Add a new `migrations/NNN_*.sql`
   for schema changes; never edit a released one.
2. Commit and push to `main`. The **Release** workflow
   (`.github/workflows/release.yml`) tags `v<version>` and publishes a GitHub
   Release with generated notes. Don't create tags or releases by hand.
   If it fails with "Resource not accessible by integration", allow it once:
   repository Settings → Actions → General → Workflow permissions →
   "Read and write permissions", then Actions → Release → Run workflow.
3. Ledger installs it on its update schedule, with **Update modules now**
   (Settings → Modules, the quickest), or at the next server start if
   **Update when the server starts** is on (Settings → Updates, Ledger ≥ 0.12.1).

## Changes

- **0.6.0** — only Ledger's connection to the tailnet. Removed everything that
  used the Tailscale API: the API credentials and options in Settings →
  Tailscale (cleared from Ledger's settings store), device and user syncing,
  the Overview, Devices, Users and Billing tabs, device alerts, search, and
  billing. Their dashboard items are removed and the cached device, user and
  sync tables dropped. Past charges stay in the module's `charges` table and
  their journal entries in the books. Needs Ledger 0.11.1.
- **0.5.0** — charges' journal entries name Tailscale as the vendor (Ledger
  0.16 entities; skipped on older Ledgers). Safe with Ledger 0.14's restores:
  the one-time settings move never overwrites values the settings form
  already holds, so restoring an old backup can't bring back stale credentials.
- **0.4.0** — needs Ledger 0.11.3. **+ New account…** on the Billing tab
  creates a missing billing account with Ledger's dialog and saves it in the
  settings (new route `PUT /billing/accounts`, admins only).
- **0.3.0** — needs Ledger 0.11.2. Journal entries for charges (and their
  reversals) link back to the charge; charges posted earlier get their links
  once. A charge stuck in `pending` is settled from its linked entry, and
  can't be discarded if it has one.
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
