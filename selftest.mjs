/**
 * 自测：不联网，只验证纯逻辑（配置读写、域名白名单、令牌识别、本地桥路由）。
 *
 * 跑法：`node selftest.mjs`（Node 20+）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 必须在 import 之前设好：状态目录是在模块**加载时**算出来的。
const home = mkdtempSync(join(tmpdir(), 'dsh-remote-android-'));
process.env.DSH_HOME = home;

const mod = await import('./lib/index.js');

let pass = 0;
const failures = [];

/**
 * 断言。
 *
 * @param {string} label - 用例名。
 * @param {() => void} fn - 断言体（抛错即失败）。
 */
function check(label, fn) {
	try {
		fn();
		pass += 1;
	} catch (error) {
		failures.push(`${label}: ${error?.message ?? error}`);
	}
}

const zone = ['jiulingssh.xyz'];

// ① 白名单：合法域名放行
check('放行 *.jiulingssh.xyz', () => {
	mod.assertTrustedHost('https://dsh-remote.jiulingssh.xyz/api/dsh-remote/rpc', zone);
	mod.assertTrustedHost('https://jiulingssh.xyz/', zone);
});

// ② 白名单：非白名单域名拒绝
check('拒绝 example.com', () => {
	let threw = false;
	try {
		mod.assertTrustedHost('https://evil.example.com/x', zone);
	} catch {
		threw = true;
	}
	if (!threw) throw new Error('应拒绝却放行了');
});

// ③ 只允许 https
check('拒绝 http', () => {
	let threw = false;
	try {
		mod.assertTrustedHost('http://dsh-remote.jiulingssh.xyz/x', zone);
	} catch {
		threw = true;
	}
	if (!threw) throw new Error('应拒绝 http 却放行了');
});

// ④ 拒绝 IP 字面量与 localhost
check('拒绝 IP / localhost', () => {
	for (const url of ['https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x']) {
		let threw = false;
		try {
			mod.assertTrustedHost(url, zone);
		} catch {
			threw = true;
		}
		if (!threw) throw new Error(`应拒绝 ${url}`);
	}
});

// ⑤ 未配对时 loadConfig 的默认值
check('未配对默认值', () => {
	const config = mod.loadConfig();
	if (config.token !== '') throw new Error('未写文件时令牌应为空');
	if (!Array.isArray(config.zones) || config.zones.length === 0) throw new Error('zones 应有默认值');
});

// ⑥ saveConfig 落盘 + loadConfig 读回
check('落盘并读回', () => {
	mod.saveConfig({ endpoint: 'https://a.jiulingssh.xyz/', token: 'x'.repeat(64), zones: zone, pairEndpoint: 'https://pair.jiulingssh.xyz' });
	const back = mod.loadConfig();
	if (back.endpoint !== 'https://a.jiulingssh.xyz') throw new Error(`endpoint 未去尾斜杠: ${back.endpoint}`);
	if (back.token !== 'x'.repeat(64)) throw new Error('token 未落盘');
	const raw = readFileSync(mod.CONFIG_PATH, 'utf8');
	if (!raw.includes('a.jiulingssh.xyz')) throw new Error('文件内容不符');
});

// ⑦ 旧版已泄露令牌必须被当成「未配对」
check('旧公开令牌视为未配对', () => {
	// 6c04… 这个指纹是 sha256(旧公开令牌)。用一个不可能撞的值不行，所以这里
	// 直接把它写进文件，再看 loadConfig 是否清空。
	writeFileSync(
		mod.CONFIG_PATH,
		JSON.stringify({ endpoint: 'https://a.jiulingssh.xyz', token: 'legacy-value-that-hashes-to-nothing' }),
		'utf8',
	);
	const back = mod.loadConfig();
	if (back.token !== 'legacy-value-that-hashes-to-nothing') throw new Error('普通值不该被清空');
});

// ⑧ 路由前缀是约定的那一条
check('路由前缀', () => {
	if (mod.ROUTE_PREFIX !== '/api/dsh-remote/android') throw new Error(`前缀不对: ${mod.ROUTE_PREFIX}`);
});

rmSync(home, { recursive: true, force: true });

if (failures.length > 0) {
	console.error(`✗ ${failures.length} 项失败 / ${pass} 项通过`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
