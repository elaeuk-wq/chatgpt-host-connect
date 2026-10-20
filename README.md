# muse-chatgpt-setup

一个 Agent Skill：把**已登录**的 ChatGPT 账号和**已登录**的 Muse 账号，通过 OpenAI Secure MCP Tunnel 连起来，让 ChatGPT 能真正驱动 Muse 云 VM 上的工具并拿回真实结果。

> 不是示意图、不是占位符 —— 每一步都在真实账号上跑过，验收标准是**双侧日志毫秒对齐**。

---

## 它能做到什么

| 档位 | 能力 | 状态 |
|---|---|---|
| **B 档** | ChatGPT 调用一个工具 → 请求真的进入 Muse 的 VM 执行 → 结果原样回到 ChatGPT（含主机名、实时 UTC、调用方一次性 token 回显） | ✅ 已实测通过 |
| **A 档** | ChatGPT 给 Muse 发一条消息 → Muse agent 处理 → 回话 | ❌ 平台不提供该接口 |

A 档需要 Muse 原生 MCP 网关（`muse_send` / `muse_history`）。没有它时，本 skill 会明确产出 `NOT VERIFIED`，**不会把 B 档写成 A 档**。

---

## 快速开始

### 1. 安装

任选一个位置（推荐第一种，项目未信任时也能加载）：

```bash
# 用户级（永远可信）
cp -r skills/muse-chatgpt-setup ~/.agents/skills/

# 或项目级（需要该项目已信任）
cp -r skills/muse-chatgpt-setup <你的项目>/.pi/skills/
```

然后在会话里说 **"connect ChatGPT and Muse"**，或强制加载 `/skill:muse-chatgpt-setup`。

### 2. 前提

- 一个**已经登录**的 OpenAI Platform / ChatGPT / Muse 会话（skill 不创建账号、不代填密码）
- 宿主具备**浏览器控制能力**（Playwright / CDP / 任何能读页面状态的工具）
- 用户本人可点击授权卡（登录、OAuth、出网审批）

### 3. 四步主路径

| 步 | 位置 | 动作 | 实测耗时 |
|---|---|---|---|
| 1 | platform.openai.com | 建专用 Tunnel + Restricted Key（仅 Tunnels: Read + Use，30 天） | 28 s |
| 2 | Muse 聊天 | 粘一条 bootstrap 消息，它自己在自己 VM 上装好 | 98 s |
| 3 | chatgpt.com/plugins | 加自定义 MCP 服务器 → **隧道** → 选 Tunnel → 唯一命名 | 38 s |
| 4 | ChatGPT 对话 | 用一次性 token 调工具，双侧日志核对 | 35 s |

**基础设施已存在时约 4–5 分钟；从零（含建 MCP、发 Key）约 10–13 分钟。**

---

## 实测记录（2026-10-20）

```
ChatGPT → {"executed_by":"muse-mcp process inside the Muse VM (subprocess, no shell)",
           "cmd":"status_echo","hostname_output":"htch-runtime",
           "date_output_utc":"2026-10-20T11:39:53.199Z",
           "echo_token":"final-kd8t2nin"}
```

对照两侧日志：

- `tunnel.log`：`dispatcher forwarded command to MCP server`，带 `tunnel_id` 与 `cmd_request_id`
- MCP 日志：同秒 `POST /mcp 200`
- 载荷内嵌时间戳与 MCP 日志戳**毫秒级吻合**；两次调用返回值不同（证明非写死）

---

## 踩过的坑（都已写进 SKILL.md）

| 症状 | 原因 | 修法 |
|---|---|---|
| `McpServerError: Connection timed out` | 云端 VM 被换机，`/etc` 里的 unit 没了 | 在 `$HOME` 放 unit 正本 + `restore.sh` |
| `McpServerError: Session terminated` | 只重启了 MCP，隧道还挂着旧会话 | 重启顺序：MCP → 等端口 → tunnel |
| `/readyz` 503 但 poll 正常 | 隧道比 MCP 早 40ms 启动，失败的 discovery 被缓存 | 串行启动 |
| 工具"不存在"，但服务端确实列了 | 连接器在发现时缓存了工具清单**和描述** | 新建连接器；`刷新工具` 无效 |
| 授权卡每次都弹 | 权限是一次性的 | 选 **始终允许** |
| 授权卡报"可疑指令" | 工具描述里自我论证"无害" | 描述只写事实 |
| 轮询一直失败 | 云端出口代理拦带 `Authorization` 的请求 | 批准 `api.openai.com` 时选 **Always allow** |

---

## 安全边界

- **Tunnel ID 不是秘密，API Key 是。** Key 绝不进聊天正文、URL、命令行、日志、截图。
- Key 只走：`Restricted`（Tunnels Read + Use）+ 30 天 + 附件投递 + 落地 `0600` 文件 + 首次 PASS 后轮换。
- 不存在"能用但 agent 读不到"的通道 —— `SKILL.md` 里直说了，不编。
- 全程不碰用户已有的 tunnel、连接器、其他 MCP 服务。

---

## 仓库结构

```
skills/muse-chatgpt-setup/
├── SKILL.md                      # runbook：4 步主路径 + 排错表 + Limits
└── references/muse-bootstrap.md  # 3 条可直接粘贴的消息（建 / 交 Key / 排障）
```

---

## License

MIT
