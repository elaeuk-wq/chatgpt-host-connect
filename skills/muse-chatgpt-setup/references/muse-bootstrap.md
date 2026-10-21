# Messages for the Muse agent

`muse-setup.mjs` sends these itself. `node scripts/browser/muse-setup.mjs message install|restore|logs`
prints them with this run's values, for sending by hand during a takeover.

Rules for all of them: the key travels only as an **attached file**, never in message text; scripts
are fetched from the release tag `v1.0.0`, not from `main`; the Muse agent runs them unchanged.

---

## Install (attach the key file to this message)

Replace `TUNNEL_ID`; attach `control-plane-key-<run>.txt` (one line `CONTROL_PLANE_API_KEY=sk-...`).

```text
请在这台机器上安装一条到 ChatGPT 的连接，全部装在 ~/muse-chatgpt，不要动其他服务。

附件 control-plane-key-<run>.txt 是 API Key 文件：不要打开、不要打印或复述它的内容。先找到它在这台机器上的路径，记为 KEY_PATH。

然后原样执行（不要改脚本，不要自己重写实现）：

mkdir -p ~/muse-chatgpt && cd ~/muse-chatgpt
curl -fsSL https://raw.githubusercontent.com/elaeuk-wq/muse-chatgpt-setup-skill/v1.0.0/skills/muse-chatgpt-setup/scripts/install.sh -o install.sh
curl -fsSL https://raw.githubusercontent.com/elaeuk-wq/muse-chatgpt-setup-skill/v1.0.0/skills/muse-chatgpt-setup/scripts/muse-mcp.py -o muse-mcp.py
TUNNEL_ID=TUNNEL_ID KEY_FILE="$KEY_PATH" CONSUME_KEY_FILE=1 bash install.sh

如果弹出允许访问 api.openai.com 的审批，选长期允许。
装完只回复脚本最后 report 段的原文（两条横线之间的内容），不要输出任何密钥。
```

`CONSUME_KEY_FILE=1` makes `install.sh` copy the key into `~/muse-chatgpt/run/control-plane.env`
(0600), then overwrite and delete the attachment. Without a key the script still installs
everything, prints `KEY MISSING` and exits 3; the key can follow with the rotate message.

## Restart after approving egress, or after a VM swap

```text
审批已处理。请运行 bash ~/muse-chatgpt/restore.sh ，只回复 report 段原文。
```

## Rotate the key (attach the new key file)

```text
附件是新的 API Key 文件，不要打开或打印它。找到它的路径记为 KEY_PATH，然后运行：
KEY_FILE="$KEY_PATH" CONSUME_KEY_FILE=1 bash ~/muse-chatgpt/restore.sh
只回复 report 段原文。
```

Revoke the old key on Platform only after this report says OK.

## Two-sided log check

```text
只回报事实，不要改任何配置。运行下面两条命令并原样贴出输出：

{ grep -h 'dispatcher forwarded' ~/muse-chatgpt/logs/tunnel.log 2>/dev/null; journalctl -u muse-chatgpt-tunnel.service --since '-30 min' -o cat --no-pager 2>/dev/null | grep 'dispatcher forwarded'; } | tail -4
{ grep -h 'tools/call' ~/muse-chatgpt/logs/mcp.log 2>/dev/null; journalctl -u muse-chatgpt-mcp.service --since '-30 min' -o cat --no-pager 2>/dev/null | grep 'tools/call'; } | tail -4
```

Expect `dispatcher forwarded command to MCP server` lines carrying this run's `tunnel_id`, and
`rpc method=tools/call tool=muse_vm_exec` lines at the same times as the ChatGPT calls.

## Diagnosis (only when something is wrong)

```text
只回报事实，不要改配置：
1. cat ~/muse-chatgpt/run/config.env；ps -p $(cat ~/muse-chatgpt/run/mcp.pid ~/muse-chatgpt/run/tunnel.pid) -o pid,lstart,command（systemd 时改为 systemctl status muse-chatgpt-mcp muse-chatgpt-tunnel --no-pager）
2. tail -20 ~/muse-chatgpt/logs/tunnel.log（或 journalctl -u muse-chatgpt-tunnel --since "-10 min" -o cat）里有没有 poll failed / poll timed out / status_code / proxyconnect
3. curl -s 127.0.0.1:<tunnel health 端口>/metrics | grep commands_poll_last_successful
4. uptime -s：如果这台机器刚换过，直接说
```
