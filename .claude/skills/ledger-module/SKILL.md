---
name: ledger-module
description: Work on this Ledger module (a plugin for the Ledger bookkeeping app, installed from this GitHub repository): add features, fix bugs, update it for new Ledger versions, check it, and release it. Use for any change to this repository's module code, manifest, migrations, UI or releases.
---

# Working on this Ledger module

This repository is a **Ledger module**: `ledger-module.json` (manifest),
`server.mjs` (runs inside the Ledger server), `ui/` (its page in Ledger) and
`migrations/` (SQL in its own schema). Ledger installs the latest GitHub
Release of this repository. Ledger itself is
[mastifdogo/Bookeeping](https://github.com/mastifdogo/Bookeeping).

## When invoked with no instruction

Bring this module up to date with the current Ledger and push it, as Ledger's
own module skill describes: read the current module API, compare, make the
changes (raise `"ledger"` and `version` as below), run the checks, commit and
push `main` (the release workflow publishes it). Say what changed and what
you left alone and why; if nothing needed changing, say so and push nothing.
Changes that move the user's data still need their approval in the module.

## 1. Get a Ledger checkout and read the module API

The API reference and the full workflow live in the Ledger repository.

- Use `$LEDGER_DIR`, a sibling checkout (`../Accounting`, `../Bookeeping`),
  or clone one: `git clone --depth 1 https://github.com/mastifdogo/Bookeeping /tmp/ledger-for-modules`
  (`scripts/check.sh` does this for you).
- Read **`<ledger>/docs/MODULE_LLM_CONTEXT.md`** in full before changing
  anything: manifest, `ctx` API and return shapes, `ctx.settings`,
  `ctx.dashboard`, `ctx.llm`, `ctx.gmail`, `ctx.search`, roles, migrations,
  UI and security rules.
- Then follow **`<ledger>/.claude/skills/ledger-module/SKILL.md`** (design
  rules, implementation rules, checks, publishing). Treat this repository as
  the module directory it talks about. Where the docs and Ledger's code
  disagree, the code wins (`backend/src/module-host.ts`, `modules.ts`,
  `module-settings.ts`).

Set `"ledger": ">=x.y.z"` in the manifest to the oldest Ledger with every
feature the module uses (the context file says which version added what;
`git -C <ledger> describe --tags --abbrev=0` is the latest release).

## 2. Rules that bite

- No npm packages at runtime: Ledger installs the release as-is. Only
  `node:*` built-ins, global `fetch`, and this repo's own files. (A
  `package.json` here is only for running tests.)
- Never edit a released migration; add the next `NNN_name.sql`.
- Money is integer cents per currency; post to the books only with
  `ctx.ledger.createJournalEntry(entry, req.user)`.
- AI goes through `ctx.llm` and Gmail through `ctx.gmail` (Ledger ≥ 0.10.0):
  no API keys, OAuth, IMAP or Apps Script bridges of the module's own for
  those. The admin allows the module under Settings → AI / Gmail.
- Bad input answers 4xx (`throw new ctx.HttpError(422, "…")`), never 500.
- Ledger runs in a Debian 13 container with PostgreSQL 18 (Ledger ≥ 0.18.0):
  write for that only, call no programs that aren't installed there.

## 3. Check before saying it works

```sh
npm test                      # this repo's own tests, if package.json has them
(pg_isready || service postgresql start) >/dev/null
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  sh .claude/skills/ledger-module/scripts/check.sh
```

`check.sh` runs Ledger's checker on this repo: manifest, files, imports,
migrations, then the module loaded into a real Ledger on a scratch database
(every GET route, POST `{}` must give 4xx, UI, settings). Add `--serve 8098`
to keep it running and test the real flows with `curl` and Playwright (it
prints the session cookie). If PostgreSQL has no password yet:
`runuser -u postgres -- psql -qc "ALTER USER postgres PASSWORD 'postgres'"`.

## 4. Release (only when the user asks)

**Never push to the Ledger repository (`mastifdogo/Bookeeping`) while
working on this module.** Push only to this repository. If the module needs
a change in Ledger (a bug fix, a new `ctx` feature, a docs or checker fix),
make it in a local Ledger checkout, tell the user what it is and why, and
leave pushing it to them. The module must work without that change.

1. Bump `version` in `ledger-module.json`: new features or behaviour raise the
   middle number (`0.1.1` → `0.2.0`), fixes the last. Note the change in the README.
2. Commit and push `main`. `.github/workflows/release.yml` creates the tag
   `v<version>` and the GitHub Release; don't make them by hand. If the run
   fails with "Resource not accessible by integration", the user allows it
   once: Settings → Actions → General → Workflow permissions → "Read and
   write permissions" (then Actions → Release → Run workflow).
3. Ledger installs it on its update schedule, with "Update modules now"
   (Settings → Modules), or at server start if "Update when the server
   starts" is on (Settings → Updates, Ledger ≥ 0.12.1). Tell the user which
   will pick it up; "Update modules now" is the quickest.

## This module: Tailscale (`id: tailscale`, schema `mod_tailscale`)

Ledger's connection to the tailnet: shares Ledger with Tailscale Serve through
the server's own tailscaled LocalAPI socket, and warns on the dashboard if the
share goes away. Since 0.6.0 it does **not** use the Tailscale API (no
devices, users, alerts about them, search or billing): the user asked for a
connection only, so don't add API features back without asking.

- Layout: `server.mjs` (routes, LocalAPI client, Serve setup, the share
  check), `lib.mjs` (address detection, Serve config building, probes: no
  Ledger or tailscaled needed) and `ui/index.html` (one page, built with an
  `h()` helper; API data only ever goes in as text). Tests: `npm test`
  (`node --test`, covers `lib.mjs`).
- No manifest `settings`: the Serve options (address, HTTPS port, socket,
  plain http) and `serve_wanted` live in `mod_tailscale.settings` of the main
  books and are changed on the page's Advanced box.
- It talks to `tailscaled` on the Ledger server; the checker can't exercise
  those routes without one, so test Serve changes against a real tailscaled or
  the stand-ins in `test/` (`withLedger`, `describeServe`). Changing what it
  shares changes how Ledger is reached: confirm with the user before touching
  Serve defaults.
- Roles and organizations: the Serve options describe the machine, so they're
  read and written in the main books (`inMain`) and changed only by admins of
  the main books (`requireServeAdmin`); `GET /node` reports `can_manage`. The
  share warning goes to every organization (`eachOrg`).
- 0.6.0 cleanup (`forgetApiFeatures`, once per organization): clears the old
  API settings from Ledger's settings store and the old dashboard items;
  migration 006 dropped the device, user and sync tables and old settings
  columns. The `charges` table (pre-0.6.0 billing) is kept as history; its
  journal entries stay in the books with their `charge:<id>` links.
- Ledger runs it in a Debian 13 container; the module itself installs and
  runs nothing (the service is sandboxed: no root, read-only system).
