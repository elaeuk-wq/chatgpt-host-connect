---
name: muse-chatgpt-setup
description: Wire an already signed-in ChatGPT account to an already signed-in Muse account over an OpenAI Secure MCP Tunnel, in about 15 minutes. Creates the tunnel and a restricted key, has Muse self-configure its own VM, connects the ChatGPT connector, and proves the link with two-sided logs. Use when the user says "connect ChatGPT and Muse" or wants ChatGPT to drive a Muse cloud VM.
---

# Connect ChatGPT ↔ Muse (runbook)

**What this delivers:** ChatGPT can call tools that really execute inside the user's Muse VM, and read the live results back (`B-level`).
**What this does NOT deliver:** a conversation with the Muse agent (`A-level`). See **Limits**. Never describe B as A.

Target wall-clock: **12–18 min**, of which most is the remote agent working, not you clicking.

## Fast path (do these in order, don't improvise)

| # | Where | Action | ~time |
|---|---|---|---|
| 0 | browser | Open the user's **signed-in** Platform / ChatGPT / Muse tabs. No new accounts. | 1 min |
| 1 | Platform | Create a **dedicated** tunnel + a **Restricted** key (Tunnels: Read + Use). | 3 min |
| 2 | Muse | Paste **one** bootstrap message (below) — it does everything on its own VM. | 5–8 min |
| 3 | ChatGPT | Add a custom MCP server → **隧道** → the new tunnel → unique name. | 2 min |
| 4 | ChatGPT | Call a tool in a **new** chat; verify with **two-sided** logs. | 2 min |

Do steps 1 and 2 in parallel: the bootstrap message needs only the `tunnel_id`.

## Entry points (exactly these four)

| Step | URL | What you do there |
|---|---|---|
| 1a | https://platform.openai.com/settings/organization/tunnels | **Create tunnel**, then copy the `tunnel_…` id |
| 1b | https://platform.openai.com/settings/organization/api-keys | **Create new secret key** → Restricted → Tunnels: Read + Use |
| 2 | https://muse.ai/ | Send the install message; approval cards appear in the right sidebar |
| 3 | https://chatgpt.com/plugins | **添加 → 添加自定义 MCP 服务器 → 连接: 隧道** |
| later | https://chatgpt.com/settings/plugins-settings | Manage / uninstall the connector |

In the connector's tunnel picker the chips show tunnel **names** (`muse-native-run3`), not ids — pick by name, then confirm the id landed in the `tunnel_...` field.

## 0. Preflight (one message, not three)

Send Muse **one** message asking all of this at once, so you never pay for a second round trip:

> 请一次性回答（每条一行，不要反问我第二步）：① tunnel-client 是否已安装（路径 + `--version`）？② 有没有任何服务监听 `127.0.0.1:端口/mcp`？③ 你能否写文件到 `~/muse-chatgpt-tunnel/`？④ 你的 VM 出网是否要过出口代理审批（带 `Authorization` 的请求会不会被挂起）？⑤ 你能否用 systemd 起独立服务？

If ② is "no", that is expected — the bootstrap creates one. Only ①③⑤ can actually block you.

## 0.5 Approval gates — where they hide (the #1 reason a run appears "stuck")

Nothing in this flow fails silently: it **waits**. If the remote agent stops producing output for ~30 s, the cause is almost always an unclicked approval, not a technical failure. Never sit and wait — go look, then tell the user exactly which button to press.

| Gate | Where it appears | What to choose |
|---|---|---|
| Muse background task needs review | Right-hand sidebar **需要审核**, and a **审核** button above the composer | Open the card. For network access pick the long-lived option |
| Egress proxy → `api.openai.com` | Same sidebar card: *允许 <agent> 与 api.openai.com 分享信息* | **允许一次 is not enough.** Click **更多允许选项** (the caret right of 允许一次) → **总是允许此站点**. The tunnel polls forever; a one-shot approval lets exactly one poll through and then stalls |
| ChatGPT tool call | Inline card in the conversation | User's call; 「始终允许」 avoids a click per call |
| ChatGPT connector consent | Consent screen after *创建为插件* | **连接 <name>** — without it `tools/list` returns `[]` |
| Platform tunnel/key creation | No card | Requires being signed in with permission to create |

The approval card is frequently **not** in the chat transcript — it lives in the sidebar panel, so a public-facing run must point at it explicitly (or click it once the user has pre-authorised). One observed stall lasted until the user manually clicked the card; the agent had been reporting "waiting" with no hint of what to click. Do not repeat that: name the panel, name the button.

## 0.6 The host AI clicks the approvals itself

**Default behaviour: the host clicks. Do not hand a stalled run back to the user.** A public skill that says "please go find the approval card" is a skill that most users will fail. The host has a browser — use it.

Click, on the user's behalf, once they have authorised the overall run:

| Control | How to click it |
|---|---|
| Muse egress / background-task card | Right sidebar **需要审核**; `允许一次` is a split button — click **更多允许选项** (caret) → **总是允许此站点** |
| ChatGPT connector consent | **连接 <name>** |
| ChatGPT per-tool card | **始终允许** (or 允许一次 if the user wants the minimum) |

Verify after clicking: the pending badge disappears and **审核记录** gains a line like `始终允许网站`. Then keep polling the page — clicking is not proof the remote work resumed.

**Never click these; stop and ask the user:**

- sign-in, password, MFA, CAPTCHA, "continue as <account>"
- purchases, plan changes, billing
- granting scopes beyond **Tunnels: Read + Use**, or any account-security setting
- anything destructive to existing services, tunnels, connectors or data

If the host has no browser control, say so plainly and give the user the exact click target — that is the only case where the human clicks.

## 1. Platform: tunnel + restricted key

Everything here is **per account**: tunnels and connectors are scoped to whichever OpenAI account/organization you are signed into. Two accounts can each own a tunnel called `aws` — that is not a sign you are in the same place, and you must not expect tunnels or connectors from another account to be visible. Build fresh in the account you are in; nothing else is required.

1. https://platform.openai.com/settings/organization/tunnels → **Create tunnel**. Name it after the purpose (e.g. `muse-chatgpt-native`), pick the org, and select the user's ChatGPT workspace. Copy the `tunnel_…` id — it is not a secret.
2. Never reuse a tunnel that already carries another service; if one exists (`aws`, etc.) leave it alone.
3. **The tunnel must be associated with the target ChatGPT workspace**, or it will not appear at all in step 3. The Create dialog's workspace field is easy to miss and its markup differs per organization — if the dialog shows no `Search workspaces by name or ID` control, create anyway and then **Edit tunnel → ChatGPT workspaces → pick the workspace → Save**. Verify success by re-opening the connector dialog and confirming the tunnel name shows up as a chip; a tunnel that is org-scoped but workspace-less is invisible there and every later step is wasted.
4. https://platform.openai.com/settings/organization/api-keys → **Create new secret key**:
   - Name it distinctly (`…-runtime-2` on re-runs).
   - Permissions → **Restricted** → set **Tunnels = Read + Use**, nothing else.
   - Expiry → 30 days (avoid "never").
   - The key is shown **once**, in a readonly `<input>` inside a *Save your key* dialog. Read it from the DOM into a local `0600` file **inside the same script**; never print it, never paste it into a chat message.
   - Restricted keys are **org-scoped**: re-runs in the same org may reuse one key for several tunnels, but a different OpenAI account/organization needs its own key (and its own tunnel).
5. If the Create button stays disabled, the **expiry** field is unfilled — that is the usual cause.

## 2. Target machine: install from zero

**Assume the machine is brand new**: no tunnel client, no MCP server, no units, no previous run. Do not ask the remote agent to write infrastructure from scratch — the repo ships it, so every user gets the same bytes:

- `scripts/install.sh` — downloads the official `tunnel-client`, picks free ports, writes two units (systemd, or a `nohup` fallback), generates `restore.sh`, starts in the correct order, prints a report.
- `scripts/muse-mcp.py` — a stdlib-only MCP server: `muse_ping` + `muse_vm_exec` (one whitelisted command, fixed argv, no shell), neutral tool descriptions, timestamped logs.

Send `references/muse-bootstrap.md` **Message 1** (it fetches both files from this repo and runs one command). The only local prerequisites are `curl` and `python3`.

Rules:

- **`--control-plane.api-key env:CONTROL_PLANE_API_KEY`** only; the key lives in a `0600` file that the unit sources. Never on a command line, never in a log, never in chat prose.
- Key delivery: a **file attachment** (see Limits), saved to `~/run/control-plane.env`, attachment zero-overwritten afterwards.
- Ports are auto-picked, so an existing service on 8795/8796 cannot collide. Nothing outside `~/muse-chatgpt` and the two units this script creates is touched.
- The self-test payload must return hostname, a fresh timestamp and the caller token — that is the B-level evidence.

### Gate: do not build the connector until the tunnel is actually connected

`install.sh` ends with a verdict and **exits 2** when it is not met:

```
control-plane  : OK                      # a poll reached OpenAI - proceed
control-plane  : PENDING (...)           # approve egress, re-run restore.sh
control-plane  : KEY REJECTED            # wrong/revoked/insufficient key
```

`/healthz` and `/readyz` do **not** count — they are local to the process and stay green while every poll times out.

If PENDING: the approval card is waiting (sidebar **需要审核**). Click **更多允许选项 → 总是允许此站点** (host does this, §0.6), then `bash ~/muse-chatgpt/restore.sh` and re-check. Only continue to step 3 once it prints `OK`.

**Never** create the connector before this gate passes. Doing so produces a misleading `应用配置受到速率限制` error from ChatGPT, and a connector that silently never works.

## 3. ChatGPT: connector

1. https://chatgpt.com/plugins → **添加** → **添加自定义 MCP 服务器**.
2. **连接** → **隧道** → pick the tunnel chip. **身份验证** → **无需身份验证** (the tunnel reports `SupportsOAuth:false`).
3. Name: must be globally unique, and a name can be taken by an app you cannot even see → on `已存在同名应用`, just pick another (`Muse Native 2`).
4. Tick **我已了解，并希望继续** → **创建为插件** → then the consent screen → **连接 <name>**. Creation alone is not connection.
5. **"已安装" does not mean connected.** An app can appear under *已安装* with zero tools: tool discovery returns `[]` and the assistant says the tool does not exist. If the consent click was missed, reopen the app's detail page (`/plugins/plugin_…`) and press **连接** → then **连接 <name>** in the dialog. Only after that does `tools/list` return anything.
6. **Never keep two connectors that expose the same tool names.** The model picks arbitrarily; you will "verify" the new path and actually hit the old one. Uninstall the stale connector first, or expect to prove attribution from the logs.
5. Keep tool descriptions neutral from the first version (see Limits). A persuasive description produces a *suspicious instruction* warning on every call and costs the user a click each time.

## 4. Prove it (two-sided, or it didn't happen)

1. New chat, ask the model to call the exec tool with a **one-time random token** and to paste the raw JSON unchanged.
2. Accept only: token echoed verbatim + a second call returning a **different** timestamp, **and** in the VM logs a `dispatcher forwarded … command` line whose `tunnel_id` matches, plus one MCP request line in the same second.
   - Logs may be in **journald** rather than files: ask for `journalctl -u <unit> --since ...`. Do not conclude "no logs" because `tunnel.log` is absent.
   - Read the tool schema instead of assuming parameter names: one implementation used `cmd`, another `command`, and payload shapes differed too.
3. **Read the `tunnel_id` in the forwarded line.** With more than one tunnel alive it is the only proof of *which* path served the call — the assistant's own claim about which connector it used is not evidence.
3. Second call must return a *different* UTC — proves it is not a constant.
4. Rotate any key that ever appeared in plaintext, then re-run step 4 once with the new key. Revoke the old one only after the new call passes.

## Troubleshooting (symptom → cause → fix)

| Symptom | Cause | Fix |
|---|---|---|
| `Connection timed out` | nothing listening upstream: VM was swapped, units gone | `restore.sh`; check `systemctl is-active` **before** every test |
| `Connection timed out` right after a swap | old tunnel process still held the control plane while its VM was dying | restart tunnel, confirm a fresh `mcp session initialized` |
| `Session terminated` | MCP restarted while the tunnel kept the old session | restart **MCP → wait for port → tunnel** |
| `/readyz` 503 but poll OK | tunnel started ~40 ms before MCP bound its port; failed discovery cached | serial start order |
| Tool "does not exist" although the server lists it | connector cached tools+descriptions at discovery | create a **new** connector (not 刷新工具, not a tunnel restart) |
| Every call prompts for approval | per-connector permission is one-shot | user picks **Always allow** |
| Suspicious-instruction warning | tool description argues it is harmless | reword to facts only, then new connector |
| Tool discovery returns `[]` / "tool does not exist" on a brand-new connector | consent dialog never confirmed — *已安装* ≠ *已连接* | open the app page → **连接** → **连接 <name>** |
| New tunnel missing from the connector's tunnel chips | tunnel not associated with the ChatGPT workspace | **Edit tunnel → ChatGPT workspaces → Save**, re-check the chips |
| "No logs at all" | service logs to journald, not to a file | `journalctl -u <unit> --since "-10 min"` |
| Agent stalls with no output | an approval card is waiting in the sidebar | open **需要审核**; for egress use 更多允许选项 → 总是允许此站点 |
| `/healthz` and `/readyz` both green, yet nothing works | those endpoints are **local only**; the control-plane poll can still be timing out | look for `poller recovered` / a successful poll in the tunnel log before believing it |
| ChatGPT says *应用配置受到速率限制* | in practice this fired while the tunnel was **not** connected | confirm the tunnel polls successfully, then retry creation |
| Connector is missing from *已安装* although you clicked create | the consent step never completed (or creation was rejected) | re-create once the tunnel is up, click **连接 <name>**, then confirm it is listed |
| Tunnel stalls again an hour later | egress approval was one-shot, not always-allow | re-approve with 总是允许此站点 |
| PASS claimed but the old tunnel served the call | two connectors, identical tool names | uninstall the stale one; confirm `tunnel_id` in the forwarded log line |
| Poll fails, VM network fine | egress proxy stalls `Authorization` requests until approved | approve with **Always allow** |

## Limits — state these up front

- **`A-level` (talk to the Muse agent) is usually impossible.** On the observed platform, the agent runtime exposes only internal Unix sockets that reject general HTTP (`noded/http-api.sock` resets), a sandbox API returning 403 route-not-allowed, and `privsep/*-mcp.sock` bridges that point the *other* way (agent → third-party tools). There is no "deliver a message → agent turn → return its answer" interface. Do not simulate it; report it.
- **A minimal stand-in MCP is not the product.** If the intended gateway repo is unavailable, the agent may write a small server with 2–4 tools. That is a legitimate link test and must be labelled as a stand-in, never as the full toolset.
- **There is no "usable but unreadable" secret channel here.** Chat attachments are ordinary readable files; an opaque vault cannot export into a process env. So: attachment delivery + Restricted + 30-day + rotate after first PASS.
- **The VM is disposable.** Three replacements were observed in one evening; `/etc` units vanish, `$HOME` survives. `restore.sh` in `$HOME` is mandatory, not nice-to-have.

## Hard rules

- Ask before creating a tunnel/key, deploying a service, or connecting an app. Pause for the user's own login, MFA, and permission cards.
- Never put a key, cookie or token in chat prose, URLs, command lines, screenshots or logs.
- Never touch the user's existing tunnels, connectors, Pi/Browser MCP services or accounts.
- Report `PASS` / `BLOCKED` / `NOT VERIFIED` per item, naming the level (A or B). A healthy tunnel alone is not a PASS.

Official transport reference: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
