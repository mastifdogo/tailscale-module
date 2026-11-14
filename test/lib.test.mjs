import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
	ServeConflict, describeServe, httpProbe, httpsRedirect, normalizeTarget, procAddr, versionAtLeast, withLedger,
	withoutLedger,
} from "../lib.mjs";

const DNS = "bookeeping.tail5dab4b.ts.net";
const TARGET = "http://127.0.0.1:8080";
const NEW = "1.104.2-tc3430f0d2";
const who = { dns: DNS, port: 443, target: TARGET };

test("procAddr decodes /proc/net addresses", () => {
	assert.equal(procAddr("0100007F"), "127.0.0.1");
	assert.equal(procAddr("00000000"), "0.0.0.0");
	assert.equal(procAddr("00000000000000000000000000000000"), "::");
	assert.equal(procAddr("00000000000000000000000001000000"), "::1");
	assert.equal(procAddr("0000000000000000FFFF00000100007F"), "127.0.0.1");
});

test("normalizeTarget accepts addresses on this machine only", () => {
	const own = new Set(["127.0.0.1", "::1", "localhost", "192.0.2.2"]);
	assert.equal(normalizeTarget("8080", own), "http://127.0.0.1:8080");
	assert.equal(normalizeTarget("127.0.0.1:8080", own), "http://127.0.0.1:8080");
	assert.equal(normalizeTarget("http://127.0.0.1:8080/", own), "http://127.0.0.1:8080");
	assert.equal(normalizeTarget("0.0.0.0:8080", own), "http://127.0.0.1:8080");
	assert.equal(normalizeTarget("[::1]:8080", own), "http://[::1]:8080");
	assert.equal(normalizeTarget("192.0.2.2:8080", own), "http://192.0.2.2:8080");
	assert.equal(normalizeTarget("https://localhost:8443", own), "https+insecure://localhost:8443");
	for (const bad of ["10.9.9.9:80", "example.com:80", "http://127.0.0.1:80/ledger", "ftp://127.0.0.1:21", "127.0.0.1:99999", "file:///etc/passwd"]) {
		assert.equal(normalizeTarget(bad, own), null, bad);
	}
});

test("versionAtLeast", () => {
	assert.equal(versionAtLeast("1.92.0", [1, 92, 0]), true);
	assert.equal(versionAtLeast(NEW, [1, 92, 0]), true);
	assert.equal(versionAtLeast("1.90.9-x", [1, 92, 0]), false);
	assert.equal(versionAtLeast("2.0.0", [1, 92, 0]), true);
	assert.equal(versionAtLeast(undefined, [1, 92, 0]), false);
});

test("withLedger serves https and redirects http on new tailscaled", () => {
	const cfg = withLedger(null, { ...who, http: true, version: NEW });
	assert.deepEqual(cfg.TCP, { 443: { HTTPS: true }, 80: { HTTP: true } });
	assert.deepEqual(cfg.Web[`${DNS}:443`].Handlers["/"], { Proxy: TARGET });
	assert.equal(cfg.Web[`${DNS}:80`].Handlers["/"].Redirect, `301:https://${DNS}\${REQUEST_URI}`);
	const d = describeServe(cfg, who);
	assert.equal(d.serving, true);
	assert.equal(d.url, `https://${DNS}/`);
	assert.equal(d.http_mode, "redirect");
	// Applying again changes nothing.
	assert.deepEqual(withLedger(cfg, { ...who, http: true, version: NEW }), cfg);
});

test("withLedger proxies http on tailscaled older than 1.92", () => {
	const cfg = withLedger({}, { ...who, http: true, version: "1.90.9" });
	assert.deepEqual(cfg.Web[`${DNS}:80`].Handlers["/"], { Proxy: TARGET });
	assert.equal(describeServe(cfg, who).http_mode, "proxy");
});

test("redirect uses the HTTPS port when it isn't 443", () => {
	assert.equal(httpsRedirect(DNS, 8443), `301:https://${DNS}:8443\${REQUEST_URI}`);
});

test("withLedger leaves other services alone", () => {
	const other = {
		TCP: { 22: { TCPForward: "127.0.0.1:22" }, 80: { HTTP: true }, 8443: { HTTPS: true } },
		Web: {
			[`${DNS}:80`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } },
			[`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } },
		},
	};
	const cfg = withLedger(other, { ...who, http: true, version: NEW });
	assert.equal(cfg.Web[`${DNS}:80`].Handlers["/"].Proxy, "http://127.0.0.1:9999", "port 80 taken: skipped");
	assert.equal(describeServe(cfg, who).http_conflict, `http://${DNS}/ already serves http://127.0.0.1:9999`);
	const back = withoutLedger(cfg, who);
	assert.deepEqual(back.Web, other.Web);
	assert.deepEqual(back.TCP, other.TCP);
	assert.throws(() => withLedger(other, { ...who, port: 8443, http: false, version: NEW }), ServeConflict);
	assert.throws(() => withLedger({ TCP: { 443: { TCPForward: "x:1" } } }, { ...who, http: false, version: NEW }), ServeConflict);
});

test("turning http off removes only Ledger's port 80 entry", () => {
	const on = withLedger({}, { ...who, http: true, version: NEW });
	const off = withLedger(on, { ...who, http: false, version: NEW });
	assert.deepEqual(Object.keys(off.TCP), ["443"]);
	assert.equal(off.Web[`${DNS}:80`], undefined);
	assert.deepEqual(withoutLedger(off, who), { TCP: {}, Web: {}, AllowFunnel: {} });
});

test("httpProbe tells Ledger from other web servers", async (t) => {
	const listen = (handler) => new Promise((resolve) => {
		const s = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(s));
	});
	const ledger = await listen((req, res) => {
		res.statusCode = 401;
		res.setHeader("content-type", "application/json");
		res.end('{"error":{"code":"unauthorized","message":"log in"}}');
	});
	const other = await listen((req, res) => res.end("<h1>nginx</h1>"));
	const closed = await listen(() => {});
	const closedPort = closed.address().port;
	closed.close();
	t.after(() => { ledger.close(); other.close(); });

	assert.deepEqual(await httpProbe(`http://127.0.0.1:${ledger.address().port}`, "tailscale"), { ok: true, status: 401, ledger: true });
	assert.deepEqual(await httpProbe(`http://127.0.0.1:${other.address().port}`, "tailscale"), { ok: true, status: 200, ledger: false });
	assert.deepEqual(await httpProbe(`http://127.0.0.1:${closedPort}`, "tailscale"), { ok: false, reason: "nothing is listening there" });
});
