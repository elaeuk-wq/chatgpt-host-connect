---
name: muse-chatgpt-setup
description: Connect an already signed-in ChatGPT account to an already signed-in Muse account over an OpenAI Secure MCP Tunnel, from one prompt. A script drives the user's signed-in Chrome over CDP - creates the tunnel and a restricted key on platform.openai.com, has Muse install the tunnel client on its own VM, creates the ChatGPT custom MCP plugin, and proves the link with two tool calls plus two-sided logs. Use when the user says "connect ChatGPT and Muse" or wants ChatGPT to call tools on a Muse VM.
---

# Connect ChatGPT and Muse

**Delivers (B-level):** ChatGPT calls two tools that really run on the user's Muse VM and returns their live output: `muse_ping` and `muse_vm_exec` (one whitelisted command, `status_echo`: hostname, UTC time, echo token). This is a link test.
**Does not deliver (A-level):** talking to the Muse agent. See Limits. Never report B as A.

Target: about 5-6 minutes on a first run, most of it the Muse agent installing. You run one command and handle only what it hands back.

## Requirements

- A Chrome reachable over CDP (default `http://127.0.0.1:9333`, override `--cdp` or `MUSE_SETUP_CDP`), signed in to platform.openai.com, chatgpt.com and muse.ai. Chrome 136+ only allows remote debugging on a non-default profile:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9333 --user-data-dir="$HOME/.muse-chatgpt-setup/chrome"`
- Node >= 22 on the machine running the agent. Semi-automatic key mode also needs macOS `pbpaste`/`pbcopy`.
- The OpenAI account may create tunnels and API keys; the Muse VM has `curl` and `python3`.

## Authorization

The user's prompt is the authorization. Whatever it grants (creating a tunnel, a key, a plugin, installing on the Muse VM, approving this flow's cards) you do without asking again. Always stop and hand over for: login, MFA/one-time codes, CAPTCHA, payment or plan changes, and anything that changes or deletes objects this run did not create (other tunnels, keys, plugins, services). If the prompt grants nothing, ask once, listing exactly what will be created.

## Run

```bash
S=<this skill dir>/scripts/browser/muse-setup.mjs
node $S run --mode auto          # fully automatic (default)
node $S run --mode manual        # semi-automatic: the user clicks Create + Copy on the key
node $S run --dry-run            # locate the entry elements on every site; clicks nothing
```

Options: `--workspace "<ChatGPT workspace>"` (needed only when several are offered), `--project "<Platform project>"`, `--keep-key` (keep the local key file after install), `--state FILE`, `--labels FILE` (extra UI labels).

Key modes:

- **auto**: the script submits the key form and reads the key from the *Save your key* dialog straight into a `0600` file. Never printed.
- **manual**: the script fills the form (Restricted, Tunnels Read + Use, 30 days) and stops; it emits `waiting_for_user` - relay it. The user clicks **Create secret key** and **Copy**; the script writes the clipboard to the `0600` file and clears the clipboard. The script does not read the key from the page.

Steps (each reads back what it set before it is marked done):

| Step | Site | Does | Read back |
|---|---|---|---|
| `tunnel` | Platform | new tunnel with a unique name, ChatGPT workspace associated | `tunnel_…` id, name, workspace |
| `key` | Platform | Restricted key: Tunnels Read + Use only, 30 days | permissions, expiry, project, list row |
| `muse-install` | Muse | new chat, key file attached, install message sent | attachment chip, sent message |
| `muse-wait` | Muse | approves the `api.openai.com` card, waits for the install report | `control-plane  : OK` |
| `plugin` | ChatGPT | custom MCP server -> Tunnel -> chip -> No authentication -> Create -> Connect | selected chip = tunnel name, id field = tunnel id, listed + connected |
| `test` | ChatGPT | two `muse_vm_exec` calls with fresh tokens | tokens echoed, two different UTC values |
| `logs` | Muse | asks for the forwarded-command and MCP log lines | lines carry the tunnel id |

Output: one JSON object per line on stdout; the last line is the result. Exit codes: `0` done, `10` a step failed (you take over), `11` the user is needed (login / captcha / payment), `12` refused because it could create a duplicate, `1` usage error.

## When the script fails: take over, then resume

1. Read the last JSON line: `step`, `error`, `expected`, `found` (only the relevant elements, redacted), `hint`, and `takeover` (`do`, `verify`, `record`, `resume`). The failing tab is left open.
2. Do that one step by hand in the same browser, using the fallback tools (they use real mouse/keyboard and redact everything they print):
   `snapshot`, `click`, `fill`, `select`, `attach`, `grep`, `press` - all take `--tab <url prefix>` and optional `--scope dialog`, e.g.
   `node $S select --tab https://platform.openai.com --scope dialog --label "Expiration|有效期" --option "30 days|30 天"`.
   For the key use `node $S key-from-page --tab https://platform.openai.com` while *Save your key* is open, or `key-from-clipboard` after the user clicked Copy. Never print, paste or type the key yourself.
3. Check every `takeover.verify` condition on the page.
4. Record the result: `takeover.record` (e.g. `node $S state done tunnel tunnel_id=tunnel_… tunnel_name=…`). `state done` validates the outputs.
5. Resume: `node $S run` (finished steps are skipped). `--from-step <step>` re-runs from a later step.

Rules:

- Never create a second tunnel, key or plugin to get past a failure. A step marked `submitted` is looked up by its name on rerun; if it cannot be found the script refuses (exit 12) - check the page yourself, then either record it with `state done` or, only if nothing was created, `state reset <step>`. `state reset key --rename` starts a key with a new name after you revoked the uncaptured one.
- `needs_user` (exit 11): tell the user exactly what to do (e.g. sign in to chatgpt.com in that Chrome), then rerun.
- If the same step also fails twice by hand, stop and tell the user which step, what you expected and what the page shows.

## Approval cards

The script approves only this flow's cards and reports the rest as `foreign_approval_left_for_user` - pass those on, do not click them.

- Muse: the card for **api.openai.com** (egress of the tunnel client). Choose the long-lived option: the caret **More allow options -> Always allow this site**. *Allow once* lets one poll through and the tunnel stalls again.
- ChatGPT: the tool card of this run's plugin (`muse_vm_exec` / `muse_ping`): **Always allow**.

## UI labels (matched in both languages)

| Where | English | 中文 |
|---|---|---|
| Platform tunnels | Create tunnel · Name · Search workspaces by name or ID · Create · Edit · Save | 创建隧道 · 名称 · 按名称或 ID 搜索工作区 · 创建 · 编辑 · 保存 |
| Platform keys | Create new secret key · Name · Project · Restricted · Tunnels · Read + Use · Expiration · 30 days · Create secret key · Save your key · Done | 创建新的密钥 · 名称 · 项目 · 受限 · 隧道 · 读取 + 使用 · 有效期 · 30 天 · 创建密钥 · 保存你的密钥 · 完成 |
| Muse | New chat · Attach · Send · Needs review · Review · Allow once · More allow options · Always allow this site | 新对话 · 添加附件 · 发送 · 需要审核 · 审核 · 允许一次 · 更多允许选项 · 总是允许此站点 |
| ChatGPT plugins | Add · Add custom MCP server · Connection · Tunnel · Authentication · No authentication · I understand and want to continue · Create · Connect <name> · Installed · Connected | 添加 · 添加自定义 MCP 服务器 · 连接 · 隧道 · 身份验证 · 无需身份验证 · 我已了解，并希望继续 · 创建为插件 · 连接 <name> · 已安装 · 已连接 |
| ChatGPT chat | Send prompt · Always allow · Allow | 发送提示 · 始终允许 · 允许 |

The full list is `scripts/browser/labels.mjs`. If the UI uses other words, pass `--labels my-labels.json` (same shape) rather than editing steps.

## On the Muse VM: install.sh

`references/muse-bootstrap.md` has the messages; `node $S message install|restore|logs` prints them with the real values. The install message downloads `install.sh` and `muse-mcp.py` from the release tag and runs one command; the key arrives as the attached file, never in message text.

`install.sh` (same code path as the generated `restore.sh`):

- downloads the official `tunnel-client` for the VM's OS/CPU and checks it against the release `SHA256SUMS.txt`;
- installs everything under `~/muse-chatgpt`; systemd units (`muse-chatgpt-mcp`, `muse-chatgpt-tunnel`, key via `EnvironmentFile=`) when root + systemd, otherwise background processes with pid files; it stops only its own processes and never overwrites units it did not write;
- starts MCP first, waits for its port, then the tunnel;
- judges the link by the tunnel's `commands_poll_last_successful_timestamp_seconds` metric (same as `tunnel-client health --require-control-plane-poll`), and reads logs only from this start;
- prints a report ending in `control-plane  : OK | PENDING | KEY MISSING | KEY REJECTED | KEY FORBIDDEN | TUNNEL EXITED`; exit `0`, `2` pending, `3` key problem, `4` start failure.

`bash ~/muse-chatgpt/restore.sh` restarts after a VM swap; `KEY_FILE=<file> CONSUME_KEY_FILE=1 bash ~/muse-chatgpt/restore.sh` rotates the key; `restore.sh stop` stops both processes.

Gate: never create the ChatGPT plugin before the report says OK - ChatGPT then shows a misleading rate-limit error and the plugin never works. The script enforces this.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Report `PENDING` | egress card for api.openai.com not approved, or approved only once | approve with Always allow this site, then `restore.sh` (the script asks Muse once by itself) |
| Report `KEY REJECTED` / `KEY FORBIDDEN` | wrong or revoked key / key lacks Tunnels Read + Use or is from another organization | new key (`state reset key --rename`), then rotate with `restore.sh` |
| New tunnel missing from the plugin's tunnel chips | tunnel not associated with the ChatGPT workspace | Platform: Edit tunnel -> ChatGPT workspaces -> Save |
| ChatGPT: *rate limited* while creating the plugin | in practice: the tunnel was not polling | get `control-plane  : OK` first |
| Plugin listed but tools are `[]` / "tool does not exist" | consent (**Connect <name>**) never confirmed | open the plugin page -> Connect -> Connect <name> |
| Tool missing although the server lists it | the plugin cached tools and descriptions at discovery | create a new plugin; *refresh tools* does not help |
| `Connection timed out` | VM was replaced, processes gone | `bash ~/muse-chatgpt/restore.sh` |
| `Session terminated` | MCP restarted while the tunnel held the old session | `restore.sh` (restarts MCP, then tunnel) |
| `/healthz` and `/readyz` green, nothing works | they are local; the control-plane poll can still fail | trust only the report verdict |
| "No logs" | systemd mode logs to journald | `journalctl -u muse-chatgpt-tunnel --since "-10 min"` |
| Passed, but an old tunnel answered | two plugins with the same tool names | uninstall the stale plugin; check `tunnel_id` in the forwarded log line |
| Every call asks for approval / *suspicious instruction* warning | one-shot permission / tool description that argues it is harmless | Always allow; keep descriptions factual (this server's are) |

## Limits

- **A-level is not available.** The observed Muse runtime exposes no "deliver a message to the agent and return its answer" interface (internal sockets reject HTTP, the sandbox API returns 403, the MCP bridges point agent -> tools). Do not simulate it; report it as NOT VERIFIED.
- **The VM side is a link test**, not a toolset: two tools, one fixed command, no shell. Say so when reporting.
- **No usable-but-unreadable secret channel exists here.** The attachment is an ordinary file on the Muse VM; the Muse agent could read it. Hence Restricted (Tunnels only), 30 days, and rotation via `restore.sh`.
- **The VM is disposable.** Units under `/etc` can vanish with the VM; `~/muse-chatgpt` survives, so `restore.sh` lives there.

## Hard rules

- Never put a key, cookie or token in chat text, URLs, command lines, screenshots or logs. Read pages only through the script and its fallback tools - never dump whole pages.
- Use only objects this run created (unique names); never modify or delete the user's other tunnels, keys, plugins or VM services.
- Report `PASS` / `BLOCKED` / `NOT VERIFIED` per step and name the level (B). A healthy tunnel alone is not a PASS: it needs both tool calls and the forwarded log lines with this tunnel's id.

Transport reference: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
