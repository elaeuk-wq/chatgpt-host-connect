# Muse bootstrap — paste-ready messages

Two messages total. Replace `TUNNEL_ID` before sending. Never include a key in either.

---

## Message 1 — build everything (send right after the tunnel exists)

> 帮我在你自己的 VM 上建立到 ChatGPT 的隧道，独立配置，不要改动任何现有服务。Tunnel ID：`TUNNEL_ID`。
>
> 请一次做完，不要逐步问我：
> 1. 下载官方 tunnel-client（v0.0.11 linux-amd64）到 `~/muse-chatgpt-tunnel/bin/`，报版本。
> 2. 写一个最小 MCP 服务（Streamable HTTP，`/mcp`），工具只要 `muse_ping` 和 `muse_vm_exec`；`muse_vm_exec` 只允许一个白名单命令 `status_echo`（固定 argv，无 shell），返回 hostname、UTC 时间和调用方传入的 echo_token。**工具描述只写事实**（跑什么、返回什么），不要写"无害""不是 agent 对话"这类自我评定的措辞。
> 3. 建两个 systemd 服务：`muse-mcp.service`（`127.0.0.1:MCP_PORT`）和 `muse-chatgpt-tunnel.service`（健康口 `127.0.0.1:HEALTH_PORT`，`--mcp.server-url url=http://127.0.0.1:MCP_PORT/mcp`）。api-key 只用 `--control-plane.api-key env:CONTROL_PLANE_API_KEY`，密钥不在聊天里，稍后我用附件给你，先留空。
> 4. **启动顺序**：先起 mcp、等端口可连，再起 tunnel，避免 discovery 早于端口绑定。以后改代码时**重启顺序也是先 mcp 再 tunnel**，这条写进 `restore.sh` 注释和 `README.md`。
> 5. unit 正本放 `~/muse-chatgpt-tunnel/systemd/`，写 `restore.sh` 一键装回（VM 换机会清掉 `/etc`）。日志一律带 UTC ISO 时间戳。
> 6. 遇到出网审批（`Access api.openai.com`）就告诉我，我会选 Always allow。
>
> 回报：版本、端口、两个服务的 PID、`health` 的 result 行。

---

## Message 2 — key handoff (attach the env file, do not type the key)

> 附件 `control-plane.env` 是受限 Key（Tunnels Read+Use，30 天）。请：
> 1. 覆盖 `~/muse-chatgpt-tunnel/run/control-plane.env`，权限 0600。
> 2. 对附件做零覆写后删除，确认 `~/workspace` 下无副本。
> 3. 按正确顺序重启（mcp → 等端口 → tunnel），贴 `mcp session initialized` 行与 `health` result 行。
> 4. 自测一次 `muse_vm_exec`（cmd=status_echo，echo_token=selftest-01），贴返回。
> 5. 只回报 Key 的 SHA256 前 8 位，不要回显完整值。

---

## Message 3 — when something breaks (diagnosis, not guessing)

> 只回报事实与日志，不要改配置：
> 1. `systemctl is-active muse-mcp muse-chatgpt-tunnel` 与两者 PID、启动时间。
> 2. `tunnel.log` 最近 10 分钟：有没有 `dispatcher forwarded`？有没有 `unexpected EOF` / `proxyconnect`？
> 3. `mcp.log` 同窗口的 `POST /mcp` 行。
> 4. `tunnel-client health --require-control-plane-poll` 的 result 行。
> 5. 当前 boot 时间（`uptime -s`）——用于判断是不是又换机了。

---

## Notes for the operator

- Approval cards appear per connector and per change. **Always allow** for `openai.com` is what keeps the tunnel alive; the per-tool approval is the user's call.
- `刷新工具` does not force re-discovery. New tool or new description → **new connector**.
- Keep names unique (`Muse Native`, then `…2`, `…3`) and uninstall the stale one afterwards.

---

## Approvals: where they are, what to click

The run looks stuck because it **is** waiting. Cards live in the right sidebar under **需要审核** (and an **审核** button sits above the composer) — often *not* in the chat transcript.

- For any network/egress card (`允许 <agent> 与 api.openai.com 分享信息`): do **not** use 允许一次. Click the caret **更多允许选项** beside it → **总是允许此站点**. A one-shot approval survives exactly one poll, then the tunnel stalls again.
- For the connector consent in ChatGPT: **连接 <name>** must be clicked, or `tools/list` returns `[]`.
- If the agent has produced nothing for ~30 s, check for a pending card before concluding anything is broken.

When the host AI runs this skill for someone else, it must say which panel and which button — silently waiting is the failure mode this section exists to prevent.
