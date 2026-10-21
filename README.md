# muse-chatgpt-setup

[中文](README.zh-CN.md)

An agent skill that connects a **signed-in** ChatGPT account to a **signed-in** Muse account over an OpenAI Secure MCP Tunnel. You paste one prompt; the agent drives your browser and finishes the setup, including the test calls.

## What you get

ChatGPT gets a plugin with two tools that really run on your Muse VM:

| Tool | Returns |
|---|---|
| `muse_ping` | `{"pong": true, "utc": ...}` |
| `muse_vm_exec` | runs one whitelisted command (`status_echo`): hostname, UTC time, and the token you passed |

This is a **link test**: it proves ChatGPT -> tunnel -> Muse VM -> back works. It does **not** let ChatGPT talk to the Muse agent - Muse offers no interface for that, and the skill reports it as `NOT VERIFIED` rather than faking it.

## How it works

1. **Platform** (platform.openai.com): a new tunnel with a unique name, linked to your ChatGPT workspace, and a Restricted API key (Tunnels: Read + Use only, 30 days).
2. **Muse**: one message with the key attached as a file. Muse downloads `install.sh` + `muse-mcp.py` from this repo's release tag and runs them on its VM: official `tunnel-client` (checksum-verified), a tiny MCP server, a connectivity check.
3. **ChatGPT**: a custom MCP plugin over that tunnel (no authentication), connected.
4. **Proof**: two tool calls with fresh tokens, plus the VM's own log lines showing this tunnel forwarded them.

A script (`scripts/browser/muse-setup.mjs`) does the clicking through Chrome DevTools Protocol, reads back every value it set (permissions, expiry, workspace, selected tunnel), and stops with a precise report when the page does not match - the agent then finishes that step by hand and resumes. A state file makes reruns safe: finished steps are skipped and nothing is created twice. Button labels are matched in English and Chinese.

Target time for a first run: about 5-6 minutes, most of it Muse installing.

## Two key modes

| | Fully automatic (`--mode auto`, default) | Semi-automatic (`--mode manual`) |
|---|---|---|
| Who clicks *Create secret key* | the script | you, then you click **Copy** |
| How the key reaches the local file | the script reads it from the *Save your key* dialog | the script reads the clipboard, then clears it |
| Does the agent's browser session read the key on the page | yes (into memory and a `0600` file; never printed) | no |
| Questions to you | none, except login / CAPTCHA / payment | one click pair on the key dialog |

In both modes the key ends up in a local `0600` file, is attached to the Muse chat as a file, and is never shown in chat text, logs or command lines. Note what that means: the agent process (auto mode) and the Muse VM agent (both modes) could read the key. That is why it is Restricted to Tunnels and expires in 30 days; rotate it with one Muse message (see `references/muse-bootstrap.md`).

## Requirements

- **Your everyday Chrome with remote debugging on**, signed in to platform.openai.com, chatgpt.com and muse.ai. Open `chrome://inspect/#remote-debugging` and switch it on (Chrome 144+). The first time the skill connects, Chrome asks you to **Allow** the connection — click it once. The skill finds the endpoint by itself.
  - Alternative: a separate profile started with `--remote-debugging-port=9333 --user-data-dir="$HOME/.muse-chatgpt-setup/chrome"` (sign in there once), then pass `--cdp http://127.0.0.1:9333`.
- **Node.js 22+** where the agent runs (no npm packages needed). Semi-automatic mode needs macOS (`pbpaste`).
- An OpenAI account that may create tunnels and API keys; a Muse VM with `curl` and `python3`.

## Install the skill

```bash
git clone https://github.com/elaeuk-wq/muse-chatgpt-setup-skill
# Pi
cp -r muse-chatgpt-setup-skill/skills/muse-chatgpt-setup ~/.agents/skills/
# Claude Code
cp -r muse-chatgpt-setup-skill/skills/muse-chatgpt-setup ~/.claude/skills/
# Codex
cp -r muse-chatgpt-setup-skill/skills/muse-chatgpt-setup ~/.codex/skills/
```

(Codex: if your version reads skills from another directory, use that one.) Restart the agent so it picks the skill up.

## Prompts to paste

**Semi-automatic** - the agent does everything except the key's Create + Copy:

> Use the muse-chatgpt-setup skill in semi-automatic key mode to connect my ChatGPT and Muse. My Chrome (remote debugging on) is signed in to platform.openai.com, chatgpt.com and muse.ai. You may create a new tunnel, a restricted API key, a ChatGPT plugin, install the connector on my Muse VM, and approve this setup's own approval cards. When the key form is filled, tell me and I will click Create and Copy; do everything else yourself through the final verification, then report PASS/BLOCKED per step.

> 用 muse-chatgpt-setup 技能，以半自动 Key 模式把我的 ChatGPT 和 Muse 连起来。我的 Chrome 已打开远程调试，并已登录 platform.openai.com、chatgpt.com 和 muse.ai。你可以新建隧道、受限 API Key、ChatGPT 插件，在我的 Muse VM 上安装连接器，并批准本流程自己的审批卡。Key 表单填好后告诉我，我自己点创建和复制；其余步骤你做完直到最终验收，最后按步骤报告 PASS/BLOCKED。

**Fully automatic** - no questions, stops only for login, CAPTCHA or payment:

> Use the muse-chatgpt-setup skill in fully automatic mode to connect my ChatGPT and Muse. My Chrome (remote debugging on) is signed in to platform.openai.com, chatgpt.com and muse.ai. I authorize you to create a new tunnel, a restricted API key (Tunnels Read + Use, 30 days), and a ChatGPT plugin, to install the connector on my Muse VM, and to approve this setup's own approval cards. Do not ask me anything; stop only if a login, CAPTCHA or payment is needed. Report PASS/BLOCKED per step at the end.

> 用 muse-chatgpt-setup 技能，全自动把我的 ChatGPT 和 Muse 连起来。我的 Chrome 已打开远程调试，并已登录 platform.openai.com、chatgpt.com 和 muse.ai。我授权你新建隧道、受限 API Key（仅 Tunnels 读取 + 使用，30 天）和 ChatGPT 插件，在我的 Muse VM 上安装连接器，并批准本流程自己的审批卡。全程不要问我；只有需要登录、验证码或付款时才停下。最后按步骤报告 PASS/BLOCKED。

## Safety

- Only objects with this run's unique names are created or touched; your existing tunnels, keys, plugins and VM services are left alone. Approval cards that are not this setup's are left for you.
- Tunnel IDs are not secret; the key is. It never appears in chat text, URLs, command lines, logs or screenshots, and page reads are limited to the elements a step needs, with tokens redacted.
- On the VM the key lives in `~/muse-chatgpt/run/control-plane.env` (`0600`), loaded by systemd `EnvironmentFile=` or by the start script - never on a command line.

## Measured results

_To be filled in after the phase-2 runs on real accounts (time per step, both key modes)._

## Tests (offline)

```bash
bash tests/test-install.sh            # install.sh with a mock tunnel-client (background-process mode)
python3 tests/test-mcp.py             # muse-mcp.py protocol
node tests/browser/test-browser.mjs   # the browser script against local fixture pages in a throwaway headless Chrome
```

## Repository layout

```
skills/muse-chatgpt-setup/
├── SKILL.md                     runbook for the agent
├── references/muse-bootstrap.md messages for the Muse agent (install, restart, rotate, logs, diagnosis)
└── scripts/
    ├── install.sh               runs on the Muse VM: install / restore / rotate key / stop
    ├── muse-mcp.py              minimal MCP server (stdlib only)
    └── browser/                 muse-setup.mjs + CDP driver + bilingual UI labels
tests/                           offline tests and fixtures
```

## License

MIT
