// Tailscale module for Ledger: publishes Ledger on the tailnet through the
// server's own tailscaled (Tailscale Serve, via its LocalAPI socket), syncs the
// tailnet's devices and users from the Tailscale API, raises dashboard alerts
// (expiring keys, offline machines, pending approvals, client updates) and
// records the monthly subscription as a balanced journal entry.
//
// Configuration lives in Ledger's settings form for this module (manifest
// "settings"), except the Serve options on the Access tab, which go with the
// share/stop actions and are kept in mod_tailscale.settings of the main books:
// they describe this machine, not an organization, so only an admin of the
// main books may change them.
//
// Organizations (Ledger 0.11.1): every organization has its own copy of the
// module's tables and its own settings, so it has its own Tailscale
// credentials, sync, alerts and billing. Background work visits each one.

import http from "node:http";
import os from "node:os";
import {
	SERVE_PORTS, REDIRECT_SINCE, ServeConflict, centsToText, describeServe, hostFor, httpProbe, isRealDate,
	listNames, localDate, normalizeTarget, ownListeners, pad, serveUrl, shortName, toCents, versionAtLeast,
	withLedger, withoutLedger,
} from "./lib.mjs";

const API = "https://api.tailscale.com/api/v2";
const SOCKET_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
const TIMEOUT_MS = 10_000;
const LINK = "/apps/tailscale";
const SETTINGS_LINK = "Settings → Tailscale";
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const KEY_RE = /^tskey-[A-Za-z0-9_-]{8,300}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const TAILNET_RE = /^[A-Za-z0-9._@-]{1,200}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

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

// Tailscale uses 0001-01-01T00:00:00Z for "never".
const ts = (v) => (typeof v === "string" && v && !v.startsWith("0001-") ? v : null);
const str = (v) => (typeof v === "string" ? v : v == null ? null : String(v));
const strList = (v) => (Array.isArray(v) ? v.map(String) : []);
const wholeNumber = (v, def, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : def);

/** @param {any} ctx */
export default async function register(ctx) {
	const S = ctx.schema;
	const bad = (msg) => new ctx.HttpError(422, msg);
	const route = ctx.route.bind(ctx);
	ctx = Object.create(ctx, {
		route: {
			// Unexpected errors keep their cause instead of Ledger's bare "internal server error".
			value: (method, path, handler) => route(method, path, async (req) => {
				try {
					return await handler(req);
				} catch (e) {
					if (e instanceof ctx.HttpError || e?.status || e?.statusCode) throw e; // ours, or Ledger's own 4xx
					ctx.log.error("tailscale module error", { route: `${method} ${path}`, error: String(e?.stack ?? e) });
					throw new ctx.HttpError(500, `Tailscale module error: ${String(e?.message ?? e).slice(0, 300)}`);
				}
			}),
		},
	});
	// Sharing Ledger on the tailnet exposes the whole server: main-books admins only.
	const canManageServe = async (req) => req.user.role === "admin" && (await currentOrgId()) === 1;
	const requireServeAdmin = async (req, what) => {
		if (req.user.role !== "admin") throw new ctx.HttpError(403, `Only an admin can ${what}`);
		if ((await currentOrgId()) !== 1) throw new ctx.HttpError(403, `Switch to the main books to ${what}`);
	};
	/** OAuth access tokens by client id. @type {Map<string, { value: string, exp: number }>} */
	const oauthTokens = new Map();
	/** The sync in progress per organization id. @type {Map<number, Promise<any>>} */
	const running = new Map();
	let lastBillingCheck = 0;

	// The organization the caller works in (1 = main books, also for background work).
	const currentOrgId = async () => (ctx.orgs ? (await ctx.orgs.current()).id : 1);

	// Run fn in the main books, from whichever organization we're in.
	async function inMain(fn) {
		if ((await currentOrgId()) === 1) return fn();
		let out, failure, ran = false;
		await ctx.orgs.forEach(async (org) => {
			if (org.id !== 1) return;
			ran = true;
			try {
				out = await fn();
			} catch (e) {
				failure = e;
			}
		});
		if (failure) throw failure;
		if (!ran) throw new Error("the main books aren't available");
		return out;
	}

	// Run fn once per organization; one organization failing doesn't stop the rest.
	async function eachOrg(what, fn) {
		const run = async (org) => {
			try {
				await fn(org);
			} catch (e) {
				ctx.log.error(`tailscale ${what} failed`, { organization: org.id, error: String(e?.message ?? e) });
			}
		};
		if (ctx.orgs) await ctx.orgs.forEach(run);
		else await run({ id: 1 });
	}

	// Run a dashboard call without letting a failure there break the caller.
	async function safe(fn) {
		try {
			return await fn();
		} catch (e) {
			ctx.log.warn("dashboard call failed", { error: String(e?.message ?? e) });
		}
	}

	// ---------------------------------------------------------------- settings

	/**
	 * Everything the module is configured with: the values from Ledger's
	 * settings form, made safe to use, plus the Serve options. `problems` says
	 * what in the form needs fixing.
	 */
	async function getSettings() {
		const [v, { rows: [local] }] = await Promise.all([
			ctx.settings.get(),
			inMain(() => ctx.db.query(`SELECT socket_path, serve_target, serve_port, serve_http, serve_wanted FROM ${S}.settings WHERE id`)),
		]);
		const problems = [];
		const text = (k) => (typeof v[k] === "string" ? v[k].trim() : "");
		let tailnet = text("tailnet") || "-";
		if (!TAILNET_RE.test(tailnet)) {
			problems.push(`Tailnet "${tailnet.slice(0, 60)}" isn't a tailnet name: use "-" for the credentials' own tailnet`);
			tailnet = "-";
		}
		const s = {
			...local,
			tailnet,
			auth_mode: v.auth_mode === "api_key" ? "api_key" : "oauth",
			api_key: text("api_key") || null,
			oauth_client_id: text("oauth_client_id") || null,
			oauth_client_secret: text("oauth_client_secret") || null,
			sync_minutes: wholeNumber(v.sync_minutes, 60, 0, 1440),
			key_expiry_warn_days: wholeNumber(v.key_expiry_warn_days, 14, 1, 90),
			offline_warn_days: wholeNumber(v.offline_warn_days, 30, 0, 365),
			billing_enabled: v.billing_enabled === true,
			price_per_user_cents: toCents(text("price_per_user") || "0"),
			base_fee_cents: toCents(text("base_fee") || "0"),
			currency: v.currency === "CAD" ? "CAD" : "USD",
			expense_account: text("expense_account") || null,
			payment_account: text("payment_account") || null,
			bill_day: wholeNumber(v.bill_day, 1, 1, 28),
			problems,
		};
		if (s.sync_minutes > 0 && s.sync_minutes < 5) s.sync_minutes = 5;
		if (s.auth_mode === "api_key" && s.api_key && !KEY_RE.test(s.api_key)) {
			problems.push("The API access token doesn't look like a Tailscale key (tskey-api-…)");
		}
		if (s.auth_mode === "oauth" && s.oauth_client_secret && !KEY_RE.test(s.oauth_client_secret)) {
			problems.push("The OAuth client secret doesn't look like a Tailscale key (tskey-client-…)");
		}
		if (s.oauth_client_id && !CLIENT_ID_RE.test(s.oauth_client_id)) problems.push("The OAuth client ID has unexpected characters");
		if (s.price_per_user_cents === null) problems.push(`Price per user "${text("price_per_user")}" isn't an amount like 6.00`);
		if (s.base_fee_cents === null) problems.push(`Flat fee "${text("base_fee")}" isn't an amount like 0.00`);
		return s;
	}

	const isConfigured = (s) =>
		s.auth_mode === "api_key" ? !!s.api_key : !!(s.oauth_client_id && s.oauth_client_secret);

	// Why billing can't post right now, or [] when it can.
	async function billingProblems(s) {
		if (!s.billing_enabled) return [];
		const out = [];
		if (s.price_per_user_cents === null || s.base_fee_cents === null) out.push("Fix the prices");
		for (const [code, types, label] of [
			[s.expense_account, ["expense"], "Expense"],
			[s.payment_account, ["asset", "liability"], "Payment"],
		]) {
			if (!code) out.push(`Set the ${label.toLowerCase()} account`);
			else if (!CODE_RE.test(code)) out.push(`${label} account "${code.slice(0, 40)}" isn't an account code`);
			else await checkAccount(code, s.currency, types, label).catch((e) => out.push(e.message));
		}
		if (s.expense_account && s.expense_account === s.payment_account) out.push("Expense and payment accounts must differ");
		return out;
	}

	async function checkAccount(code, currency, types, label) {
		const a = await ctx.ledger.getAccount(code).catch(() => null);
		if (!a) throw bad(`${label} account ${code} does not exist`);
		if (!a.is_active) throw bad(`${label} account ${code} is inactive`);
		if (a.currency !== currency) throw bad(`${label} account ${code} is in ${a.currency}, not ${currency}`);
		if (!types.includes(a.type)) throw bad(`${label} account ${code} must be of type ${types.join(" or ")}`);
		return a;
	}

	// Before 0.1.0 the module kept its configuration in its own table; copy it
	// into Ledger's settings form once, then forget the secrets kept there.
	async function moveOldSettings() {
		const { rows: [old] } = await ctx.db.query(`SELECT * FROM ${S}.settings WHERE id AND NOT moved_to_ledger_settings`);
		if (!old) return;
		const hadCredentials = !!(old.api_key || old.oauth_client_id || old.oauth_client_secret);
		const values = {
			tailnet: old.tailnet,
			auth_mode: hadCredentials ? old.auth_mode : undefined,
			api_key: old.api_key ?? undefined,
			oauth_client_id: old.oauth_client_id ?? undefined,
			oauth_client_secret: old.oauth_client_secret ?? undefined,
			sync_minutes: old.sync_minutes,
			key_expiry_warn_days: old.key_expiry_warn_days,
			offline_warn_days: old.offline_warn_days,
			billing_enabled: old.billing_enabled,
			price_per_user: centsToText(old.price_per_user_cents),
			base_fee: centsToText(old.base_fee_cents),
			currency: old.currency,
			expense_account: old.expense_account ?? undefined,
			payment_account: old.payment_account ?? undefined,
			bill_day: old.bill_day,
		};
		// Only what someone set: the old table's defaults would overwrite the form's values.
		const oldDefaults = {
			tailnet: "-", sync_minutes: 60, key_expiry_warn_days: 14, offline_warn_days: 30, billing_enabled: false,
			price_per_user: "6.00", base_fee: "0.00", currency: "USD", bill_day: 1,
		};
		for (const k of Object.keys(values)) if (values[k] === undefined || values[k] === oldDefaults[k]) delete values[k];
		await ctx.settings.set(values);
		await ctx.db.query(
			`UPDATE ${S}.settings SET moved_to_ledger_settings = true, api_key = NULL, oauth_client_secret = NULL WHERE id`);
		ctx.log.info("tailscale settings moved to Ledger's settings form", { credentials: hadCredentials });
	}
	try {
		await moveOldSettings();
	} catch (e) {
		ctx.log.error("could not move tailscale settings; will retry at next start", { error: String(e?.message ?? e) });
	}

	// Saving the form (this runs inside the organization that saved it): use new
	// credentials right away, and recheck billing there.
	ctx.settings.onChange(async () => {
		oauthTokens.clear();
		try {
			const s = await getSettings();
			if (isConfigured(s)) await sync("settings").catch(() => {}); // failure is shown on the dashboard
			await checkBillingHere(s);
		} catch (e) {
			ctx.log.warn("tailscale settings change follow-up failed", { error: String(e?.message ?? e) });
		}
	});

	// ---------------------------------------------------------------- Tailscale API

	async function authorization(s) {
		if (s.auth_mode === "api_key") {
			if (!s.api_key) throw new ctx.HttpError(409, `Add a Tailscale API access token under ${SETTINGS_LINK}`);
			return `Bearer ${s.api_key}`;
		}
		if (!s.oauth_client_id || !s.oauth_client_secret) {
			throw new ctx.HttpError(409, `Add the Tailscale OAuth client ID and secret under ${SETTINGS_LINK}`);
		}
		const cached = oauthTokens.get(s.oauth_client_id);
		if (cached && cached.exp > Date.now() + 60_000) return `Bearer ${cached.value}`;
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
		oauthTokens.set(s.oauth_client_id, { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
		return `Bearer ${j.access_token}`;
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

	// Sync the current organization (the request's, or the one eachOrg visits).
	async function sync(triggeredBy) {
		const org = await currentOrgId();
		if (!running.has(org)) running.set(org, doSync(triggeredBy).finally(() => running.delete(org)));
		return running.get(org);
	}

	async function doSync(triggeredBy) {
		const s = await getSettings();
		if (!isConfigured(s)) throw new ctx.HttpError(409, `Add Tailscale API credentials under ${SETTINGS_LINK}`);
		let devices = null, users = null, warning = null, failure = null;
		try {
			const dj = await tsGet(s, "/devices?fields=all");
			if (!Array.isArray(dj?.devices)) throw new Error("Unexpected response from Tailscale /devices");
			devices = dj.devices.map(toDevice);
			// The users endpoint needs an extra scope; devices alone are still useful.
			try {
				const uj = await tsGet(s, "/users");
				if (!Array.isArray(uj?.users)) throw new Error("Unexpected response from Tailscale /users");
				users = uj.users.map(toUser);
			} catch (e) {
				warning = `Users not synced: ${e.message}`;
			}
		} catch (e) {
			failure = e;
		}
		const message = failure && String(failure?.message ?? failure).slice(0, 500);
		if (failure) ctx.log.warn("tailscale sync failed", { error: message });
		else ctx.log.info("tailscale sync ok", { devices: devices.length, users: users?.length ?? null, warning });
		const done = await recordSync(s, triggeredBy, { devices, users, warning, message });
		if (failure) throw failure instanceof ctx.HttpError ? failure : new ctx.HttpError(502, message);
		return done;
	}

	// The result of a sync: snapshot tables, sync history and dashboard.
	async function recordSync(s, triggeredBy, { devices, users, warning, message }) {
		const { rows: [run] } = await ctx.db.query(
			`INSERT INTO ${S}.syncs (triggered_by) VALUES ($1) RETURNING id`, [triggeredBy]);
		if (message) {
			await ctx.db.query(
				`UPDATE ${S}.syncs SET finished_at = now(), ok = false, error = $2 WHERE id = $1`, [run.id, message]);
			await safe(() => ctx.dashboard.notify({
				key: "sync-error", title: "Tailscale sync failed", body: message, level: "danger", link: LINK,
			}));
			return null;
		}
		const deviceCount = await replaceSnapshot("devices", DEVICE_COLS, devices);
		const userCount = users ? await replaceSnapshot("users", USER_COLS, users) : null;
		const { rows: [done] } = await ctx.db.query(
			`UPDATE ${S}.syncs SET finished_at = now(), ok = true, warning = $2, device_count = $3, user_count = $4
			 WHERE id = $1 RETURNING *`, [run.id, warning, deviceCount, userCount]);
		await ctx.db.query(`DELETE FROM ${S}.syncs WHERE id < (SELECT max(id) - 200 FROM ${S}.syncs)`);
		await safe(() => ctx.dashboard.remove("sync-error", "notification"));
		await raiseAlerts(s);
		return done;
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

	// Put a "record this month's charge" to-do on the dashboard once bill_day has
	// passed, if billing is on and set up in this organization.
	async function checkBillingHere(s) {
		if (s.billing_enabled && !(await billingProblems(s)).length) await billingReminder(s);
	}

	async function billingReminder(s) {
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

	// Journal entries link back to their charge (Ledger 0.11.2): Ledger shows the
	// link on the entry, and linkedEntries() says which entries a charge has.
	const chargeRef = (c) => `charge:${c.id}`;
	const chargeLink = (c, reversal = false) => ({
		ref: chargeRef(c),
		label: `${reversal ? "Reversal of " : ""}Tailscale ${c.period} · ${c.seats} user${c.seats === 1 ? "" : "s"}`,
		href: LINK,
	});

	// A charge left 'pending' (Ledger stopped while posting it): its entry, if it
	// was posted, carries the charge's link, so mark it posted.
	async function settlePending() {
		const { rows } = await ctx.db.query(
			`SELECT * FROM ${S}.charges WHERE status = 'pending' AND created_at < now() - interval '1 minute'`);
		for (const c of rows) {
			const [linked] = await ctx.ledger.linkedEntries(chargeRef(c));
			if (!linked) continue;
			await ctx.db.query(`UPDATE ${S}.charges SET status = 'posted', entry_id = $2 WHERE id = $1 AND status = 'pending'`,
				[c.id, linked.entry_id]);
			ctx.log.info("tailscale pending charge found posted", { period: c.period, entry_id: linked.entry_id });
		}
	}

	// Charges posted before 0.3.0 have no links yet: add them once.
	async function linkOldCharges() {
		const have = new Set((await ctx.ledger.linkedEntries()).map((l) => `${l.ref}#${l.entry_id}`));
		const { rows } = await ctx.db.query(
			`SELECT * FROM ${S}.charges WHERE status IN ('posted', 'reversing', 'reversed') AND entry_id IS NOT NULL`);
		for (const c of rows) {
			for (const [entryId, reversal] of [[c.entry_id, false], [c.reversal_entry_id, true]]) {
				if (entryId == null || have.has(`${chargeRef(c)}#${entryId}`)) continue;
				await ctx.ledger.linkJournalEntry(entryId, chargeLink(c, reversal))
					.catch((e) => ctx.log.warn("could not link an old Tailscale charge", { period: c.period, error: e.message }));
			}
		}
	}

	function intField(v, name, min, max) {
		const n = (typeof v === "string" && /^\d+$/.test(v.trim())) || typeof v === "bigint" ? Number(v) : v;
		if (!Number.isSafeInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
		return n;
	}

	// ---------------------------------------------------------------- routes

	ctx.route("GET", "/status", async (req) => {
		const s = await getSettings();
		const { rows: [counts] } = await ctx.db.query(`
			SELECT count(*)::int AS devices,
			       count(*) FILTER (WHERE connected)::int AS online,
			       count(*) FILTER (WHERE expires < now() + make_interval(days => $1))::int AS expiring,
			       count(*) FILTER (WHERE update_available AND NOT is_external)::int AS updates,
			       count(*) FILTER (WHERE NOT authorized)::int AS unauthorized
			FROM ${S}.devices`, [s.key_expiry_warn_days]);
		const { rows: [lastSync] } = await ctx.db.query(`SELECT * FROM ${S}.syncs ORDER BY id DESC LIMIT 1`);
		const period = localDate().slice(0, 7);
		const { rows: [charge] } = await ctx.db.query(
			`SELECT * FROM ${S}.charges WHERE period = $1 AND status <> 'reversed'`, [period]);
		return {
			role: req.user.role,
			configured: isConfigured(s),
			syncing: running.has(await currentOrgId()),
			// No secrets: only whether they're set.
			settings: {
				tailnet: s.tailnet, auth_mode: s.auth_mode, sync_minutes: s.sync_minutes,
				key_expiry_warn_days: s.key_expiry_warn_days, offline_warn_days: s.offline_warn_days,
				billing_enabled: s.billing_enabled, price_per_user_cents: s.price_per_user_cents, base_fee_cents: s.base_fee_cents,
				currency: s.currency, expense_account: s.expense_account, payment_account: s.payment_account, bill_day: s.bill_day,
			},
			problems: s.problems,
			billing_problems: await billingProblems(s),
			last_sync: lastSync ?? null,
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

	ctx.route("GET", "/charges", async () => {
		await settlePending();
		return (await ctx.db.query(`SELECT * FROM ${S}.charges ORDER BY period DESC, id DESC LIMIT 120`)).rows;
	});

	ctx.route("POST", "/charges", async (req) => {
		const b = req.body ?? {};
		const s = await getSettings();
		if (!s.billing_enabled) throw new ctx.HttpError(409, `Turn billing on under ${SETTINGS_LINK}`);
		const problems = await billingProblems(s);
		if (problems.length) throw new ctx.HttpError(409, `${problems.join("; ")} under ${SETTINGS_LINK}`);

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
				links: [chargeLink(charge)],
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
		await ctx.ledger.linkJournalEntry(rev.id, chargeLink(c, true), req.user)
			.catch((e) => ctx.log.warn("could not link the reversing entry", { period: c.period, error: e.message }));
		const { rows: [done] } = await ctx.db.query(
			`UPDATE ${S}.charges SET status = 'reversed', reversal_entry_id = $2 WHERE id = $1 RETURNING *`, [c.id, rev.id]);
		ctx.log.info("tailscale charge reversed", { period: c.period, entry_id: rev.id, by: req.user.username });
		await getSettings().then(checkBillingHere).catch((e) => ctx.log.warn("billing check failed", { error: e.message }));
		return done;
	});

	// A charge stuck in 'pending' whose entry never got posted (no linked entry) can go.
	ctx.route("DELETE", "/charges/:id", async (req) => {
		if (!/^\d{1,18}$/.test(req.params.id)) throw new ctx.HttpError(404, "Charge not found");
		await settlePending();
		if ((await ctx.ledger.linkedEntries(`charge:${req.params.id}`)).length) {
			throw new ctx.HttpError(409, "This charge has a journal entry; reverse it instead");
		}
		const { rowCount } = await ctx.db.query(
			`DELETE FROM ${S}.charges WHERE id = $1 AND status = 'pending' AND created_at < now() - interval '1 minute'`,
			[req.params.id]);
		if (!rowCount) throw new ctx.HttpError(409, "Only a charge stuck in 'pending' for over a minute can be discarded");
	});

	// Devices and users in Ledger's search bar.
	ctx.search?.provide(async (query, { limit }) => {
		const q = String(query).trim();
		if (q.length < 2) return [];
		const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
		const { rows: devices } = await ctx.db.query(
			`SELECT name, os, user_login, addresses->>0 AS ip, connected, last_seen FROM ${S}.devices
			  WHERE name ILIKE $1 OR hostname ILIKE $1 OR user_login ILIKE $1 OR addresses::text ILIKE $1 OR tags::text ILIKE $1
			  ORDER BY lower(name) LIMIT $2`, [like, limit]);
		const { rows: users } = await ctx.db.query(
			`SELECT login_name, display_name, status, device_count FROM ${S}.users
			  WHERE login_name ILIKE $1 OR display_name ILIKE $1 ORDER BY lower(coalesce(display_name, login_name)) LIMIT $2`,
			[like, limit]);
		return [
			...devices.map((d) => ({
				title: shortName(d.name),
				subtitle: ["Tailscale device", d.ip, d.os, d.user_login, d.connected ? "online" : null].filter(Boolean).join(" · "),
				href: LINK,
			})),
			...users.map((u) => ({
				title: u.display_name || u.login_name,
				subtitle: ["Tailscale user", u.login_name, u.status, u.device_count != null ? `${u.device_count} device${u.device_count === 1 ? "" : "s"}` : null]
					.filter(Boolean).join(" · "),
				href: LINK,
			})),
		].slice(0, limit);
	});

	// ---------------------------------------------------------------- tailnet access (local tailscaled)

	let processUser = "the Ledger service user";
	try {
		processUser = os.userInfo().username;
	} catch {}
	// Default: the port Ledger itself is listening on.
	const detectedTargets = [...new Set(ownListeners().map((l) => `http://${hostFor(l.ip)}:${l.port}`))];
	const defaultTarget = detectedTargets[0]
		?? `http://127.0.0.1:${/^\d{1,5}$/.test(process.env.PORT ?? "") ? process.env.PORT : 3000}`;
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
				} else reject(new ctx.HttpError(502, `tailscaled: ${e.message}`));
			});
			if (data) req.write(data);
			req.end();
		});
	}

	async function localJson(s, method, path, body, headers) {
		const r = await localApi(s.socket_path, method, path, body, headers);
		if (r.status === 403) throw bad(`tailscaled refused (${r.text.trim().slice(0, 150) || "access denied"}): ${operatorHint()}`);
		if (r.status === 412) throw new ctx.HttpError(409, "The Serve configuration changed meanwhile; try again");
		if (r.status === 503) {
			const err = bad(`Tailscale is running on the Ledger server but not ready (${r.text.trim().slice(0, 100) || "no backend"}). ` +
				"See  sudo journalctl -u tailscaled  — in an LXC container or restricted VM, run tailscaled with --tun=userspace-networking");
			err.notReady = true;
			throw err;
		}
		if (r.status < 200 || r.status > 299) {
			let msg = r.text.trim();
			try {
				msg = JSON.parse(msg).error ?? msg;
			} catch {}
			throw new ctx.HttpError(502, `tailscaled ${path.split("?")[0]}: ${String(msg).slice(0, 200) || `HTTP ${r.status}`}`);
		}
		return { body: r.text.trim() && r.text.trim() !== "null" ? JSON.parse(r.text) : null, etag: r.headers.etag };
	}

	const nodeStatus = async (s) => (await localJson(s, "GET", "/status?peers=false")).body;
	const selfDns = (st) => String(st?.Self?.DNSName ?? "").replace(/\.$/, "");

	async function nodeInfo(s) {
		const target = targetOf(s);
		const base = {
			socket_path: s.socket_path, process_user: processUser, target, target_is_default: !s.serve_target,
			detected_targets: detectedTargets,
			port: s.serve_port, wanted: s.serve_wanted, http_wanted: s.serve_http,
		};
		let st;
		try {
			st = await nodeStatus(s);
		} catch (e) {
			return { ...base, reachable: false, not_ready: !!e.notReady, error: e.message };
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
			http_url: null, http_mode: null, http_conflict: null,
			http_redirect_supported: versionAtLeast(st.Version, REDIRECT_SINCE),
		};
		if (info.backend_state !== "Running" || !dns) return info;
		try {
			const cfg = (await localJson(s, "GET", "/serve-config")).body ?? {};
			Object.assign(info, describeServe(cfg, { dns, port: s.serve_port, target }));
			// What Serve will reach when it forwards a request.
			if (info.serving) info.target_check = await httpProbe(target, ctx.id);
		} catch (e) {
			info.serve_error = e.message; // reading the Serve config can need operator rights
		}
		return info;
	}

	// Alert on every organization's dashboard when Ledger was published but no longer is.
	async function checkServe() {
		const s = await getSettings();
		const n = s.serve_wanted ? await nodeInfo(s) : null;
		const why = !n || n.serving ? null
			: !n.reachable ? n.error
			: n.backend_state !== "Running" ? `Tailscale on the server is ${n.backend_state}.`
			: n.serve_error ?? n.conflict ?? "The Tailscale Serve entry for Ledger was removed.";
		await eachOrg("tailnet access check", () => clearOrNotifyServe(why));
	}
	const clearOrNotifyServe = (why) => safe(() => why
		? ctx.dashboard.notify({ key: "tailnet-access", title: "Ledger isn't reachable on your tailnet", body: why, level: "warning", link: LINK })
		: ctx.dashboard.remove("tailnet-access", "notification"));

	// Write Ledger's Serve entries: https on serve_port, and http on port 80 if wanted.
	async function applyServe(s, username) {
		const target = targetOf(s);
		const st = await nodeStatus(s);
		if (st.BackendState !== "Running") throw bad(`Tailscale on the Ledger server is not connected (${st.BackendState}). Log it in first`);
		const dns = selfDns(st);
		if (!dns) throw bad("This machine has no MagicDNS name: turn on MagicDNS in the Tailscale admin console (DNS page)");
		if (!st.CertDomains?.length) throw bad("Turn on HTTPS Certificates in the Tailscale admin console (DNS page), then try again");
		const shown = target.replace("https+insecure", "https");
		const check = await httpProbe(target, ctx.id);
		if (!check.ok) throw bad(`Ledger isn't reachable at ${shown}: ${check.reason}. Set the address Ledger listens on under Advanced`);
		if (!check.ledger) throw bad(`${shown} answers (HTTP ${check.status}) but it isn't Ledger. Set the address Ledger listens on under Advanced`);

		const { body, etag } = await localJson(s, "GET", "/serve-config");
		let cfg;
		try {
			cfg = withLedger(body, { dns, port: s.serve_port, target, http: s.serve_http, version: st.Version });
		} catch (e) {
			if (e instanceof ServeConflict) throw new ctx.HttpError(409, e.message);
			throw e;
		}
		await localJson(s, "POST", "/serve-config", cfg, etag ? { "If-Match": etag } : {});
		await inMain(() => ctx.db.query(`UPDATE ${S}.settings SET serve_wanted = true WHERE id`));
		ctx.log.info("ledger published on tailnet", { url: serveUrl(dns, s.serve_port), http: s.serve_http, target, by: username });
		await eachOrg("tailnet access check", () => clearOrNotifyServe(null));
	}

	ctx.route("GET", "/node", async (req) => ({ ...(await nodeInfo(await getSettings())), can_manage: await canManageServe(req) }));

	ctx.route("PUT", "/node/settings", async (req) => {
		await requireServeAdmin(req, "change how Ledger is shared on the tailnet");
		const b = req.body ?? {};
		const cur = await getSettings();
		const socket_path = b.socket_path === undefined ? cur.socket_path : b.socket_path;
		if (typeof socket_path !== "string" || !SOCKET_RE.test(socket_path)) throw bad("Socket path must be an absolute path");
		let serve_target = b.serve_target === undefined ? cur.serve_target : b.serve_target || null;
		if (serve_target !== null) {
			const t = typeof serve_target === "string" && serve_target.length <= 100 ? normalizeTarget(serve_target) : null;
			if (!t) {
				throw bad(`"${String(serve_target).slice(0, 100)}" isn't an address on this server. ` +
					`Enter the port or address Ledger listens on, e.g. ${defaultTarget}`);
			}
			serve_target = t === defaultTarget ? null : t;
		}
		const serve_port = b.serve_port === undefined ? cur.serve_port : Number(b.serve_port);
		if (!SERVE_PORTS.includes(serve_port)) throw bad(`HTTPS port must be one of ${SERVE_PORTS.join(", ")}`);
		const serve_http = b.serve_http === undefined ? cur.serve_http : b.serve_http;
		if (typeof serve_http !== "boolean") throw bad("serve_http must be true or false");
		const changesServe = targetOf(cur) !== (serve_target ?? defaultTarget) || serve_port !== cur.serve_port;
		const serving = (await nodeInfo(cur)).serving;
		if (changesServe && serving) throw new ctx.HttpError(409, "Stop sharing Ledger on the tailnet before changing its address or port");
		await inMain(() => ctx.db.query(
			`UPDATE ${S}.settings SET socket_path = $1, serve_target = $2, serve_port = $3, serve_http = $4,
				updated_by = $5, updated_at = now() WHERE id`,
			[socket_path, serve_target, serve_port, serve_http, req.user.username]));
		const s = await getSettings();
		if (serving && serve_http !== cur.serve_http) await applyServe(s, req.user.username);
		return { ...(await nodeInfo(s)), can_manage: true };
	});

	ctx.route("POST", "/node/serve", async (req) => {
		await requireServeAdmin(req, "share Ledger on the tailnet");
		await applyServe(await getSettings(), req.user.username);
		return { ...(await nodeInfo(await getSettings())), can_manage: true };
	});

	ctx.route("DELETE", "/node/serve", async (req) => {
		await requireServeAdmin(req, "stop sharing Ledger on the tailnet");
		const s = await getSettings();
		const { body, etag } = await localJson(s, "GET", "/serve-config");
		const dns = await nodeStatus(s).then(selfDns, () => "");
		if (body) {
			const cfg = withoutLedger(body, { target: targetOf(s), dns, port: s.serve_port });
			await localJson(s, "POST", "/serve-config", cfg, etag ? { "If-Match": etag } : {});
		}
		await inMain(() => ctx.db.query(`UPDATE ${S}.settings SET serve_wanted = false WHERE id`));
		ctx.log.info("ledger unpublished from tailnet", { by: req.user.username });
		await eachOrg("tailnet access check", () => clearOrNotifyServe(null));
		return { ...(await nodeInfo(await getSettings())), can_manage: true };
	});

	// Start an interactive login and hand back the URL to approve this machine.
	ctx.route("POST", "/node/login", async (req) => {
		await requireServeAdmin(req, "log the server in to Tailscale");
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

	// Every minute: sync each organization that's due, remind about billing
	// (hourly), and check that Ledger is still shared if it should be.
	async function tick() {
		const billingDue = Date.now() - lastBillingCheck > 3_600_000;
		if (billingDue) lastBillingCheck = Date.now();
		await eachOrg("background check", async (org) => {
			const s = await getSettings();
			if (isConfigured(s) && s.sync_minutes > 0 && !running.has(org.id)) {
				const { rows: [due] } = await ctx.db.query(
					`SELECT coalesce(max(started_at) < now() - make_interval(mins => $1), true) AS due FROM ${S}.syncs`,
					[s.sync_minutes]);
				if (due.due) await sync("auto").catch(() => {}); // failure is logged and shown on the dashboard
			}
			if (billingDue) await checkBillingHere(s);
		});
		if ((await getSettings()).serve_wanted) await checkServe();
	}
	function runTick() {
		tick().catch((e) => ctx.log.error("tailscale background check failed", { error: e.message }));
	}
	setTimeout(runTick, 5_000).unref();
	setTimeout(() => eachOrg("linking old charges", async () => {
		await settlePending();
		await linkOldCharges();
	}), 8_000).unref();
	setInterval(runTick, 60_000).unref();
}
