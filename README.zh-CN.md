# muse-chatgpt-setup

[English](README.md)

一个 Agent 技能：通过 OpenAI Secure MCP Tunnel，把**已登录**的 ChatGPT 账号和**已登录**的 Muse 账号连起来。你粘一条提示词，agent 操作你的浏览器完成全部配置，包括测试调用。

## 能得到什么

ChatGPT 多出一个插件，里面两个工具真的在你的 Muse VM 上执行：

| 工具 | 返回 |
|---|---|
| `muse_ping` | `{"pong": true, "utc": ...}` |
| `muse_vm_exec` | 执行一条白名单命令（`status_echo`）：主机名、UTC 时间、你传入的 token |

这是**链路验证**：证明 ChatGPT → 隧道 → Muse VM → 返回 这条路是通的。它**不能**让 ChatGPT 和 Muse agent 对话——Muse 没有提供这种接口，技能会如实报 `NOT VERIFIED`，不会伪造。

## 工作方式

1. **Platform**（platform.openai.com）：新建一条唯一命名的隧道，关联你的 ChatGPT 工作区；建一把受限 API Key（只有 Tunnels：读取 + 使用，30 天）。
2. **Muse**：发一条消息，Key 作为文件附件。Muse 从本仓库的发布 tag 下载 `install.sh` + `muse-mcp.py` 在自己的 VM 上运行：官方 `tunnel-client`（校验 SHA256）、一个极小的 MCP 服务、连通判定。还会注册一个 Muse hook：Muse 换机后自动把连接重新拉起来。
3. **ChatGPT**：基于这条隧道建自定义 MCP 插件（无需身份验证）并连接。
4. **验收**：用新 token 调两次工具，再看 VM 自己的日志里这条隧道转发了这两次调用。

点击由脚本（`scripts/browser/muse-setup.mjs`）通过 Chrome DevTools Protocol 完成；每设一个值都读回核对（权限、有效期、工作区、选中的隧道），对不上就停下并给出准确的失败报告，由 agent 现场手动完成这一步后续跑。状态文件保证重跑安全：做完的步骤跳过，任何东西都不会建两次。按钮文字中英文都认。

首次运行的目标耗时：约 5–6 分钟，大部分是 Muse 在安装。

## 两种 Key 模式

| | 全自动（`--mode auto`，默认） | 半自动（`--mode manual`） |
|---|---|---|
| 谁点「创建密钥」 | 脚本 | 你，然后你点「复制」 |
| Key 怎么进本地文件 | 脚本从「保存你的密钥」弹窗读取 | 脚本读剪贴板，随后清空剪贴板 |
| agent 的浏览器会话是否读取页面上的 Key | 是（进内存和 `0600` 文件，从不打印） | 否 |
| 需要你做什么 | 没有，除了登录 / 验证码 / 付款 | 在 Key 弹窗点一次创建、一次复制 |

两种模式下 Key 都落到本地 `0600` 文件、作为文件附件发给 Muse，不出现在聊天正文、日志或命令行里。要清楚这意味着什么：agent 进程（全自动时）和 Muse VM 上的 agent（两种模式）都有能力读到 Key。所以 Key 只给 Tunnels 权限、30 天过期；轮换只要给 Muse 发一条消息（见 `references/muse-bootstrap.md`）。

## 前提

- **你日常用的 Chrome，打开远程调试**，并已登录 platform.openai.com、chatgpt.com 和 muse.ai。地址栏打开 `chrome://inspect/#remote-debugging`，把开关打开（Chrome 144 起）。每次开始运行时 Chrome 会弹窗，点一次 **允许** 即可；脚本和 AI 兜底共用这一条连接，跑完（或闲置 10 分钟）自动断开。连接地址技能自己找。
  - 另一种：用单独的用户目录启动 Chrome：`--remote-debugging-port=9333 --user-data-dir="$HOME/.muse-chatgpt-setup/chrome"`（在里面登录一次），再传 `--cdp http://127.0.0.1:9333`。
- agent 所在机器有 **Node.js 22+**（不需要装 npm 包）。半自动模式需要 macOS（`pbpaste`）。
- OpenAI 账号有建隧道和 API Key 的权限；Muse VM 上有 `curl` 和 `python3`。

## 安装技能

```bash
git clone https://github.com/elaeuk-wq/muse-chatgpt-setup-skill
# Pi
cp -r muse-chatgpt-setup-skill/skills/muse-chatgpt-setup ~/.agents/skills/
# Claude Code
cp -r muse-chatgpt-setup-skill/skills/muse-chatgpt-setup ~/.claude/skills/
# Codex
cp -r muse-chatgpt-setup-skill/skills/muse-chatgpt-setup ~/.codex/skills/
```

（Codex：如果你的版本从别的目录读技能，放到那个目录。）装完重启 agent 让它加载技能。

## 推荐提示词

**半自动**——除了 Key 的创建和复制，其余都由 agent 完成：

> 用 muse-chatgpt-setup 技能，以半自动 Key 模式把我的 ChatGPT 和 Muse 连起来。我的 Chrome 已打开远程调试，并已登录 platform.openai.com、chatgpt.com 和 muse.ai。你可以新建隧道、受限 API Key、ChatGPT 插件，在我的 Muse VM 上安装连接器，并批准本流程自己的审批卡。Key 表单填好后告诉我，我自己点创建和复制；其余步骤你做完直到最终验收，最后按步骤报告 PASS/BLOCKED。

> Use the muse-chatgpt-setup skill in semi-automatic key mode to connect my ChatGPT and Muse. My Chrome (remote debugging on) is signed in to platform.openai.com, chatgpt.com and muse.ai. You may create a new tunnel, a restricted API key, a ChatGPT plugin, install the connector on my Muse VM, and approve this setup's own approval cards. When the key form is filled, tell me and I will click Create and Copy; do everything else yourself through the final verification, then report PASS/BLOCKED per step.

**全自动**——全程不问，只在登录、验证码、付款时停下：

> 用 muse-chatgpt-setup 技能，全自动把我的 ChatGPT 和 Muse 连起来。我的 Chrome 已打开远程调试，并已登录 platform.openai.com、chatgpt.com 和 muse.ai。我授权你新建隧道、受限 API Key（仅 Tunnels 读取 + 使用，30 天）和 ChatGPT 插件，在我的 Muse VM 上安装连接器，并批准本流程自己的审批卡。全程不要问我；只有需要登录、验证码或付款时才停下。最后按步骤报告 PASS/BLOCKED。

> Use the muse-chatgpt-setup skill in fully automatic mode to connect my ChatGPT and Muse. My Chrome (remote debugging on) is signed in to platform.openai.com, chatgpt.com and muse.ai. I authorize you to create a new tunnel, a restricted API key (Tunnels Read + Use, 30 days), and a ChatGPT plugin, to install the connector on my Muse VM, and to approve this setup's own approval cards. Do not ask me anything; stop only if a login, CAPTCHA or payment is needed. Report PASS/BLOCKED per step at the end.

## 安全

- 只创建和操作带本次唯一名称的对象；你已有的隧道、Key、插件和 VM 服务不碰。不属于本流程的审批卡留给你处理。
- 隧道 ID 不是秘密，Key 是。Key 不进聊天正文、URL、命令行、日志、截图；读页面只取这一步需要的元素，并对 token 打码。
- 换机后由 Muse hook（`~/hooks/scripts/muse-chatgpt-keepalive.sh`，每 60 秒）运行 `restore.sh`；只有重启失败才唤醒 Muse agent。VM 休眠时什么都不跑，ChatGPT 的调用要等 Muse 被唤醒。
- VM 上 Key 存在 `~/muse-chatgpt/run/control-plane.env`（`0600`），由 systemd 的 `EnvironmentFile=` 或启动脚本加载，从不出现在命令行里。

## 实测记录

_待第 2 阶段在真实账号上实跑后填写（每步耗时，两种 Key 模式）。_

## 测试（离线）

```bash
bash tests/test-install.sh            # 用模拟 tunnel-client 测 install.sh（后台进程模式）
python3 tests/test-mcp.py             # muse-mcp.py 协议
node tests/browser/test-browser.mjs   # 浏览器脚本跑本地仿真页面，用一次性的无头 Chrome
```

## 仓库结构

```
skills/muse-chatgpt-setup/
├── SKILL.md                     给 agent 的操作手册
├── references/muse-bootstrap.md 发给 Muse agent 的消息（安装、重启、换 Key、日志、排障）
└── scripts/
    ├── install.sh               在 Muse VM 上运行：安装 / 恢复 / 换 Key / 停止
    ├── muse-mcp.py              极简 MCP 服务（只用标准库）
    └── browser/                 muse-setup.mjs + CDP 驱动 + 中英文界面标签
tests/                           离线测试和仿真页面
```

## License

MIT
