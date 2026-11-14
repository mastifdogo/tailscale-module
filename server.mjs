// Tailscale module for Ledger: Ledger's connection to your tailnet. It shares
// Ledger at https://<server>.<tailnet>.ts.net through Tailscale Serve, driving
// the server's own tailscaled over its LocalAPI socket, and warns on the
// dashboard when that share goes away. It doesn't call the Tailscale API.
//
// The Serve options (Access → Advanced) and whether Ledger should be shared
// live in mod_tailscale.settings of the main books: they describe this
// machine, not an organization, so only an admin of the main books changes
// them. The warning goes to every organization's dashboard.

import http from "node:http";
import os from "node:os";
import {
	REDIRECT_SINCE, SERVE_PORTS, ServeConflict, describeServe, hostFor, httpProbe, normalizeTarget, ownListeners,
	serveUrl, versionAtLeast, withLedger, withoutLedger,
} from "./lib.mjs";

const SOCKET_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
const TIMEOUT_MS = 10_000;
const LINK = "/apps/tailscale";
// Dashboard items earlier versions (device alerts, billing) left behind.
const OLD_NOTIFICATIONS = ["sync-error", "key-expiry", "offline", "updates", "approval"];

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

	const getSettings = async () => (await inMain(() => ctx.db.query(
		`SELECT socket_path, serve_target, serve_port, serve_http, serve_wanted FROM ${S}.settings WHERE id`))).rows[0];

	// Before 0.6.0 the module also read the Tailscale API (devices, users,
	// billing). Once per organization: drop the API credentials and options
	// from Ledger's settings store (set() keeps only the manifest's fields, and
	// there are none now) and the dashboard items those features posted.
	async function forgetApiFeatures() {
		const { rows: [row] } = await ctx.db.query(`SELECT api_features_removed FROM ${S}.settings WHERE id`);
		if (!row || row.api_features_removed) return;
		await ctx.settings?.set({});
		for (const key of OLD_NOTIFICATIONS) await safe(() => ctx.dashboard.remove(key, "notification"));
		const todos = (await safe(() => ctx.dashboard.list({ kind: "todo" }))) ?? [];
		for (const t of todos) if (String(t.key).startsWith("charge-")) await safe(() => ctx.dashboard.remove(t.key));
		await ctx.db.query(`UPDATE ${S}.settings SET api_features_removed = true WHERE id`);
		ctx.log.info("tailscale: removed the Tailscale API settings and dashboard items");
	}

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

	ctx.route("GET", "/node", async (req) => ({
		...(await nodeInfo(await getSettings())), role: req.user.role, can_manage: await canManageServe(req),
	}));

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

	// Every minute: if Ledger should be shared, check that it still is.
	async function tick() {
		if ((await getSettings()).serve_wanted) await checkServe();
	}
	function runTick() {
		tick().catch((e) => ctx.log.error("tailscale background check failed", { error: e.message }));
	}
	setTimeout(() => eachOrg("removing old Tailscale API data", forgetApiFeatures), 3_000).unref();
	setTimeout(runTick, 5_000).unref();
	setInterval(runTick, 60_000).unref();
}
