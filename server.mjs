// Tailscale module for Ledger: publishes Ledger on the tailnet through the
// server's own tailscaled (Tailscale Serve, via its LocalAPI socket), syncs the
// tailnet's devices and users from the Tailscale API, raises dashboard alerts
// (expiring keys, offline machines, pending approvals, client updates) and
// records the monthly subscription as a balanced journal entry.

import http from "node:http";
import os from "node:os";

const API = "https://api.tailscale.com/api/v2";
const SERVE_PORTS = [443, 8443, 10000]; // the ports Tailscale Serve accepts for HTTPS
const SOCKET_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
const TARGET_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/;
const TIMEOUT_MS = 10_000;
const LINK = "/apps/tailscale";
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const KEY_RE = /^tskey-[A-Za-z0-9_-]{8,300}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const TAILNET_RE = /^[A-Za-z0-9._@-]{1,200}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Snapshot columns and their types for jsonb_to_recordset.
const DEVICE_COLS = {
	id: "text", name: "text", hostname: "text", os: "text", user_login: "text", addresses: "jsonb",
	client_version: "text", update_available: "boolean", authorized: "boolean", is_external: "boolean",
	tags: "jsonb", created: "timestamptz", last_seen: "timestamptz", expires: "timestamptz",
	key_expiry_disabled: "boolean", connected: "boolean",
};
const USER_COLS = {
	id: "text", login_name: "text", display_name: "text", type: "text", role: "text", status: "text",
	device_count: "int", last_seen: "timestamptz", connected: "boolean", created: "timestamptz",
};

const pad = (n) => String(n).padStart(2, "0");
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isRealDate = (s) => DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
// Tailscale uses 0001-01-01T00:00:00Z for "never".
const ts = (v) => (typeof v === "string" && v && !v.startsWith("0001-") ? v : null);
const str = (v) => (typeof v === "string" ? v : v == null ? null : String(v));
const strList = (v) => (Array.isArray(v) ? v.map(String) : []);
const listNames = (names, max = 8) =>
	names.slice(0, max).join(", ") + (names.length > max ? ` and ${names.length - max} more` : "");
const shortName = (n) => String(n).split(".")[0];

/** @param {any} ctx */
export default async function register(ctx) {
	const S = ctx.schema;
	const bad = (msg) => new ctx.HttpError(422, msg);
	/** @type {{ value: string, exp: number, clientId: string } | null} */
	let oauthToken = null;
	/** @type {Promise<any> | null} */
	let running = null;
	let lastBillingCheck = 0;

	const getSettings = async () => (await ctx.db.query(`SELECT * FROM ${S}.settings WHERE id`)).rows[0];
	const isConfigured = (s) =>
		s.auth_mode === "api_key" ? !!s.api_key : !!(s.oauth_client_id && s.oauth_client_secret);
	const hint = (v) => (v ? `••••${v.slice(-4)}` : null);

	// Settings as returned to the browser: secrets replaced by a hint.
	function publicSettings(s) {
		const { api_key, oauth_client_secret, id, ...rest } = s;
		return {
			...rest,
			api_key_set: !!api_key, api_key_hint: hint(api_key),
			oauth_client_secret_set: !!oauth_client_secret, oauth_client_secret_hint: hint(oauth_client_secret),
		};
	}

	// Run a dashboard call without letting a failure there break the caller.
	async function safe(fn) {
		try {
			return await fn();
		} catch (e) {
			ctx.log.warn("dashboard call failed", { error: String(e?.message ?? e) });
		}
	}

	// ---------------------------------------------------------------- Tailscale API

	async function authorization(s) {
		if (s.auth_mode === "api_key") {
			if (!s.api_key) throw bad("No Tailscale API key is configured");
			return `Bearer ${s.api_key}`;
		}
		if (!s.oauth_client_id || !s.oauth_client_secret) throw bad("OAuth client ID and secret are required");
		if (oauthToken && oauthToken.clientId === s.oauth_client_id && oauthToken.exp > Date.now() + 60_000) {
			return `Bearer ${oauthToken.value}`;
		}
		const r = await fetch(`${API}/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({
				client_id: s.oauth_client_id, client_secret: s.oauth_client_secret, grant_type: "client_credentials",
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!r.ok) throw new Error(`Tailscale rejected the OAuth client (HTTP ${r.status})`);
		const j = await r.json();
		if (typeof j.access_token !== "string") throw new Error("Tailscale OAuth response had no access_token");
		oauthToken = {
			value: j.access_token, clientId: s.oauth_client_id,
			exp: Date.now() + (Number(j.expires_in) || 3600) * 1000,
		};
		return `Bearer ${oauthToken.value}`;
	}

	async function tsGet(s, path) {
		const r = await fetch(`${API}/tailnet/${encodeURIComponent(s.tailnet)}${path}`, {
			headers: { Authorization: await authorization(s), Accept: "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!r.ok) {
			const detail = await r.json().then((j) => j?.message).catch(() => null);
			const err = new Error(`Tailscale ${path.split("?")[0]}: HTTP ${r.status}${detail ? ` – ${String(detail).slice(0, 200)}` : ""}`);
			err.status = r.status;
			throw err;
		}
		return r.json();
	}

	const toDevice = (d) => ({
		id: str(d.nodeId || d.id),
		name: str(d.name || d.hostname || d.nodeId || d.id),
		hostname: str(d.hostname),
		os: str(d.os),
		user_login: str(d.user),
		addresses: strList(d.addresses),
		client_version: str(d.clientVersion),
		update_available: d.updateAvailable === true,
		authorized: d.authorized !== false,
		is_external: d.isExternal === true,
		tags: strList(d.tags),
		created: ts(d.created),
		last_seen: ts(d.lastSeen),
		expires: d.keyExpiryDisabled ? null : ts(d.expires),
		key_expiry_disabled: d.keyExpiryDisabled === true,
		connected: typeof d.connectedToControl === "boolean" ? d.connectedToControl : null,
	});

	const toUser = (u) => ({
		id: str(u.id),
		login_name: str(u.loginName),
		display_name: str(u.displayName),
		type: str(u.type),
		role: str(u.role),
		status: str(u.status),
		device_count: Number.isSafeInteger(u.deviceCount) ? u.deviceCount : null,
		last_seen: ts(u.lastSeen),
		connected: typeof u.currentlyConnected === "boolean" ? u.currentlyConnected : null,
		created: ts(u.created),
	});

	// Replace a snapshot table with `rows` in one atomic statement.
	async function replaceSnapshot(table, cols, rows) {
		const names = Object.keys(cols);
		const t = `${S}.${table}`;
		const unique = [...new Map(rows.filter((r) => r.id).map((r) => [r.id, r])).values()];
		const sql = `
			WITH src AS (
				SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(${names.map((n) => `${n} ${cols[n]}`).join(", ")})
			), gone AS (
				DELETE FROM ${t} o WHERE NOT EXISTS (SELECT 1 FROM src WHERE src.id = o.id)
			), up AS (
				INSERT INTO ${t} (${names.join(", ")}, synced_at)
				SELECT ${names.join(", ")}, now() FROM src
				ON CONFLICT (id) DO UPDATE SET
					${names.filter((n) => n !== "id").map((n) => `${n} = EXCLUDED.${n}`).join(", ")},
					synced_at = EXCLUDED.synced_at
				RETURNING 1
			)
			SELECT count(*)::int AS n FROM up`;
		return (await ctx.db.query(sql, [JSON.stringify(unique)])).rows[0].n;
	}

	// ---------------------------------------------------------------- sync

	function sync(triggeredBy) {
		running ??= doSync(triggeredBy).finally(() => {
			running = null;
		});
		return running;
	}

	async function doSync(triggeredBy) {
		const s = await getSettings();
		if (!isConfigured(s)) throw bad("Tailscale credentials are not configured");
		const { rows: [run] } = await ctx.db.query(
			`INSERT INTO ${S}.syncs (triggered_by) VALUES ($1) RETURNING id`, [triggeredBy]);
		try {
			const dj = await tsGet(s, "/devices?fields=all");
			if (!Array.isArray(dj?.devices)) throw new Error("Unexpected response from Tailscale /devices");
			const deviceCount = await replaceSnapshot("devices", DEVICE_COLS, dj.devices.map(toDevice));

			// The users endpoint needs an extra scope; devices alone are still useful.
			let userCount = null, warning = null;
			try {
				const uj = await tsGet(s, "/users");
				if (!Array.isArray(uj?.users)) throw new Error("Unexpected response from Tailscale /users");
				userCount = await replaceSnapshot("users", USER_COLS, uj.users.map(toUser));
			} catch (e) {
				warning = `Users not synced: ${e.message}`;
			}

			const { rows: [done] } = await ctx.db.query(
				`UPDATE ${S}.syncs SET finished_at = now(), ok = true, warning = $2, device_count = $3, user_count = $4
				 WHERE id = $1 RETURNING *`, [run.id, warning, deviceCount, userCount]);
			await ctx.db.query(`DELETE FROM ${S}.syncs WHERE id < (SELECT max(id) - 200 FROM ${S}.syncs)`);
			ctx.log.info("tailscale sync ok", { devices: deviceCount, users: userCount, warning });
			await safe(() => ctx.dashboard.remove("sync-error", "notification"));
			await raiseAlerts(s);
			return done;
		} catch (e) {
			const message = String(e?.message ?? e).slice(0, 500);
			await ctx.db.query(
				`UPDATE ${S}.syncs SET finished_at = now(), ok = false, error = $2 WHERE id = $1`, [run.id, message]);
			ctx.log.warn("tailscale sync failed", { error: message });
			await safe(() => ctx.dashboard.notify({
				key: "sync-error", title: "Tailscale sync failed", body: message, level: "danger", link: LINK,
			}));
			throw new ctx.HttpError(502, message);
		}
	}

	// Post or clear one dashboard notification per kind of problem.
	async function alert(key, names, title, level) {
		if (!names.length) return safe(() => ctx.dashboard.remove(key, "notification"));
		return safe(() => ctx.dashboard.notify({ key, title, body: listNames(names), level, link: LINK }));
	}

	async function raiseAlerts(s) {
		const q = async (sql, p = []) => (await ctx.db.query(sql, p)).rows.map((r) => shortName(r.name));
		const expiring = await q(
			`SELECT name FROM ${S}.devices WHERE expires IS NOT NULL AND expires < now() + make_interval(days => $1)
			 ORDER BY expires`, [s.key_expiry_warn_days]);
		await alert("key-expiry", expiring,
			`${expiring.length} Tailscale device key${expiring.length === 1 ? "" : "s"} expire${expiring.length === 1 ? "s" : ""} within ${s.key_expiry_warn_days} days`,
			"warning");

		const offline = s.offline_warn_days > 0 ? await q(
			`SELECT name FROM ${S}.devices WHERE NOT is_external AND connected IS NOT TRUE
			   AND last_seen < now() - make_interval(days => $1) ORDER BY last_seen`, [s.offline_warn_days]) : [];
		await alert("offline", offline,
			`${offline.length} Tailscale device${offline.length === 1 ? "" : "s"} offline for over ${s.offline_warn_days} days`, "info");

		const updates = await q(`SELECT name FROM ${S}.devices WHERE update_available AND NOT is_external ORDER BY name`);
		await alert("updates", updates,
			`Tailscale update available on ${updates.length} device${updates.length === 1 ? "" : "s"}`, "info");

		const pending = [
			...(await q(`SELECT name FROM ${S}.devices WHERE NOT authorized ORDER BY name`)),
			...(await ctx.db.query(`SELECT coalesce(login_name, display_name, id) AS n FROM ${S}.users
				WHERE status = 'needs-approval' ORDER BY 1`)).rows.map((r) => r.n),
		];
		await alert("approval", pending,
			`${pending.length} Tailscale device${pending.length === 1 ? "" : "s"}/user${pending.length === 1 ? "" : "s"} awaiting approval`,
			"warning");
	}

	// ---------------------------------------------------------------- billing

	const billableSeats = async () =>
		(await ctx.db.query(
			`SELECT count(*) FILTER (WHERE type = 'member' AND status = 'active')::int AS seats, count(*)::int AS users
			 FROM ${S}.users`)).rows[0];

	// Put a "record this month's charge" to-do on the dashboard once bill_day has passed.
	async function checkBilling() {
		lastBillingCheck = Date.now();
		const s = await getSettings();
		if (!s.billing_enabled) return;
		const now = new Date();
		const period = localDate(now).slice(0, 7);
		const key = `charge-${period}`;
		const { rowCount } = await ctx.db.query(
			`SELECT 1 FROM ${S}.charges WHERE period = $1 AND status <> 'reversed'`, [period]);
		if (rowCount) return safe(() => ctx.dashboard.complete(key));
		if (now.getDate() < s.bill_day) return;
		const items = (await safe(() => ctx.dashboard.list({ kind: "todo" }))) ?? [];
		if (items.some((i) => i.key === key)) return;
		await safe(() => ctx.dashboard.todo({
			key, title: `Record Tailscale charge for ${period}`,
			body: "Post this month's Tailscale subscription from the Billing tab.",
			due: `${period}-${pad(s.bill_day)}`, link: LINK,
		}));
	}

	async function checkAccount(code, currency, types, label) {
		const a = await ctx.ledger.getAccount(code).catch(() => null);
		if (!a) throw bad(`${label} account ${code} does not exist`);
		if (!a.is_active) throw bad(`${label} account ${code} is inactive`);
		if (a.currency !== currency) throw bad(`${label} account ${code} is in ${a.currency}, not ${currency}`);
		if (!types.includes(a.type)) throw bad(`${label} account ${code} must be of type ${types.join(" or ")}`);
		return a;
	}

	// ---------------------------------------------------------------- validation

	function intField(v, name, min, max) {
		const n = (typeof v === "string" && /^\d+$/.test(v.trim())) || typeof v === "bigint" ? Number(v) : v;
		if (!Number.isSafeInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
		return n;
	}

	// undefined → keep, null/"" → clear, string → set.
	function secretField(v, current, name, re) {
		if (v === undefined) return current;
		if (v === null || v === "") return null;
		if (typeof v !== "string" || !re.test(v.trim())) throw bad(`${name} is not in the expected format`);
		return v.trim();
	}

	function accountField(v, name) {
		if (v === null || v === "" || v === undefined) return null;
		if (typeof v !== "string" || !CODE_RE.test(v)) throw bad(`${name} is not a valid account code`);
		return v;
	}

	// ---------------------------------------------------------------- routes

	ctx.route("GET", "/status", async () => {
		const s = await getSettings();
		const { rows: [counts] } = await ctx.db.query(`
			SELECT count(*)::int AS devices,
			       count(*) FILTER (WHERE connected)::int AS online,
			       count(*) FILTER (WHERE expires < now() + make_interval(days => $1))::int AS expiring,
			       count(*) FILTER (WHERE update_available AND NOT is_external)::int AS updates,
			       count(*) FILTER (WHERE NOT authorized)::int AS unauthorized
			FROM ${S}.devices`, [s.key_expiry_warn_days]);
		const { rows: [lastSync] } = await ctx.db.query(`SELECT * FROM ${S}.syncs ORDER BY id DESC LIMIT 1`);
		const { rows: [lastOk] } = await ctx.db.query(
			`SELECT finished_at FROM ${S}.syncs WHERE ok ORDER BY id DESC LIMIT 1`);
		const period = localDate().slice(0, 7);
		const { rows: [charge] } = await ctx.db.query(
			`SELECT * FROM ${S}.charges WHERE period = $1 AND status <> 'reversed'`, [period]);
		return {
			configured: isConfigured(s),
			syncing: !!running,
			settings: publicSettings(s),
			last_sync: lastSync ?? null,
			last_ok_sync_at: lastOk?.finished_at ?? null,
			counts: { ...counts, ...(await billableSeats()) },
			period,
			today: localDate(),
			period_charge: charge ?? null,
		};
	});

	ctx.route("POST", "/sync", async (req) => sync(req.user.username));

	ctx.route("GET", "/devices", async () =>
		(await ctx.db.query(`SELECT * FROM ${S}.devices ORDER BY lower(name)`)).rows);

	ctx.route("GET", "/users", async () =>
		(await ctx.db.query(`SELECT * FROM ${S}.users ORDER BY lower(coalesce(display_name, login_name, id))`)).rows);

	ctx.route("GET", "/syncs", async () =>
		(await ctx.db.query(`SELECT * FROM ${S}.syncs ORDER BY id DESC LIMIT 20`)).rows);

	ctx.route("GET", "/accounts", async () =>
		(await ctx.ledger.listAccounts()).map(({ code, name, type, currency, is_active }) =>
			({ code, name, type, currency, is_active })));

	ctx.route("GET", "/settings", async () => publicSettings(await getSettings()));

	ctx.route("PUT", "/settings", async (req) => {
		const b = req.body;
		if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("Send the settings as a JSON object");
		const cur = await getSettings();
		const pick = (k) => (b[k] === undefined ? cur[k] : b[k]);

		const tailnet = String(pick("tailnet") ?? "").trim() || "-";
		if (!TAILNET_RE.test(tailnet)) throw bad("tailnet must be '-' or your tailnet name (letters, digits, . _ @ -)");
		const auth_mode = pick("auth_mode");
		if (!["api_key", "oauth"].includes(auth_mode)) throw bad("auth_mode must be api_key or oauth");
		const api_key = secretField(b.api_key, cur.api_key, "API key", KEY_RE);
		const oauth_client_secret = secretField(b.oauth_client_secret, cur.oauth_client_secret, "OAuth client secret", KEY_RE);
		const oauth_client_id = secretField(b.oauth_client_id, cur.oauth_client_id, "OAuth client ID", CLIENT_ID_RE);

		const sync_minutes = intField(pick("sync_minutes"), "Sync interval", 0, 1440);
		if (sync_minutes > 0 && sync_minutes < 5) throw bad("Sync interval must be 0 (off) or at least 5 minutes");
		const key_expiry_warn_days = intField(pick("key_expiry_warn_days"), "Key expiry warning", 1, 90);
		const offline_warn_days = intField(pick("offline_warn_days"), "Offline warning", 0, 365);

		const billing_enabled = pick("billing_enabled");
		if (typeof billing_enabled !== "boolean") throw bad("billing_enabled must be true or false");
		const price_per_user_cents = intField(pick("price_per_user_cents"), "Price per user (cents)", 0, 10_000_000);
		const base_fee_cents = intField(pick("base_fee_cents"), "Base fee (cents)", 0, 10_000_000);
		const currency = pick("currency");
		if (!["CAD", "USD"].includes(currency)) throw bad("currency must be CAD or USD");
		const expense_account = accountField(pick("expense_account"), "Expense account");
		const payment_account = accountField(pick("payment_account"), "Payment account");
		const bill_day = intField(pick("bill_day"), "Billing day", 1, 28);

		if (billing_enabled) {
			if (!expense_account || !payment_account) throw bad("Choose an expense account and a payment account to enable billing");
			if (expense_account === payment_account) throw bad("Expense and payment accounts must differ");
			await checkAccount(expense_account, currency, ["expense"], "Expense");
			await checkAccount(payment_account, currency, ["asset", "liability"], "Payment");
		}

		const { rows: [saved] } = await ctx.db.query(
			`UPDATE ${S}.settings SET tailnet = $1, auth_mode = $2, api_key = $3, oauth_client_id = $4,
				oauth_client_secret = $5, sync_minutes = $6, key_expiry_warn_days = $7, offline_warn_days = $8,
				billing_enabled = $9, price_per_user_cents = $10, base_fee_cents = $11, currency = $12,
				expense_account = $13, payment_account = $14, bill_day = $15, updated_by = $16, updated_at = now()
			 WHERE id RETURNING *`,
			[tailnet, auth_mode, api_key, oauth_client_id, oauth_client_secret, sync_minutes, key_expiry_warn_days,
				offline_warn_days, billing_enabled, price_per_user_cents, base_fee_cents, currency, expense_account,
				payment_account, bill_day, req.user.username]);
		oauthToken = null;
		ctx.log.info("tailscale settings updated", { by: req.user.username, auth_mode, billing_enabled });
		checkBilling().catch((e) => ctx.log.warn("billing check failed", { error: e.message }));
		return publicSettings(saved);
	});

	ctx.route("GET", "/charges", async () =>
		(await ctx.db.query(`SELECT * FROM ${S}.charges ORDER BY period DESC, id DESC LIMIT 120`)).rows);

	ctx.route("POST", "/charges", async (req) => {
		const b = req.body ?? {};
		const s = await getSettings();
		if (!s.billing_enabled) throw bad("Billing is turned off in the Tailscale settings");
		if (!s.expense_account || !s.payment_account) throw bad("Choose expense and payment accounts in settings first");

		const period = b.period ?? localDate().slice(0, 7);
		if (typeof period !== "string" || !PERIOD_RE.test(period)) throw bad("period must be YYYY-MM");
		const entry_date = b.entry_date ?? localDate();
		if (typeof entry_date !== "string" || !isRealDate(entry_date)) throw bad("entry_date must be a valid YYYY-MM-DD date");
		let seats;
		if (b.seats === undefined || b.seats === null || b.seats === "") {
			const c = await billableSeats();
			if (!c.users) throw bad("No user data yet: sync with Tailscale or enter the number of seats");
			seats = c.seats;
		} else {
			seats = intField(b.seats, "seats", 0, 100_000);
		}
		const memo = b.memo == null || b.memo === "" ? null : b.memo;
		if (memo !== null && (typeof memo !== "string" || memo.trim().length > 200)) throw bad("memo must be text up to 200 characters");

		const total = BigInt(seats) * BigInt(s.price_per_user_cents) + BigInt(s.base_fee_cents);
		if (total <= 0n) throw bad("The charge comes to 0.00; nothing to post");
		await checkAccount(s.expense_account, s.currency, ["expense"], "Expense");
		await checkAccount(s.payment_account, s.currency, ["asset", "liability"], "Payment");

		// Reserve the month first so two clicks can't post twice.
		let charge;
		try {
			({ rows: [charge] } = await ctx.db.query(
				`INSERT INTO ${S}.charges (period, entry_date, seats, unit_price_cents, base_fee_cents, total_cents,
					currency, expense_account, payment_account, memo, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
				[period, entry_date, seats, s.price_per_user_cents, s.base_fee_cents, total, s.currency,
					s.expense_account, s.payment_account, memo?.trim() ?? null, req.user.username]));
		} catch (e) {
			if (e?.code === "23505") throw new ctx.HttpError(409, `A Tailscale charge for ${period} is already recorded`);
			throw e;
		}

		let entry;
		try {
			const lineMemo = `${seats} user${seats === 1 ? "" : "s"}`;
			entry = await ctx.ledger.createJournalEntry({
				entry_date,
				description: `Tailscale subscription ${period}`,
				reference: `tailscale:${period}`,
				lines: [
					{ account_code: s.expense_account, debit_cents: total, memo: memo?.trim() || lineMemo },
					{ account_code: s.payment_account, credit_cents: total, memo: lineMemo },
				],
			}, req.user);
		} catch (e) {
			await ctx.db.query(`DELETE FROM ${S}.charges WHERE id = $1 AND status = 'pending'`, [charge.id]);
			throw e;
		}
		const { rows: [posted] } = await ctx.db.query(
			`UPDATE ${S}.charges SET status = 'posted', entry_id = $2 WHERE id = $1 RETURNING *`, [charge.id, entry.id]);
		ctx.log.info("tailscale charge posted", { period, entry_id: entry.id, by: req.user.username });
		await safe(() => ctx.dashboard.complete(`charge-${period}`));
		return ctx.response(201, posted);
	});

	ctx.route("POST", "/charges/:id/reverse", async (req) => {
		if (!/^\d{1,18}$/.test(req.params.id)) throw new ctx.HttpError(404, "Charge not found");
		const { rows: [c] } = await ctx.db.query(
			`UPDATE ${S}.charges SET status = 'reversing' WHERE id = $1 AND status = 'posted' RETURNING *`, [req.params.id]);
		if (!c) throw new ctx.HttpError(409, "Only a posted charge can be reversed");
		let rev;
		try {
			rev = await ctx.ledger.reverseJournalEntry(c.entry_id, {
				entry_date: localDate(), description: `Reverse Tailscale subscription ${c.period}`,
			}, req.user);
		} catch (e) {
			await ctx.db.query(`UPDATE ${S}.charges SET status = 'posted' WHERE id = $1`, [c.id]);
			throw e;
		}
		const { rows: [done] } = await ctx.db.query(
			`UPDATE ${S}.charges SET status = 'reversed', reversal_entry_id = $2 WHERE id = $1 RETURNING *`, [c.id, rev.id]);
		ctx.log.info("tailscale charge reversed", { period: c.period, entry_id: rev.id, by: req.user.username });
		checkBilling().catch((e) => ctx.log.warn("billing check failed", { error: e.message }));
		return done;
	});

	// A charge stuck in 'pending' means Ledger stopped mid-post. Check the journal for
	// reference tailscale:<period> before discarding.
	ctx.route("DELETE", "/charges/:id", async (req) => {
		if (!/^\d{1,18}$/.test(req.params.id)) throw new ctx.HttpError(404, "Charge not found");
		const { rowCount } = await ctx.db.query(
			`DELETE FROM ${S}.charges WHERE id = $1 AND status = 'pending' AND created_at < now() - interval '1 minute'`,
			[req.params.id]);
		if (!rowCount) throw new ctx.HttpError(409, "Only a charge stuck in 'pending' for over a minute can be discarded");
	});

	// ---------------------------------------------------------------- tailnet access (local tailscaled)

	let processUser = "the Ledger service user";
	try {
		processUser = os.userInfo().username;
	} catch {}
	const defaultTarget = `http://127.0.0.1:${/^\d{1,5}$/.test(process.env.PORT ?? "") ? process.env.PORT : 3000}`;
	const targetOf = (s) => s.serve_target ?? defaultTarget;
	const operatorHint = () => `run  sudo tailscale set --operator=${processUser}  on the Ledger server`;

	// One request to tailscaled's LocalAPI over its unix socket.
	function localApi(socketPath, method, path, body, headers = {}) {
		return new Promise((resolve, reject) => {
			const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
			const req = http.request({
				socketPath, method, path: `/localapi/v0${path}`,
				headers: {
					Host: "local-tailscaled.sock",
					...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
					...headers,
				},
			}, (res) => {
				const chunks = [];
				let size = 0;
				res.on("data", (c) => {
					size += c.length;
					if (size > 4 * 1024 * 1024) req.destroy(new Error("tailscaled response too large"));
					else chunks.push(c);
				});
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
				res.on("error", reject);
			});
			req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("tailscaled did not answer within 10 s")));
			req.on("error", (e) => {
				if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
					reject(bad(`Tailscale isn't running on the Ledger server (no tailscaled at ${socketPath}). Install Tailscale there and run  sudo tailscale up`));
				} else if (e.code === "EACCES") {
					reject(bad(`Ledger may not use ${socketPath}: ${operatorHint()}`));
				} else reject(e);
			});
			if (data) req.write(data);
			req.end();
		});
	}

	async function localJson(s, method, path, body, headers) {
		const r = await localApi(s.socket_path, method, path, body, headers);
		if (r.status === 403) throw bad(`tailscaled refused (${r.text.trim().slice(0, 150) || "access denied"}): ${operatorHint()}`);
		if (r.status === 412) throw new ctx.HttpError(409, "The Serve configuration changed meanwhile; try again");
		if (r.status < 200 || r.status > 299) {
			let msg = r.text.trim();
			try {
				msg = JSON.parse(msg).error ?? msg;
			} catch {}
			throw new Error(`tailscaled ${path.split("?")[0]}: ${String(msg).slice(0, 200) || `HTTP ${r.status}`}`);
		}
		return { body: r.text.trim() && r.text.trim() !== "null" ? JSON.parse(r.text) : null, etag: r.headers.etag };
	}

	const nodeStatus = async (s) => (await localJson(s, "GET", "/status?peers=false")).body;
	const selfDns = (st) => String(st?.Self?.DNSName ?? "").replace(/\.$/, "");
	const serveUrl = (dns, port) => `https://${dns}${port === 443 ? "" : `:${port}`}/`;

	// Remove every "/" handler that proxies to `target`, then drop emptied entries.
	function withoutOurs(cfg, target) {
		const web = { ...cfg.Web };
		for (const [hp, w] of Object.entries(web)) {
			if (w?.Handlers?.["/"]?.Proxy !== target) continue;
			const { "/": _, ...rest } = w.Handlers;
			if (Object.keys(rest).length) web[hp] = { ...w, Handlers: rest };
			else delete web[hp];
		}
		const usedPorts = new Set(Object.keys(web).map((hp) => hp.slice(hp.lastIndexOf(":") + 1)));
		const tcp = Object.fromEntries(Object.entries(cfg.TCP ?? {}).filter(([p, v]) => !v?.HTTPS || usedPorts.has(p)));
		const funnel = Object.fromEntries(Object.entries(cfg.AllowFunnel ?? {}).filter(([hp]) => hp in web));
		return { ...cfg, Web: web, TCP: tcp, AllowFunnel: funnel };
	}

	async function nodeInfo(s) {
		const target = targetOf(s);
		const base = {
			socket_path: s.socket_path, process_user: processUser, target, target_is_default: !s.serve_target,
			port: s.serve_port, wanted: s.serve_wanted,
		};
		let st;
		try {
			st = await nodeStatus(s);
		} catch (e) {
			return { ...base, reachable: false, error: e.message };
		}
		const dns = selfDns(st);
		const info = {
			...base, reachable: true,
			backend_state: st.BackendState ?? null,
			auth_url: st.AuthURL || null,
			version: st.Version ?? null,
			tailnet: st.CurrentTailnet?.Name ?? null,
			magic_dns: st.CurrentTailnet?.MagicDNSEnabled ?? null,
			https_enabled: Array.isArray(st.CertDomains) && st.CertDomains.length > 0,
			self: st.Self ? { host_name: st.Self.HostName, dns_name: dns, ips: st.Self.TailscaleIPs ?? [], id: st.Self.ID } : null,
			serving: false, url: null, conflict: null, funnel: false,
		};
		if (info.backend_state !== "Running" || !dns) return info;
		try {
			const cfg = (await localJson(s, "GET", "/serve-config")).body ?? {};
			const hp = `${dns}:${s.serve_port}`;
			const h = cfg.Web?.[hp]?.Handlers?.["/"];
			info.serving = h?.Proxy === target;
			info.url = info.serving ? serveUrl(dns, s.serve_port) : null;
			info.funnel = info.serving && !!cfg.AllowFunnel?.[hp];
			if (h && !info.serving) info.conflict = `${serveUrl(dns, s.serve_port)} already serves ${h.Proxy ?? h.Path ?? "something else"}`;
			else if (cfg.TCP?.[s.serve_port] && !cfg.TCP[s.serve_port].HTTPS) info.conflict = `Port ${s.serve_port} is used for TCP forwarding`;
		} catch (e) {
			info.serve_error = e.message; // reading the Serve config can need operator rights
		}
		return info;
	}

	// Alert on the dashboard when Ledger was published but no longer is.
	async function checkServe() {
		const s = await getSettings();
		if (!s.serve_wanted) return safe(() => ctx.dashboard.remove("tailnet-access", "notification"));
		const n = await nodeInfo(s);
		if (n.serving) return safe(() => ctx.dashboard.remove("tailnet-access", "notification"));
		const why = !n.reachable ? n.error
			: n.backend_state !== "Running" ? `Tailscale on the server is ${n.backend_state}.`
			: n.serve_error ?? n.conflict ?? "The Tailscale Serve entry for Ledger was removed.";
		await safe(() => ctx.dashboard.notify({
			key: "tailnet-access", title: "Ledger isn't reachable on your tailnet", body: why, level: "warning", link: LINK,
		}));
	}

	ctx.route("GET", "/node", async () => nodeInfo(await getSettings()));

	ctx.route("PUT", "/node/settings", async (req) => {
		const b = req.body ?? {};
		const cur = await getSettings();
		const socket_path = b.socket_path === undefined ? cur.socket_path : b.socket_path;
		if (typeof socket_path !== "string" || !SOCKET_RE.test(socket_path)) throw bad("Socket path must be an absolute path");
		let serve_target = b.serve_target === undefined ? cur.serve_target : b.serve_target || null;
		if (serve_target !== null) {
			const m = typeof serve_target === "string" && TARGET_RE.exec(serve_target.trim());
			if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw bad("Ledger address must look like http://127.0.0.1:3000 (this server only)");
			serve_target = serve_target.trim();
		}
		const serve_port = b.serve_port === undefined ? cur.serve_port : Number(b.serve_port);
		if (!SERVE_PORTS.includes(serve_port)) throw bad(`HTTPS port must be one of ${SERVE_PORTS.join(", ")}`);
		const changesServe = targetOf(cur) !== (serve_target ?? defaultTarget) || serve_port !== cur.serve_port;
		if (changesServe && (await nodeInfo(cur)).serving) throw new ctx.HttpError(409, "Stop sharing Ledger on the tailnet before changing its address or port");
		await ctx.db.query(
			`UPDATE ${S}.settings SET socket_path = $1, serve_target = $2, serve_port = $3, updated_by = $4, updated_at = now() WHERE id`,
			[socket_path, serve_target, serve_port, req.user.username]);
		return nodeInfo(await getSettings());
	});

	ctx.route("POST", "/node/serve", async (req) => {
		const s = await getSettings();
		const target = targetOf(s);
		const st = await nodeStatus(s);
		if (st.BackendState !== "Running") throw bad(`Tailscale on the Ledger server is not connected (${st.BackendState}). Log it in first`);
		const dns = selfDns(st);
		if (!dns) throw bad("This machine has no MagicDNS name: turn on MagicDNS in the Tailscale admin console (DNS page)");
		if (!st.CertDomains?.length) throw bad("Turn on HTTPS Certificates in the Tailscale admin console (DNS page), then try again");
		try {
			await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
		} catch {
			throw bad(`Nothing answers at ${target}. Set the address Ledger listens on under "Ledger address"`);
		}

		const { body, etag } = await localJson(s, "GET", "/serve-config");
		const cfg = body ?? {};
		const hp = `${dns}:${s.serve_port}`;
		const existing = cfg.Web?.[hp]?.Handlers?.["/"];
		if (existing && existing.Proxy !== target) {
			throw new ctx.HttpError(409, `${serveUrl(dns, s.serve_port)} already serves ${existing.Proxy ?? existing.Path ?? "something else"}. Pick another HTTPS port`);
		}
		const tcp = cfg.TCP?.[s.serve_port];
		if (tcp && !tcp.HTTPS) throw new ctx.HttpError(409, `Port ${s.serve_port} is used for TCP forwarding. Pick another HTTPS port`);
		const next = {
			...cfg,
			TCP: { ...cfg.TCP, [s.serve_port]: { ...tcp, HTTPS: true } },
			Web: { ...cfg.Web, [hp]: { ...cfg.Web?.[hp], Handlers: { ...cfg.Web?.[hp]?.Handlers, "/": { Proxy: target } } } },
		};
		await localJson(s, "POST", "/serve-config", next, etag ? { "If-Match": etag } : {});
		await ctx.db.query(`UPDATE ${S}.settings SET serve_wanted = true WHERE id`);
		ctx.log.info("ledger published on tailnet", { url: serveUrl(dns, s.serve_port), target, by: req.user.username });
		await safe(() => ctx.dashboard.remove("tailnet-access", "notification"));
		return nodeInfo(await getSettings());
	});

	ctx.route("DELETE", "/node/serve", async (req) => {
		const s = await getSettings();
		const { body, etag } = await localJson(s, "GET", "/serve-config");
		if (body) await localJson(s, "POST", "/serve-config", withoutOurs(body, targetOf(s)), etag ? { "If-Match": etag } : {});
		await ctx.db.query(`UPDATE ${S}.settings SET serve_wanted = false WHERE id`);
		ctx.log.info("ledger unpublished from tailnet", { by: req.user.username });
		await safe(() => ctx.dashboard.remove("tailnet-access", "notification"));
		return nodeInfo(await getSettings());
	});

	// Start an interactive login and hand back the URL to approve this machine.
	ctx.route("POST", "/node/login", async () => {
		const s = await getSettings();
		await localJson(s, "POST", "/login-interactive");
		for (let i = 0; i < 20; i++) {
			const st = await nodeStatus(s);
			if (st.AuthURL || st.BackendState === "Running") return { auth_url: st.AuthURL || null, backend_state: st.BackendState };
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new ctx.HttpError(504, "tailscaled did not produce a login link; run  sudo tailscale up  on the server instead");
	});

	// ---------------------------------------------------------------- background

	async function tick() {
		const s = await getSettings();
		if (isConfigured(s) && s.sync_minutes > 0 && !running) {
			const { rows: [due] } = await ctx.db.query(
				`SELECT coalesce(max(started_at) < now() - make_interval(mins => $1), true) AS due FROM ${S}.syncs`,
				[s.sync_minutes]);
			if (due.due) await sync("auto").catch(() => {}); // failure is logged and shown on the dashboard
		}
		if (Date.now() - lastBillingCheck > 3_600_000) await checkBilling();
		if (s.serve_wanted) await checkServe();
	}
	const runTick = () => tick().catch((e) => ctx.log.error("tailscale background check failed", { error: e.message }));
	setTimeout(runTick, 5_000).unref();
	setInterval(runTick, 60_000).unref();
}
