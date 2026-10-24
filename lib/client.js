/**
 * dsh-jiuling-remote-android —— 安卓端（client half，跑在手机的 DSH Web GUI 里）。
 *
 * 只在**设置**里加一页「手机远程」：输 6 位配对码、看连接状态、测试、解绑。
 *
 * ## ⚠️ 这一页为什么这么薄
 *
 * 真正的动作（claim 配对码、落盘凭据、打上游 RPC）全在 host 半边。页面只发一个
 * **同源** `fetch` 到 `/api/dsh-remote/android/*`，响应里**没有令牌** —— 令牌是
 * 那台电脑的门钥匙，只该待在引擎进程里。
 *
 * ## ⚠️ 语法约束（旧内核）
 *
 * 安卓 App 里有按 chrome73 降级编译的前端 bundle，所以这里**不用**可选链 `?.`、
 * 空值合并 `??`、`Object.fromEntries`、`Array.flat`。
 *
 * @module dsh-jiuling-remote-android/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-jiuling-remote-android',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		var react = require('react');
		var h = react.createElement;

		/** 官方 UI 原子组件：自己手搓 div + 写死颜色会跟官方 UI 脱钩。 */
		var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		var Button = primitives.Button;
		var Input = primitives.Input;
		var Pill = primitives.Pill;

		/** 本地桥的路由（同源，相对路径）。 */
		var API = '/api/dsh-remote/android';

		/**
		 * 调一条本地桥接口。
		 *
		 * @param action - `/status` / `/pair` / `/unpair` / `/ping`。
		 * @param body - 请求体；不传就发 GET。
		 * @returns 结果的 Promise（**永不 reject**，失败也返回 `{ok:false, error}`）。
		 */
		function call(action, body) {
			var options = { cache: 'no-store' };
			if (body !== undefined) {
				options.method = 'POST';
				options.headers = { 'content-type': 'application/json' };
				options.body = JSON.stringify(body);
			}
			return fetch(API + action, options).then(
				function (response) {
					return response.json().then(
						function (payload) {
							return payload;
						},
						function () {
							return { ok: false, error: '宿主返回的不是 JSON（HTTP ' + response.status + '）' };
						},
					);
				},
				function (error) {
					return { ok: false, error: '无法连接宿主服务：' + String((error && error.message) || error) };
				},
			);
		}

		// ---------------------------------------------------------------- 样式
		//
		// ⚠️ 只声明**真实存在**的官方设计令牌（`--dsw-alias-*`）。写不存在的令牌
		// 不会报错，会静默走 fallback —— 那是「看着不对劲又查不出原因」的典型来源。

		var CSS_TEXT = {
			page: 'display:flex;flex-direction:column;gap:16px;padding:4px 0 24px;max-width:640px;',
			card: 'display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);',
			title: 'color:var(--dsw-alias-label-primary);font-size:14px;font-weight:510;line-height:22px;margin:0;',
			desc: 'color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0;',
			hint: 'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0;',
			row: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;',
			error: 'color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;margin:0;',
			ok: 'color:var(--dsw-alias-state-success-primary,#3fb950);font-size:13px;line-height:20px;margin:0;',
			kv: 'display:flex;gap:8px;align-items:baseline;',
			kvKey: 'color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:72px;',
			kvVal: 'color:var(--dsw-alias-label-primary);font-size:13px;word-break:break-all;',
			code: 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:4px;',
		};

		/**
		 * 把 CSS 文本解析成 React 的 style **对象**。
		 *
		 * ⚠️ 不能省：React 的 `style` 只收对象，给字符串会当场抛 #62，
		 * 组件随即被 slot 系统退役 —— 表现是「设置里根本没有这一页」。
		 *
		 * @param text - `'a:1;b:2;'` 形式的声明串。
		 * @returns React style 对象。
		 */
		function toStyle(text) {
			var out = {};
			var parts = String(text).split(';');
			for (var index = 0; index < parts.length; index += 1) {
				var part = parts[index];
				if (part === '') continue;
				var colon = part.indexOf(':');
				if (colon < 0) continue;
				var key = part.slice(0, colon).trim();
				var value = part.slice(colon + 1).trim();
				if (key === '' || value === '') continue;
				out[key.replace(/-([a-z])/g, function (match, letter) {
					return letter.toUpperCase();
				})] = value;
			}
			return out;
		}

		var CSS = {};
		for (var styleKey in CSS_TEXT) CSS[styleKey] = toStyle(CSS_TEXT[styleKey]);

		/** 一行「键: 值」。 */
		function kv(key, value) {
			return h(
				'div',
				{ key: 'kv-' + key, style: CSS.kv },
				h('span', { style: CSS.kvKey }, key),
				h('span', { style: CSS.kvVal }, value),
			);
		}

		// ------------------------------------------------------------ 设置页

		/**
		 * 「手机远程」设置页：未配对填码 / 已配对看状态。
		 */
		function RemoteAndroidPanel() {
			var statusState = react.useState(null);
			var status = statusState[0];
			var setStatus = statusState[1];

			var codeState = react.useState('');
			var code = codeState[0];
			var setCode = codeState[1];

			var busyState = react.useState('');
			var busy = busyState[0];
			var setBusy = busyState[1];

			var msgState = react.useState(null);
			var message = msgState[0];
			var setMessage = msgState[1];

			/** 刷新状态。 */
			var reload = react.useCallback(function () {
				return call('/status').then(function (payload) {
					if (payload && payload.ok === true) setStatus(payload);
					else setMessage({ kind: 'error', text: (payload && payload.error) || '读取状态失败' });
				});
			}, []);

			react.useEffect(function () {
				reload();
			}, [reload]);

			/** 提交配对码。 */
			var submit = react.useCallback(
				function () {
					if (code.trim() === '') {
						setMessage({ kind: 'error', text: '请先输入电脑上显示的 6 位配对码' });
						return;
					}
					setBusy('pair');
					setMessage(null);
					call('/pair', { pairCode: code.trim() }).then(function (payload) {
						setBusy('');
						if (payload && payload.ok === true) {
							setStatus(payload);
							setCode('');
							setMessage({ kind: 'ok', text: payload.message || '配对成功' });
						} else {
							setMessage({ kind: 'error', text: (payload && payload.error) || '配对失败' });
						}
					});
				},
				[code],
			);

			/** 测试连接（打一次电脑的 ping）。 */
			var ping = react.useCallback(function () {
				setBusy('ping');
				setMessage(null);
				call('/ping', {}).then(function (payload) {
					setBusy('');
					if (payload && payload.ok === true) {
						var result = payload.result || {};
						setMessage({
							kind: 'ok',
							text: '已连上电脑（' + String(result.platform || '?') + '）',
						});
					} else {
						setMessage({ kind: 'error', text: (payload && payload.error) || '连接失败' });
					}
				});
			}, []);

			/** 解绑（只清本机）。 */
			var unpair = react.useCallback(function () {
				setBusy('unpair');
				setMessage(null);
				call('/unpair', {}).then(function (payload) {
					setBusy('');
					if (payload && payload.ok === true) {
						setStatus(payload);
						setMessage({ kind: 'ok', text: payload.message || '已解绑' });
					} else {
						setMessage({ kind: 'error', text: (payload && payload.error) || '解绑失败' });
					}
				});
			}, []);

			if (status === null) {
				return h('div', { style: CSS.page }, h('p', { style: CSS.hint }, '正在读取配对状态…'));
			}
			if (status.ok === false) {
				return h(
					'div',
					{ style: CSS.page },
					h('p', { style: CSS.error }, status.error || '宿主没有返回状态'),
				);
			}

			var children = [];

			// ---- 状态卡片 ----
			children.push(
				h(
					'div',
					{ key: 'status', style: CSS.card },
					h('h3', { style: CSS.title }, '这台手机连的电脑'),
					h(
						'p',
						{ style: CSS.desc },
						'配对后，这台手机就能经 Cloudflare 隧道连到那台电脑的 DSH。公网只传文字，不映射桌面。',
					),
					h(
						'div',
						{ style: CSS.row },
						status.paired === true ? h(Pill, { active: true }, '已配对') : h(Pill, null, '未配对'),
						h(
							'span',
							{ style: CSS.hint },
							status.paired === true ? status.endpoint : '还没有连接任何电脑',
						),
					),
					kv('平台', String(status.platform || '')),
					kv('配对服务', String(status.pairEndpoint || '')),
					status.paired === true
						? h(
								'div',
								{ style: CSS.row },
								h(
									Button,
									{ variant: 'outline', size: 'sm', onClick: ping, disabled: busy !== '' },
									busy === 'ping' ? '正在测试…' : '测试连接',
								),
								h(
									Button,
									{ variant: 'ghost', size: 'sm', onClick: unpair, disabled: busy !== '' },
									busy === 'unpair' ? '正在解绑…' : '解绑',
								),
							)
						: null,
				),
			);

			// ---- 配对卡片（未配对时） ----
			if (status.paired !== true) {
				children.push(
					h(
						'div',
						{ key: 'pair', style: CSS.card },
						h('h3', { style: CSS.title }, '输入配对码'),
						h(
							'p',
							{ style: CSS.desc },
							'在电脑的 DSH 里打开「设置 → 手机远程」→「生成配对码」，把屏幕上的 6 位码填到这里。码 10 分钟内有效，用一次即作废。',
						),
						h(
							'div',
							{ style: CSS.row },
							h(Input, {
								value: code,
								onChange: function (event) {
									setCode(event.target.value);
								},
								placeholder: '例如 A7K2M9',
								'aria-label': '配对码',
								style: Object.assign({}, CSS.code, { minWidth: '160px', textTransform: 'uppercase' }),
							}),
							h(
								Button,
								{ variant: 'primary', size: 'md', onClick: submit, disabled: busy !== '' },
								busy === 'pair' ? '正在配对…' : '连接',
							),
						),
						h('p', { style: CSS.hint }, '手机上必须有网络；配对成功后凭据只存在本机，不会回显到页面里。'),
					),
				);
			}

			if (message !== null) {
				children.push(
					h('p', { key: 'message', style: message.kind === 'ok' ? CSS.ok : CSS.error }, message.text),
				);
			}

			children.push(
				h(
					'div',
					{ key: 'refresh', style: CSS.row },
					h(Button, { variant: 'ghost', size: 'sm', onClick: reload, disabled: busy !== '' }, '刷新状态'),
				),
			);

			return h('div', { style: CSS.page }, children);
		}

		// ------------------------------------------------------------ 注册进设置

		var SLOT = 'settings.section';
		var CELL_ID = 'dsh-jiuling-remote-android';
		var inject = ['slots'];

		/**
		 * 注册设置页。
		 *
		 * ⚠️ 整段包在 `try` 里：设置页挂不上只是不好看，绝不能因此把整批客户端
		 * 插件一起拖垮（那会让界面停在 `Failed to load plugins`）。
		 */
		function apply(ctx) {
			try {
				ctx.slots.inject(SLOT, function () {
					return ctx.slots.register(
						{
							name: SLOT,
							id: CELL_ID,
							// 排在官方页面之后，不打乱官方顺序。
							order: 215,
							label: '手机远程',
						},
						RemoteAndroidPanel,
					);
				});
			} catch (error) {
				try {
					console.warn('[dsh-jiuling-remote-android] 设置页注册失败（已忽略）:', error);
				} catch (ignored) {
					/* 连 console 都没有也不能炸 */
				}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
