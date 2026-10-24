/**
 * dsh-jiuling-remote-android —— 安卓端（host half，跑在手机的 DSH 引擎里）。
 *
 * ## 职责边界（本版是「配对 + 桥接」层，不含对话镜像）
 *
 * 这一版只做三件事，全部是**可离线验证、无 UI 依赖**的那一层：
 *
 * 1. **配对**：手机上输 6 位配对码 → 找配对服务器 claim → 落盘
 *    `{ endpoint, token }`（`$DSH_HOME/dsh-remote-android/config.json`）。
 * 2. **RPC 桥**：浏览器侧 `fetch('/api/dsh-remote/android/rpc')` → 引擎用
 *    落盘的令牌打到电脑的 `/api/dsh-remote/rpc`。
 * 3. **SSE 桥**：浏览器 `EventSource('/api/dsh-remote/android/stream')` →
 *    引擎带着令牌去连电脑的 `/api/dsh-remote/stream`，并把字节原样转发。
 *
 * ## ⚠️ 为什么凭据只能留在引擎进程里
 *
 * 电脑端的访问令牌就是那台电脑的门钥匙。浏览器侧（WebView 页面世界）一旦
 * 持有它，任何脚本、任何插件、任何 `localStorage` 转储都能拿走。所以：
 *
 * - 落盘与读取都在 host 半边，**响应体里永远不回显 token**；
 * - 浏览器侧的请求走**同源本地路由**，令牌由引擎在出口处附加；
 * - 令牌只走 `x-dsh-remote-token` 头，**绝不进 URL query**（query 会进隧道
 *   日志、反代 access log、浏览器历史）。
 *
 * ## ⚠️ Android 上不要用全局 fetch（真机实测）
 *
 * 手机引擎进程里全局 undici dispatcher 连公网上会卡在 Happy Eyeballs：
 * 同一时刻同一 URL，全局 `fetch()` 12 秒超时，而 `node:https.request()`
 * 2.1 秒 200。所以本插件**一律走 `node:https`**（并且关掉重定向跟随）。
 *
 * ## ⚠️ 不跟随重定向
 *
 * `302` 跨源会把 `x-dsh-remote-token` 原样带到攻击者主机上。所以这里把 3xx
 * 当普通响应处理（`ok === false`），让上层按 HTTP 错误报出来 —— 宁可不连，
 * 也不把凭据送去一个不像我们服务器的地址。
 *
 * @module dsh-jiuling-remote-android
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-jiuling-remote-android';

/**
 * 只强制依赖 `webServer`（挂本地桥用）。
 *
 * 其余服务全部**可选**：本版不建会话、不拦 prompt，所以缺了也不该让插件装不上
 * —— 装不上等于配对功能一起消失。
 */
export const inject = {
	webServer: { required: true },
};

/** 本地桥的路由前缀（挂在 DSH 自己的 Web 端口上，同源）。 */
const ROUTE_PREFIX = '/api/dsh-remote/android';

/** 状态目录。 */
const STATE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-remote-android');

/** 连接配置：电脑隧道地址 + 访问令牌 + 白名单区 + 配对服务地址。 */
const CONFIG_PATH = join(STATE_DIR, 'config.json');

/** 落盘诊断（手机上 logger 常常看不到，只能靠文件）。 */
const DEBUG_LOG = join(STATE_DIR, 'android-debug.log');

/** 默认隧道地址（与电脑端/既有手机端同构，配对成功后会被真实地址覆盖）。 */
const DEFAULT_ENDPOINT = 'https://dsh-remote.jiulingssh.xyz';

/** 默认配对服务（必须与电脑端 `pair.js` 的 `PAIR_ENDPOINT` 指向同一个）。 */
const DEFAULT_PAIR_ENDPOINT = 'https://pair.jiulingssh.xyz';

/** 默认凭据白名单区（自建部署改 `config.json` 的 `zones`，不用改源码）。 */
const DEFAULT_ZONES = ['jiulingssh.xyz'];

/** RPC 请求体上限：图片以 base64 内联传，4 MiB 太紧，取 16 MiB。 */
const RPC_BODY_LIMIT = 16 * 1024 * 1024;

/** 单次上游 RPC 的超时（毫秒）。 */
const RPC_TIMEOUT_MS = 120000;

/** 配对请求的超时（毫秒）。 */
const PAIR_TIMEOUT_MS = 30000;

/** 已作废的旧公开令牌（只用于识别，不是凭据）。 */
const LEGACY_PUBLIC_TOKEN_FINGERPRINT =
	'6c04899c20fc7ffab9b2fe7f9cc6e56a8b7ca0c66c96b393f8b93ab1c9784356';

/**
 * 追加一行诊断日志。
 *
 * 整个函数吞掉所有异常：诊断绝不允许影响业务。
 *
 * @param line - 要追加的一行。
 */
function debugLog(line) {
	try {
		if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
	} catch {
		// 故意什么都不做
	}
}

/**
 * 判断一个令牌是不是那个已泄露的旧公开令牌。
 *
 * 老版本把它写进配置文件；升级后若继续用它，症状是「显示已配对，一发消息就 401」。
 *
 * @param value - 配置里的 token。
 * @returns 是否应视为「未配对」。
 */
function isLegacyPublicToken(value) {
	return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex') === LEGACY_PUBLIC_TOKEN_FINGERPRINT;
}

/**
 * 读配置。文件不存在/损坏时返回一份模板（不落盘，等配对成功才写）。
 *
 * @returns `{ endpoint, token, zones, pairEndpoint }`。
 */
function loadConfig() {
	const fallback = {
		endpoint: typeof process.env.DSH_REMOTE_ENDPOINT === 'string' && process.env.DSH_REMOTE_ENDPOINT !== ''
			? process.env.DSH_REMOTE_ENDPOINT.replace(/\/+$/, '')
			: DEFAULT_ENDPOINT,
		token: '',
		zones: DEFAULT_ZONES,
		pairEndpoint:
			typeof process.env.DSH_REMOTE_PAIR_ENDPOINT === 'string' && process.env.DSH_REMOTE_PAIR_ENDPOINT !== ''
				? process.env.DSH_REMOTE_PAIR_ENDPOINT.replace(/\/+$/, '')
				: DEFAULT_PAIR_ENDPOINT,
	};
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
		const raw = typeof parsed?.token === 'string' ? parsed.token : '';
		// ⚠️ 旧版公开令牌要当成**没有令牌**，否则界面显示已配对、实际必然 401。
		const token = isLegacyPublicToken(raw) ? '' : raw;
		const zones = Array.isArray(parsed?.zones)
			? parsed.zones.filter((zone) => typeof zone === 'string' && zone.trim() !== '').map((zone) => zone.trim().toLowerCase())
			: DEFAULT_ZONES;
		return {
			endpoint:
				typeof parsed?.endpoint === 'string' && parsed.endpoint !== ''
					? parsed.endpoint.replace(/\/+$/, '')
					: fallback.endpoint,
			token,
			zones: zones.length === 0 ? DEFAULT_ZONES : zones,
			pairEndpoint:
				typeof parsed?.pairEndpoint === 'string' && parsed.pairEndpoint !== ''
					? parsed.pairEndpoint.replace(/\/+$/, '')
					: fallback.pairEndpoint,
		};
	} catch {
		return fallback;
	}
}

/**
 * 落盘配置（临时文件 + rename）。
 *
 * ⚠️ 必须是原子的：这个文件是手机上**唯一一份**凭据，写一半断电就得重新配对。
 *
 * @param record - `{ endpoint, token, zones, pairEndpoint }`。
 * @returns 实际落盘的内容。
 */
function saveConfig(record) {
	const next = {
		endpoint: String(record.endpoint).replace(/\/+$/, ''),
		token: String(record.token),
		zones: Array.isArray(record.zones) ? record.zones : DEFAULT_ZONES,
		pairEndpoint: String(record.pairEndpoint).replace(/\/+$/, ''),
	};
	mkdirSync(STATE_DIR, { recursive: true });
	const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
	renameSync(tmp, CONFIG_PATH);
	return next;
}

/**
 * 令牌的短指纹，**只用来打日志**。
 *
 * @param token - 访问令牌。
 * @returns 8 位十六进制指纹。
 */
function tokenFingerprint(token) {
	return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex').slice(0, 8);
}

/**
 * 校验一个远端 URL 能不能收我们的凭据。
 *
 * ## 判据（三条，任一条不过就抛）
 *
 * 1. **必须 https** —— 令牌是明文 header，走 http 等于公网裸奔；
 * 2. **不能是 IP 字面量 / localhost** —— 内网地址不该收到这台电脑的令牌
 *    （DNS rebinding 的常见落点也正是这类地址）；
 * 3. **域名必须落在白名单区**（`config.zones`，默认 `jiulingssh.xyz`）。
 *    自建部署改配置文件即可，不用改源码。
 *
 * @param url - 完整 URL。
 * @param zones - 允许的域名后缀列表。
 * @throws 当这个地址不该收到凭据时。
 */
function assertTrustedHost(url, zones) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`地址格式不对：${url}`);
	}
	if (parsed.protocol !== 'https:') throw new Error(`只允许 https，收到的是 ${parsed.protocol}`);
	const host = parsed.hostname.toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost')) {
		throw new Error('不允许把凭据发到 localhost');
	}
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
		throw new Error('不允许把凭据发到 IP 字面量地址');
	}
	for (const zone of zones) {
		if (host === zone || host.endsWith(`.${zone}`)) return;
	}
	throw new Error(
		`拒绝对 ${host} 发送凭据（不在白名单 ${zones.join(', ')} 内）。自建部署请在 config.json 的 zones 里加上你的域名。`,
	);
}

/**
 * 发一个 HTTPS 请求，**不跟随重定向**，并把响应体读成 Buffer。
 *
 * ## 为什么不用 `fetch`
 *
 * Android 上全局 undici dispatcher 的 autoSelectFamily 会让公网请求卡 12 秒
 * 超时（实测对照：`node:https` 2.1 秒 200）。这里只用 `node:https`。
 *
 * ## 为什么读成 Buffer 而不是流
 *
 * 上游 SSE 走 `openStream`（流式）；这里只服务一问一答的 RPC 与配对，
 * 一次性读完更简单，也不用管背压。
 *
 * @param url - 完整 URL。
 * @param init - `{ method, headers, body, timeoutMs, zones }`。
 * @returns `{ status, ok, headers, body }`。
 */
function httpsRequestOnce(url, init) {
	return new Promise((resolve, reject) => {
		let parsed;
		try {
			assertTrustedHost(url, init.zones);
			parsed = new URL(url);
		} catch (error) {
			reject(error);
			return;
		}
		const body = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : undefined;
		const headers = { ...(init.headers ?? {}) };
		if (body !== undefined) headers['content-length'] = String(body.length);
		const req = httpsRequest(
			{
				protocol: parsed.protocol,
				hostname: parsed.hostname,
				port: parsed.port === '' ? 443 : Number(parsed.port),
				path: `${parsed.pathname}${parsed.search}`,
				method: init.method ?? 'GET',
				headers,
				// 强制 IPv4：手机上 IPv6 常常「解析得到但连不通」。
				family: 4,
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					const status = res.statusCode ?? 0;
					resolve({
						status,
						ok: status >= 200 && status < 300,
						headers: res.headers,
						body: Buffer.concat(chunks),
					});
				});
			},
		);
		req.setTimeout(init.timeoutMs ?? RPC_TIMEOUT_MS, () => {
			req.destroy(new Error('请求超时'));
		});
		req.on('error', reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

/**
 * 发一个 GET 并返回**响应流**（给 SSE 透传用）。
 *
 * @param url - 完整 URL。
 * @param headers - 请求头（含令牌）。
 * @param zones - 白名单区。
 * @returns `{ status, headers, stream }` 的 Promise。
 */
function httpsStreamOnce(url, headers, zones) {
	return new Promise((resolve, reject) => {
		let parsed;
		try {
			assertTrustedHost(url, zones);
			parsed = new URL(url);
		} catch (error) {
			reject(error);
			return;
		}
		const req = httpsRequest(
			{
				protocol: parsed.protocol,
				hostname: parsed.hostname,
				port: parsed.port === '' ? 443 : Number(parsed.port),
				path: `${parsed.pathname}${parsed.search}`,
				method: 'GET',
				headers,
				family: 4,
			},
			(res) => {
				resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
			},
		);
		// ⚠️ **SSE 不设总超时**，只设建连超时：连上之后它本来就要长活。
		req.setTimeout(20000, () => req.destroy(new Error('连接电脑超时')));
		req.on('socket', (socket) => socket.setTimeout(0));
		req.on('error', reject);
		req.end();
	});
}

/**
 * 把请求体读成字符串（带大小上限）。
 *
 * @param req - IncomingMessage。
 * @returns 请求体的 Promise。
 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > RPC_BODY_LIMIT) {
				reject(new Error(`请求体超过 ${Math.floor(RPC_BODY_LIMIT / (1024 * 1024))} MiB，已拒绝`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/**
 * 回一个 JSON。
 *
 * @param res - ServerResponse。
 * @param status - HTTP 状态码。
 * @param payload - 要序列化的对象。
 */
function sendJson(res, status, payload) {
	if (res.writableEnded === true) return;
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(payload));
}

/**
 * 只在**本机 loopback** 访问时才处理本地桥请求。
 *
 * 引擎的 webserver 在路由命中**之前不做任何鉴权**，所以这个前缀一旦注册，
 * 网络里任何能访问 DSH 端口的人都能打到它。本插件只服务「手机自己 WebView
 * 里的同源页面」，所以 Host 必须是 loopback（与电脑端配对路由取同一条判据）。
 *
 * @param req - IncomingMessage。
 * @returns 是否放行。
 */
function isLoopbackRequest(req) {
	const host = String(req.headers.host ?? '').toLowerCase();
	if (host === '') return false;
	const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
	return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

/**
 * 建本地桥的处理器。
 *
 * @param ctx - Cordis 上下文。
 * @returns `(req, res) => void`。
 */
function createBridge(ctx) {
	/** 当前生效的配置（配对成功后**就地**改写，不必重启）。 */
	let config = loadConfig();

	/**
	 * 打一条上游 RPC。
	 *
	 * @param method - 电脑端的方法名（`ping` / `listSessions` / `prompt` …）。
	 * @param params - 参数。
	 * @returns 上游的 `result`。
	 */
	async function callRemote(method, params) {
		if (config.token === '') throw new Error('尚未配对：请先在「手机远程」里输入电脑上的 6 位配对码');
		if (typeof method !== 'string' || method === '') throw new Error('method required');
		const body = JSON.stringify({ id: randomUUID(), method, params: params ?? {} });
		const res = await httpsRequestOnce(`${config.endpoint}/api/dsh-remote/rpc`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': String(Buffer.byteLength(body, 'utf8')),
				'x-dsh-remote-token': config.token,
			},
			body,
			timeoutMs: RPC_TIMEOUT_MS,
			zones: config.zones,
		});
		if (res.status === 401) throw new Error('电脑拒绝了这台手机的令牌（可能已在电脑上解绑，请重新配对）');
		if (!res.ok) throw new Error(`电脑没有响应（HTTP ${res.status}）`);
		let payload;
		try {
			payload = JSON.parse(res.body.toString('utf8'));
		} catch {
			throw new Error('电脑返回了非 JSON');
		}
		if (payload?.ok !== true) throw new Error(payload?.error ?? '电脑侧调用失败');
		return payload.result;
	}

	/**
	 * 用 6 位配对码领取连接信息。
	 *
	 * ⚠️ **先领、后写盘**：配对码是一次性的，反过来一旦写盘失败，码已经作废。
	 *
	 * @param code - 用户输入的配对码。
	 * @returns 不含令牌的状态快照。
	 */
	async function claimPairing(code) {
		const normalized = String(code ?? '').trim();
		if (normalized === '') throw new Error('请先输入配对码');
		const body = JSON.stringify({ pairCode: normalized });
		const res = await httpsRequestOnce(`${config.pairEndpoint}/pair/claim`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': String(Buffer.byteLength(body, 'utf8')),
			},
			body,
			timeoutMs: PAIR_TIMEOUT_MS,
			zones: config.zones,
		});
		let payload;
		try {
			payload = JSON.parse(res.body.toString('utf8'));
		} catch {
			throw new Error(`配对服务器返回了非 JSON（HTTP ${res.status}）`);
		}
		if (!res.ok) throw new Error(payload?.message ?? payload?.error ?? `配对失败（HTTP ${res.status}）`);
		// ⚠️ 成功响应**没有 `ok` 字段**（只有失败时才有），不能按 `ok === true` 判。
		const hostname = payload?.hostname;
		const token = payload?.accessToken;
		if (typeof hostname !== 'string' || hostname === '' || typeof token !== 'string' || token === '') {
			throw new Error('配对服务器没有返回完整的连接信息');
		}
		const endpoint = `https://${hostname}`;
		assertTrustedHost(endpoint, config.zones);
		config = saveConfig({ ...config, endpoint, token });
		debugLog(`配对成功：${endpoint}（令牌指纹 ${tokenFingerprint(token)}）`);
		return statusOf();
	}

	/**
	 * 给界面的状态快照 —— **绝不含令牌**。
	 *
	 * @returns `{ paired, endpoint, pairEndpoint, platform }`。
	 */
	function statusOf() {
		return {
			paired: config.token !== '',
			endpoint: config.token === '' ? '' : config.endpoint,
			pairEndpoint: config.pairEndpoint,
			zones: config.zones,
			platform: `${process.platform}-${process.arch}`,
		};
	}

	/**
	 * 处理一条本地桥请求。
	 *
	 * @param req - IncomingMessage。
	 * @param res - ServerResponse。
	 */
	return async function handle(req, res) {
		if (!isLoopbackRequest(req)) {
			sendJson(res, 403, { ok: false, error: '本桥只服务本机页面' });
			return;
		}
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';

		try {
			// ---- 状态 ----
			if (route === '/status' && req.method === 'GET') {
				sendJson(res, 200, { ok: true, ...statusOf() });
				return;
			}

			// ---- 配对 ----
			if (route === '/pair' && req.method === 'POST') {
				const text = await readBody(req);
				let payload = {};
				try {
					payload = JSON.parse(text === '' ? '{}' : text);
				} catch {
					throw new Error('请求体不是 JSON');
				}
				const snapshot = await claimPairing(payload.pairCode ?? payload.code);
				sendJson(res, 200, { ok: true, ...snapshot, message: `已连接 ${snapshot.endpoint}` });
				return;
			}

			// ---- 解绑 ----
			if (route === '/unpair' && req.method === 'POST') {
				// ⚠️ 只清本机。电脑端的解绑要用户在电脑上点（那会换令牌、停隧道），
				// 手机端没有权力替它做这件事。
				config = saveConfig({ ...config, token: '' });
				debugLog('本机已解绑（未通知电脑端）');
				sendJson(res, 200, { ok: true, ...statusOf(), message: '已清除本机凭据，请到电脑上重新生成配对码' });
				return;
			}

			// ---- 测试连接 ----
			if (route === '/ping' && req.method === 'POST') {
				const result = await callRemote('ping', {});
				sendJson(res, 200, { ok: true, result });
				return;
			}

			// ---- RPC 转发 ----
			if (route === '/rpc' && req.method === 'POST') {
				const text = await readBody(req);
				if (text.length > RPC_BODY_LIMIT) throw new Error('请求体过大');
				let payload;
				try {
					payload = JSON.parse(text === '' ? '{}' : text);
				} catch {
					throw new Error('请求体不是 JSON');
				}
				const result = await callRemote(payload.method, payload.params);
				sendJson(res, 200, { ok: true, result });
				return;
			}

			// ---- SSE 转发 ----
			if (route === '/stream' && req.method === 'GET') {
				if (config.token === '') {
					sendJson(res, 409, { ok: false, error: '尚未配对' });
					return;
				}
				const sessionId = url.searchParams.get('session');
				if (sessionId === null || sessionId === '') {
					sendJson(res, 400, { ok: false, error: 'session query required' });
					return;
				}
				const fromSeqRaw = url.searchParams.get('fromSeq');
				const fromSeq = fromSeqRaw === null ? null : Number(fromSeqRaw);
				const query = new URLSearchParams({ session: sessionId });
				// ⚠️ `fromSeq` 缺省时**不带**：老版本电脑端会当成「推全量」，与以前一致。
				// 带上是断线重连只补增量（否则「聊得越大越卡」）。
				if (fromSeq !== null && Number.isFinite(fromSeq) && fromSeq >= 0) query.set('fromSeq', String(fromSeq));
				const upstream = await httpsStreamOnce(
					`${config.endpoint}/api/dsh-remote/stream?${query.toString()}`,
					{ accept: 'text/event-stream', 'x-dsh-remote-token': config.token },
					config.zones,
				);
				if (upstream.status !== 200) {
					sendJson(res, 502, { ok: false, error: `电脑的事件流没有建立（HTTP ${upstream.status}）` });
					return;
				}
				res.writeHead(200, {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-store, no-transform',
					connection: 'keep-alive',
					// 关掉反代缓冲，否则逐字动画会攒成一次性出现。
					'x-accel-buffering': 'no',
				});
				res.write(': connected\n\n');
				upstream.stream.on('data', (chunk) => {
					if (res.writableEnded === true) return;
					try {
						res.write(chunk);
					} catch {
						upstream.stream.destroy();
					}
				});
				upstream.stream.on('end', () => {
					if (res.writableEnded !== true) res.end();
				});
				upstream.stream.on('error', () => {
					if (res.writableEnded !== true) res.end();
				});
				// 浏览器关掉这条连接时，上游也要停 —— 否则手机上会攒住一堆打向电脑的空连接。
				req.on('close', () => upstream.stream.destroy());
				return;
			}

			sendJson(res, 404, { ok: false, error: `未知路由：${route}` });
		} catch (error) {
			debugLog(`桥请求失败 ${route}: ${String(error?.message ?? error)}`);
			sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/**
 * 插件入口。
 *
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx) {
	const handle = createBridge(ctx);
	const routes = [`${ROUTE_PREFIX}/status`, `${ROUTE_PREFIX}/pair`, `${ROUTE_PREFIX}/unpair`, `${ROUTE_PREFIX}/ping`, `${ROUTE_PREFIX}/rpc`, `${ROUTE_PREFIX}/stream`];

	// ⚠️ 只注册 `prefix` 一条：`register()` 对重复的 `(kind, path)` 会抛错，
	// 而 exact 与 prefix 是两张表 —— 同时注册很容易踩重。
	if (typeof ctx.webServer?.register !== 'function') {
		ctx.logger?.warn?.('[dsh-remote-android] webServer 不可用，配对与桥接都无法工作');
		return;
	}
	ctx.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: (req, res) => {
			void handle(req, res);
		},
	});

	const state = loadConfig();
	ctx.logger?.info?.(
		`[dsh-remote-android] 本地桥已挂在 ${ROUTE_PREFIX}（${routes.length} 条路由）；` +
			`远端 ${state.token === '' ? '未配对' : state.endpoint}（令牌指纹 ${state.token === '' ? '-' : tokenFingerprint(state.token)}）`,
	);
	debugLog(`启动：远端 ${state.token === '' ? '未配对' : state.endpoint}`);
}

export { ROUTE_PREFIX, CONFIG_PATH, loadConfig, saveConfig, assertTrustedHost };
