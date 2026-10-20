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

## 0. Preflight (one message, not three)

Send Muse **one** message asking all of this at once, so you never pay for a second round trip:

> 请一次性回答（每条一行，不要反问我第二步）：① tunnel-client 是否已安装（路径 + `--version`）？② 有没有任何服务监听 `127.0.0.1:端口/mcp`？③ 你能否写文件到 `~/muse-chatgpt-tunnel/`？④ 你的 VM 出网是否要过出口代理审批（带 `Authorization` 的请求会不会被挂起）？⑤ 你能否用 systemd 起独立服务？

If ② is "no", that is expected — the bootstrap creates one. Only ①③⑤ can actually block you.

## 1. Platform: tunnel + restricted key

1. https://platform.openai.com/settings/organization/tunnels → **Create tunnel**. Name it after the purpose (e.g. `muse-chatgpt-native`), pick the org, and select the user's ChatGPT workspace. Copy the `tunnel_…` id — it is not a secret.
2. Never reuse a tunnel that already carries another service; if one exists (`aws`, etc.) leave it alone.
3. https://platform.openai.com/settings/organization/api-keys → **Create new secret key**:
   - Name it distinctly (`…-runtime-2` on re-runs).
   - Permissions → **Restricted** → set **Tunnels = Read + Use**, nothing else.
   - Expiry → 30 days (avoid "never").
   - The key is shown **once**, in a readonly `<input>` inside a *Save your key* dialog. Read it from the DOM into a local `0600` file **inside the same script**; never print it, never paste it into a chat message.
4. If the Create button stays disabled, the **expiry** field is unfilled — that is the usual cause.

## 2. Muse: one-shot bootstrap

Paste the block in `references/muse-bootstrap.md`, substituting `TUNNEL_ID`. It covers: download the official client, write the key via stdin to a `0600` env file, two systemd units, a `restore.sh` for VM swaps, correct start order, timestamped logs, one whitelisted exec tool with **neutral** wording, and a `health` self-test.

Rules that make it fast and safe:

- **`--control-plane.api-key env:CONTROL_PLANE_API_KEY`** only. Never on the command line, never in logs.
- Delivery of the key: a **file attachment** is the only workable channel on this platform (see Limits). Attach a file containing just the env line; ask Muse to overwrite its env file, zero-overwrite and delete the attachment, then restart and self-test. Chat prose must never contain the key.
- Expect **egress approval cards** (`Access api.openai.com`). The tunnel polls continuously: choose **Always allow**. One-shot approval works exactly once, then dead.
- Ask for the self-test payload to include hostname, live UTC and the caller token — that is your B-level evidence later.

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
2. Accept only: token echoed verbatim + fresh UTC + `hostname`, **and** in the VM logs, exactly one `dispatcher forwarded … command` in `tunnel.log` plus exactly one `POST /mcp 200` in the MCP log in the same seconds, matching the payload timestamp to the millisecond.
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
