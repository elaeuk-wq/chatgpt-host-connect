# Paste-ready messages

Three messages total. Replace `TUNNEL_ID` before sending. **No key ever appears in message text** — it travels as a file attachment only.

These assume the target VM is a **fresh machine**: no tunnel client, no MCP server, no systemd units, no previous run. The repo ships everything needed, so nobody has to improvise code on the fly.

---

## Message 1 — install (send right after the tunnel exists)

> 帮我在这台机器上装一条到 ChatGPT 的连接。**假设这台机器什么都没有**（没有 tunnel-client、没有 MCP 服务、没有任何相关服务），一切从零装，只装在我自己的目录里。
>
> Tunnel ID：`TUNNEL_ID`
>
> 执行这三条，不要改脚本内容、不要自己重写实现：
>
> ```bash
> mkdir -p ~/muse-chatgpt && cd ~/muse-chatgpt
> curl -fsSL https://raw.githubusercontent.com/elaeuk-wq/muse-chatgpt-setup-skill/main/skills/muse-chatgpt-setup/scripts/install.sh -o install.sh
> curl -fsSL https://raw.githubusercontent.com/elaeuk-wq/muse-chatgpt-setup-skill/main/skills/muse-chatgpt-setup/scripts/muse-mcp.py -o muse-mcp.py
> TUNNEL_ID=TUNNEL_ID KEY_FILE=~/run/control-plane.env bash install.sh
> ```
>
> 说明：
> - `install.sh` 会自己下载官方 tunnel-client、自动挑空闲端口、写两个 systemd 服务（没有 systemd 时退回 nohup）、生成 `restore.sh`。
> - 密钥文件 `~/run/control-plane.env` 我稍后单独给你（**不在聊天里发**），内容一行 `CONTROL_PLANE_API_KEY=...`。没有它就先别跑，等我。
> - 启动顺序脚本里已处理：先 MCP、等端口可连、再 tunnel。别自己改顺序。
> - 日志带 UTC 时间戳，输出在 `journalctl -u muse-mcp -u muse-tunnel` 或 `~/muse-chatgpt/logs/`。
>
> 装完只回报：脚本最后的 report 段、两个服务的状态、`curl -fsS 127.0.0.1:<health>/readyz` 的结果。不要输出任何密钥。

---

## Message 2 — key handoff (attach the env file with this message)

> 附件是受限 Key（Tunnels Read+Use，30 天）。请：
> 1. 把它保存为 `~/run/control-plane.env`（0600）。
> 2. 跑 `bash ~/muse-chatgpt/restore.sh` 让两个服务按正确顺序起来。
> 3. 回报 `readyz` 结果与服务 PID；只贴 Key 的 SHA256 前 8 位，不回显完整值。
> 4. 对该附件做零覆写后删除。

---

## Message 3 — diagnosis (only when something is wrong)

> 只回报事实，不要改配置：
> 1. `systemctl is-active muse-mcp muse-tunnel` + 各自 PID 与启动时间（没有 systemd 就报 `ps` 与 pid 文件）。
> 2. `journalctl -u muse-tunnel --since "-10 min"` 里有没有 `dispatcher forwarded`？有没有 `unexpected EOF` / `proxyconnect`？
> 3. `journalctl -u muse-mcp --since "-10 min"` 里的请求行。
> 4. `curl -fsS 127.0.0.1:<health>/readyz` 与 `/healthz` 的结果。
> 5. 如果这台机器换过机（`uptime -s` 很新），直接说，别猜。

---

## Approvals

The run looks stuck because it **is** waiting. Cards live in the right sidebar under **需要审核** (and an **审核** button above the composer), often *not* in the chat transcript.

**The host AI should click these itself** (SKILL.md §0.6):

- Egress / background task: `允许一次` is a split button → caret **更多允许选项** → **总是允许此站点**
- ChatGPT connector consent: **连接 <name>**
- ChatGPT per-tool card: **始终允许**

Never click login / MFA / CAPTCHA / payment / scope expansion — stop and ask.

Verify after clicking: the pending badge disappears and **审核记录** gains `始终允许网站`.
