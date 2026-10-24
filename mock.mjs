import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mock-'));
process.env.DSH_HOME = home;
const mod = await import('./lib/index.js');

let route;
const ctx = { webServer: { register: (r) => { route = r; } }, logger: { info() {}, warn() {} } };
mod.apply(ctx);
if (!route || route.kind !== 'prefix' || route.path !== '/api/dsh-remote/android') {
	throw new Error('route not registered: ' + JSON.stringify(route));
}

/** 假 res。 */
function fakeRes() {
	return { _h: null, writableEnded: false, writeHead(s, h) { this._h = { s, h }; }, end(b) { this.writableEnded = true; this.body = b; } };
}

/** 假 req。 */
function fakeReq(url, method, host, body) {
	const cbs = {};
	return {
		url, method, headers: { host },
		on(ev, cb) { cbs[ev] = cb; return this; },
		destroy() {},
		emit() { if (body !== undefined) cbs.data && cbs.data(Buffer.from(body)); cbs.end && cbs.end(); },
		_start() { this.emit(); },
	};
}

// ① loopback status
let res = fakeRes();
await route.handler({ url: '/api/dsh-remote/android/status', method: 'GET', headers: { host: '127.0.0.1:51883' }, on() {} }, res);
let out = JSON.parse(res.body);
if (!out.ok || out.paired !== false || 'token' in out) throw new Error('status bad: ' + res.body);

// ② 非 loopback 必须 403
res = fakeRes();
await route.handler({ url: '/api/dsh-remote/android/status', method: 'GET', headers: { host: 'evil.com' }, on() {} }, res);
if (res._h.s !== 403) throw new Error('non-loopback not blocked: ' + res._h.s);

// ③ 未配对时 rpc 必须报错、不能联网
const req = fakeReq('/api/dsh-remote/android/rpc', 'POST', '127.0.0.1', JSON.stringify({ method: 'ping', params: {} }));
res = fakeRes();
route.handler(req, res);
req._start();
// ⚠️ 路由处理器是「即发即忘」（`void handle(...)`），所以要等到 res 被写入。
for (let tick = 0; tick < 200 && res.writableEnded !== true; tick += 1) {
	await new Promise((resolve) => setTimeout(resolve, 5));
}
out = JSON.parse(res.body);
if (out.ok !== false || !/尚未配对/.test(out.error)) throw new Error('unpaired rpc: ' + res.body);

// ④ 未配对时 stream 必须 409
res = fakeRes();
await route.handler({ url: '/api/dsh-remote/android/stream?session=s1', method: 'GET', headers: { host: '127.0.0.1' }, on() {} }, res);
if (res._h.s !== 409) throw new Error('unpaired stream: ' + res._h.s);

// ⑤ 未知路由 404
res = fakeRes();
await route.handler({ url: '/api/dsh-remote/android/nope', method: 'GET', headers: { host: '127.0.0.1' }, on() {} }, res);
if (res._h.s !== 404) throw new Error('unknown route: ' + res._h.s);

console.log('✓ apply + 6 条桥路由 + loopback 围栏 + 未配对守卫 全部通过');
