# dsh-jiuling-remote-android

DSH 远程目录的**安卓端**插件。配合电脑端的 [`dsh-jiuling-remote-desktop`](https://www.npmjs.com/package/dsh-jiuling-remote-desktop) 使用：手机输一个 6 位配对码，就能经 Cloudflare 隧道连到那台电脑的 DSH —— **公网只传文本，不映射桌面**。

## 这一版做了什么

| 能力 | 状态 |
|---|---|
| 6 位配对码换凭据（claim → 落盘） | ✅ |
| 凭据只存在引擎进程，页面永不回显令牌 | ✅ |
| 本地 RPC 桥 `/api/dsh-remote/android/rpc` | ✅ |
| 本地 SSE 桥 `/api/dsh-remote/android/stream`（含 `fromSeq` 增量重连） | ✅ |
| 设置页「手机远程」：配对 / 测试 / 解绑 / 状态 | ✅ |
| 在「选择文件夹」弹窗里加「电脑」页签 | ❌ 未实现（见下） |
| 把电脑的对话事件镜像进手机本地会话 | ❌ 未实现（见下） |
| 模型 / 预设按工作区隔离、流式逐字动画 | ❌ 未实现（见下） |

后三项依赖官方 `directoryFlow` slot 契约与 `sessionController.prompt` 拦截，必须在真机上反复调试才敢交付。本版刻意只做**可离线验证**的那一层：配对、凭据、桥接。

## 安装

```bash
# 在手机的 DSH profile 里
pnpm add -w dsh-jiuling-remote-android
```

插件是 bundle 型（`cordis.patch.yml` 会 insert 一行到 loader 树），装完重启 DSH 生效。

## 使用

1. **电脑上**：设置 → 手机远程 → 填激活码绑定 → 生成配对码（屏幕显示 6 位码）。
2. **手机上**：设置 → 手机远程 → 输入那 6 位码 → 连接。
3. 点「测试连接」应显示已连上电脑的 `platform`。

配对码是一次性的，10 分钟过期；换电脑重新配对即可。

## 桥接接口

全部挂在 DSH 自己的 Web 端口上（**同源**），且**只接受 loopback Host**：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/dsh-remote/android/status` | 配对状态（不含令牌） |
| POST | `/api/dsh-remote/android/pair` | `{pairCode}` → claim 并落盘 |
| POST | `/api/dsh-remote/android/unpair` | 只清本机凭据 |
| POST | `/api/dsh-remote/android/ping` | 打一次电脑的 `ping` |
| POST | `/api/dsh-remote/android/rpc` | `{method, params}` → 转发电脑的 `/api/dsh-remote/rpc` |
| GET | `/api/dsh-remote/android/stream?session=…&fromSeq=…` | SSE 原样透传 |

RPC 可用的方法以电脑端实现为准（`ping` / `listSessions` / `createSession` / `prompt` / `cancel` / `listDirectory` / `fileList` / `fileRead` / `modelCatalog` / `presetList` / `answerAsk` …）。

## 安全设计

- **令牌不入页面**：落盘在 `$DSH_HOME/dsh-remote-android/config.json`（`0600`），响应体里只有 `paired` / `endpoint`。
- **令牌不走 URL query**：只在 `x-dsh-remote-token` 头里，避免进隧道日志与 access log。
- **不跟随重定向**：`302` 跨源会把令牌带到攻击者主机上，所以 3xx 一律当错误。
- **域名白名单**：只往 `*.jiulingssh.xyz` 发凭据（`config.json` 的 `zones` 可改，自建部署不用改源码）。
- **拒绝 IP 字面量 / localhost / 明文 http**：防 DNS rebinding 与裸奔。
- **桥只服务本机页面**：Host 不是 loopback 直接 403（引擎的 webserver 在路由命中前不做鉴权）。
- **旧版公开令牌识别**：见到已泄露的历史常量当「未配对」，不会拿它去连。

## 配置

`$DSH_HOME/dsh-remote-android/config.json`：

```json
{
  "endpoint": "https://<你的隧道>.jiulingssh.xyz",
  "token": "<配对后由服务器下发>",
  "zones": ["jiulingssh.xyz"],
  "pairEndpoint": "https://pair.jiulingssh.xyz"
}
```

也可用环境变量 `DSH_REMOTE_ENDPOINT` / `DSH_REMOTE_PAIR_ENDPOINT` 覆盖默认值。

## 已知限制

- **未在真机验证**：本版只跑过离线自测（`node selftest.mjs`），域名白名单 / 配置读写 / 令牌识别这些纯逻辑。真机上「配对 → 桥接」链路的端到端验证需要电脑端同时在线。
- 手机端**不跑 LLM**，也不镜像电脑的对话；本版只把管道铺好，聊天镜像留给后续版本。
- 电脑端若在设置里「解绑」过，手机会一直显示已配对而实际 401 —— 请在手机上点「解绑」再重新配对。

## 开发

```bash
node --check lib/index.js   # 语法
node selftest.mjs           # 离线自测（8 项）
```

## 许可

MIT
