// Helpers for the Tailscale module that don't need Ledger or tailscaled, so
// they can be tested on their own (test/*.test.mjs).

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";

export const SERVE_PORTS = [443, 8443, 10000]; // the ports Tailscale Serve accepts for HTTPS
export const HTTP_PORT = 80;
export const REDIRECT_SINCE = [1, 92, 0]; // first tailscaled whose Serve handlers support Redirect

export function versionAtLeast(version, min) {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
	if (!m) return false;
	for (let i = 0; i < 3; i++) if (Number(m[i + 1]) !== min[i]) return Number(m[i + 1]) > min[i];
	return true;
}

// ------------------------------------------------------------------ Ledger's own address

// /proc/net/tcp{,6} address: little-endian 32-bit words of hex.
export function procAddr(hex) {
	const bytes = hex.match(/../g).map((b) => parseInt(b, 16));
	for (let i = 0; i < bytes.length; i += 4) bytes.splice(i, 4, ...bytes.slice(i, i + 4).reverse());
	if (bytes.length === 4) return bytes.join(".");
	const groups = [];
	for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
	const v6 = groups.join(":");
	if (/^0:0:0:0:0:ffff:/.test(v6)) return bytes.slice(12).join("."); // IPv4-mapped
	return v6 === "0:0:0:0:0:0:0:0" ? "::" : v6 === "0:0:0:0:0:0:0:1" ? "::1" : v6;
}

// TCP ports this very process (Ledger) listens on, read from /proc. [] where unavailable.
export function ownListeners() {
	try {
		const inodes = new Set();
		for (const fd of fs.readdirSync("/proc/self/fd")) {
			try {
				const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/self/fd/${fd}`));
				if (m) inodes.add(m[1]);
			} catch {}
		}
		const out = [];
		for (const name of ["tcp", "tcp6"]) {
			// /proc/self/net stays readable under systemd ProcSubset=pid, which hides /proc/net.
			let text;
			for (const file of [`/proc/self/net/${name}`, `/proc/net/${name}`]) {
				try {
					text = fs.readFileSync(file, "utf8");
					break;
				} catch {}
			}
			if (!text) continue;
			for (const line of text.trim().split("\n").slice(1)) {
				const c = line.trim().split(/\s+/);
				if (c[3] !== "0A" || !inodes.has(c[9])) continue; // 0A = LISTEN
				const [ip, port] = c[1].split(":");
				out.push({ ip: procAddr(ip), port: parseInt(port, 16) });
			}
		}
		return out;
	} catch {
		return [];
	}
}

export const hostFor = (ip) => (ip === "0.0.0.0" || ip === "::" ? "127.0.0.1" : ip.includes(":") ? `[${ip}]` : ip);

// This machine's own addresses: Ledger may only be published from here.
export function ownAddresses() {
	const set = new Set(["127.0.0.1", "::1", "localhost"]);
	try {
		for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) set.add(a.address.split("%")[0]);
	} catch {} // throws under systemd RestrictAddressFamilies without AF_NETLINK: loopback only then
	return set;
}

// Accepts "3000", "127.0.0.1:3000", "http://10.0.0.5:3000/", "https://localhost:8443", ...
// Returns a Tailscale Serve proxy target, or null if it isn't an address on this machine.
export function normalizeTarget(input, own = ownAddresses()) {
	let v = String(input).trim();
	if (/^\d{1,5}$/.test(v)) v = `127.0.0.1:${v}`;
	if (!/^[a-z]+:\/\//i.test(v)) v = `http://${v}`;
	let u;
	try {
		u = new URL(v);
	} catch {
		return null;
	}
	if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) return null;
	if (u.pathname !== "/" && u.pathname !== "") return null;
	const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
	let host = u.hostname.replace(/^\[|\]$/g, "");
	if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
	if (!own.has(host) || port < 1 || port > 65535) return null;
	const h = host.includes(":") ? `[${host}]` : host;
	// Serve can't verify a local certificate, so HTTPS targets skip verification.
	return `${u.protocol === "https:" ? "https+insecure" : "http"}://${h}:${port}`;
}

// Make one HTTP request to a Serve target, the way Tailscale Serve will.
// Ledger answers an anonymous call to this module's API with its JSON error body,
// which tells it apart from some other web server on that port.
export function httpProbe(target, moduleId) {
	const u = new URL(target.replace(/^https\+insecure:/, "https:"));
	const mod = u.protocol === "https:" ? https : http;
	return new Promise((resolve) => {
		const req = mod.request({
			host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port, method: "GET",
			path: `/api/v1/m/${moduleId}/status`, rejectUnauthorized: false, headers: { Accept: "application/json" },
		}, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (c) => {
				if (body.length < 8192) body += c;
			});
			res.on("end", () => {
				let ledger = false;
				try {
					ledger = typeof JSON.parse(body)?.error === "object";
				} catch {}
				resolve({ ok: true, status: res.statusCode, ledger });
			});
		});
		req.setTimeout(3_000, () => req.destroy(Object.assign(new Error("no answer within 3 s"), { code: "ETIMEDOUT" })));
		req.on("error", (e) => resolve({
			ok: false,
			reason: e.code === "ECONNREFUSED" ? "nothing is listening there"
				: String(e.code ?? "").startsWith("HPE_") ? "what's listening there isn't a web server"
				: e.code === "EPROTO" || /SSL|TLS/i.test(e.message) ? "it doesn't speak HTTPS (use http://)"
				: e.message,
		}));
		req.end();
	});
}

// ------------------------------------------------------------------ Tailscale Serve config

export const serveUrl = (dns, port) => `https://${dns}${port === 443 ? "" : `:${port}`}/`;
// The port-80 handler that sends plain http:// to the https address.
export const httpsRedirect = (dns, port) => `301:${serveUrl(dns, port).slice(0, -1)}\${REQUEST_URI}`;

/** A "/" handler Ledger owns: it proxies to Ledger, or is our https redirect. */
export const isLedgerHandler = (h, { target, dns, port }) =>
	!!h && (h.Proxy === target || (!!dns && h.Redirect === httpsRedirect(dns, port)));

/** Thrown when another service already holds a port or address Ledger needs. */
export class ServeConflict extends Error {}

/** cfg without Ledger's "/" handlers (on every port, or only `onlyPort`), emptied entries dropped. */
export function withoutLedger(cfg, who, onlyPort) {
	const web = { ...cfg?.Web };
	for (const [hp, w] of Object.entries(web)) {
		if (onlyPort && !hp.endsWith(`:${onlyPort}`)) continue;
		if (!isLedgerHandler(w?.Handlers?.["/"], who)) continue;
		const { "/": _, ...rest } = w.Handlers;
		if (Object.keys(rest).length) web[hp] = { ...w, Handlers: rest };
		else delete web[hp];
	}
	const usedPorts = new Set(Object.keys(web).map((hp) => hp.slice(hp.lastIndexOf(":") + 1)));
	const tcp = Object.fromEntries(Object.entries(cfg?.TCP ?? {}).filter(([p, v]) => !(v?.HTTPS || v?.HTTP) || usedPorts.has(p)));
	const funnel = Object.fromEntries(Object.entries(cfg?.AllowFunnel ?? {}).filter(([hp]) => hp in web));
	return { ...cfg, Web: web, TCP: tcp, AllowFunnel: funnel };
}

/**
 * cfg with Ledger served at https://dns:port → target, and, if `http`, plain
 * http:// on port 80 (a redirect when tailscaled can do it, else a proxy).
 * Port 80 is skipped, not an error, when something else uses it.
 */
export function withLedger(cfg, { dns, port, target, http: wantHttp, version }) {
	cfg = cfg ?? {};
	const hp = `${dns}:${port}`;
	const existing = cfg.Web?.[hp]?.Handlers?.["/"];
	if (existing && existing.Proxy !== target) {
		throw new ServeConflict(`${serveUrl(dns, port)} already serves ${existing.Proxy ?? existing.Path ?? existing.Redirect ?? "something else"}. Pick another HTTPS port`);
	}
	const tcp = cfg.TCP?.[port];
	if (tcp && !tcp.HTTPS) throw new ServeConflict(`Port ${port} is used for TCP forwarding. Pick another HTTPS port`);
	cfg = {
		...cfg,
		TCP: { ...cfg.TCP, [port]: { ...tcp, HTTPS: true } },
		Web: { ...cfg.Web, [hp]: { ...cfg.Web?.[hp], Handlers: { ...cfg.Web?.[hp]?.Handlers, "/": { Proxy: target } } } },
	};

	cfg = withoutLedger(cfg, { target: null, dns, port }, HTTP_PORT); // an earlier redirect of ours
	const hp80 = `${dns}:${HTTP_PORT}`;
	const tcp80 = cfg.TCP?.[HTTP_PORT];
	const h80 = cfg.Web?.[hp80]?.Handlers?.["/"];
	if (wantHttp && (!h80 || h80.Proxy === target) && !(tcp80 && !tcp80.HTTP)) {
		const handler = versionAtLeast(version, REDIRECT_SINCE) ? { Redirect: httpsRedirect(dns, port) } : { Proxy: target };
		cfg = {
			...cfg,
			TCP: { ...cfg.TCP, [HTTP_PORT]: { ...tcp80, HTTP: true } },
			Web: { ...cfg.Web, [hp80]: { ...cfg.Web?.[hp80], Handlers: { ...cfg.Web?.[hp80]?.Handlers, "/": handler } } },
		};
	} else if (!wantHttp && h80?.Proxy === target) {
		cfg = withoutLedger(cfg, { target, dns: null, port }, HTTP_PORT);
	}
	return cfg;
}

/** What cfg says about Ledger at dns: served where, and what's in the way. */
export function describeServe(cfg, { dns, port, target }) {
	const who = { target, dns, port };
	const hp = `${dns}:${port}`;
	const h = cfg?.Web?.[hp]?.Handlers?.["/"];
	const out = { serving: h?.Proxy === target, url: null, funnel: false, conflict: null, http_url: null, http_mode: null, http_conflict: null };
	if (out.serving) {
		out.url = serveUrl(dns, port);
		out.funnel = !!cfg.AllowFunnel?.[hp];
	} else if (h) out.conflict = `${serveUrl(dns, port)} already serves ${h.Proxy ?? h.Path ?? h.Redirect ?? "something else"}`;
	else if (cfg?.TCP?.[port] && !cfg.TCP[port].HTTPS) out.conflict = `Port ${port} is used for TCP forwarding`;

	const h80 = cfg?.Web?.[`${dns}:${HTTP_PORT}`]?.Handlers?.["/"];
	if (isLedgerHandler(h80, who)) {
		out.http_url = `http://${dns}/`;
		out.http_mode = h80.Redirect ? "redirect" : "proxy";
	} else if (h80) out.http_conflict = `http://${dns}/ already serves ${h80.Proxy ?? h80.Path ?? h80.Redirect ?? "something else"}`;
	else if (cfg?.TCP?.[HTTP_PORT] && !cfg.TCP[HTTP_PORT].HTTP) {
		out.http_conflict = `Port ${HTTP_PORT} is used for ${cfg.TCP[HTTP_PORT].HTTPS ? "HTTPS" : "TCP forwarding"}`;
	}
	return out;
}
