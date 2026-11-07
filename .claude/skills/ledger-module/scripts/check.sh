#!/bin/sh
# Runs Ledger's module checker on this repository: validates the manifest the
# way Ledger does, then (with TEST_DATABASE_URL) loads the module into a real
# Ledger on a scratch database and calls its routes.
#
#   sh .claude/skills/ledger-module/scripts/check.sh [--serve 8098]
#
# Needs a Ledger checkout: $LEDGER_DIR, a sibling directory (../Accounting,
# ../Bookeeping, ../ledger), or it shallow-clones mastifdogo/Bookeeping.
set -eu
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
checker=.claude/skills/ledger-module/scripts/check-module.ts
ledger=${LEDGER_DIR:-}
if [ -z "$ledger" ]; then
	for d in "$repo/../Accounting" "$repo/../Bookeeping" "$repo/../ledger" "$repo/../../Accounting" "${TMPDIR:-/tmp}/ledger-for-modules"; do
		if [ -f "$d/$checker" ]; then
			ledger=$(cd "$d" && pwd)
			break
		fi
	done
fi
if [ -z "$ledger" ]; then
	ledger="${TMPDIR:-/tmp}/ledger-for-modules"
	echo "Cloning Ledger into $ledger (set LEDGER_DIR to use another checkout)" >&2
	git clone --quiet --depth 1 https://github.com/mastifdogo/Bookeeping "$ledger"
fi
[ -f "$ledger/$checker" ] || { echo "$ledger has no $checker; update that Ledger checkout" >&2; exit 2; }
[ -d "$ledger/backend/node_modules" ] || (cd "$ledger/backend" && npm ci --silent)
exec node "$ledger/$checker" "$repo" "$@"
