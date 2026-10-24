# chatgpt-host-connect

**ChatGPT 连接电脑与服务器 · 试用版。** macOS、Ubuntu 已通过真实流程验证；原生 Windows 仍为实验性支持。

[English](README.md) · [技能入口](skills/chatgpt-host-connect/SKILL.md) · [MIT](LICENSE)

让**同一个 AI**把 ChatGPT 接到一台独立的 macOS、Linux 或原生 Windows 主机：配置 Tunnel/Key、部署服务、连接插件、完成一次真实工具验收。无需 Muse、第二个 AI、旧连接、作者的浏览器脚本或私人运行目录。

## 平台边界与验证状态

| 目标 | 命令 / 自启动 | 验证状态 |
|---|---|---|
| macOS | Bash、Python、官方 Homebrew 客户端；GUI登录后的 LaunchAgent | 当前流程已实测成功，包括同一AI补救并继续中断流程；不是全新机器或重启验证 |
| Linux x86_64/arm64 + systemd | Bash、Python、校验官方发行物；用户服务 + 授权 linger | 当前Ubuntu流程实测六步一次完成，含一次脚本自动页面恢复、一次真实终端验收；其他发行版/架构尚未实测 |
| 原生 Windows 10/11 x64/ARM64 | PowerShell、Python、校验官方EXE；当前用户登录计划任务 | 新增实现，**原生系统及真实端到端尚未验证**，不能宣称生产可用性与前两者相同 |

WSL2 是用户明确选择的 Linux 目标，不能冒充原生 Windows。Mac/Windows 默认需要用户登录、机器醒着；不是无人登录的系统服务。其他系统、CPU、缺失systemd或企业政策限制应明确报告，不悄悄换系统、提权或绕过安全措施。

工具提供命令执行、文件读写和目录查看，权限等同服务用户，**不是沙箱**。不隐含交易、提现、发布或付费推理授权。

## 下载后使用

从 [Releases](https://github.com/elaeuk-wq/chatgpt-host-connect/releases) 下载ZIP，或克隆[仓库](https://github.com/elaeuk-wq/chatgpt-host-connect)，把完整的 [`skills/chatgpt-host-connect/`](skills/chatgpt-host-connect) 目录交给你的AI，或放进它支持的技能目录。**不要只复制 SKILL.md。** 安装位置任意，脚本按自身位置找资源，不依赖作者目录或当前工作目录。

- 控制端：Node >=22，SSH目标还需OpenSSH；缺失时由AI在授权范围内从官方/系统包管理器准备。
- 目标端：Python >=3.9，缺失时用 Homebrew、apt/dnf 或 per-user winget 准备；无pip/npm第三方依赖。
- Tunnel客户端来自官方包/经过SHA256校验的固定发行版，不从旧连接里找。
- 仍需要真实账户权限、登录/MFA、必要管理员审批和浏览器调试权限。“独立安装”不等于不需要公共软件或联网。

给AI的通用提示词：

> 读取这个技能，在我指定的电脑或服务器（本机或已授权的SSH别名）上完成一次独立接入，名称为 work-host，使用我指定的浏览器和账户。我授权必要依赖安装、新建 Tunnel、受限 Key、ChatGPT 插件和本次持久用户服务，包括Linux需要时启用linger。保护其他连接；由你完成正常配置和批准点击，真实登录/验证码/管理员权限缺失时才报告。按技能完成一次验收，分别报告配置和验收耗时、复用与新装依赖、脚本失败及补救动作。

### 浏览器按用户选择接入

Chrome/Edge/Chromium均通过CDP接入，不限定“chrome1”之类的私人名称。用选定的用户数据目录执行 `browser-discover`，或直接传已核实的CDP URL；不猜固定端口，不扫描任意进程/端口，不擅自重启、复制cookie或新建profile。

详见[跨平台浏览器接入](skills/chatgpt-host-connect/references/browser-connection.md)。

macOS/Linux控制端：

```bash
S="<skill-dir>/scripts/browser/host-connect.mjs"
node "$S" browser-discover --browser-user-data-dir "<选定的用户数据目录>"
node "$S" run --target local --host-name work-host --state "<私有目录>/state.json" --cdp <已核实的CDP-URL> --allow-control
```

Windows PowerShell控制端：

```powershell
$S = Join-Path '<skill-dir>' 'scripts/browser/host-connect.mjs'
node $S run --target local --host-name work-host --state '<私有目录>/state.json' --cdp <已核实的CDP-URL> --allow-control
```

远程把 `local` 改成用户已配置的SSH别名；原生Windows远端额外指定 `--target-os windows`。不能用控制端OS推断目标OS。Linux开启linger额外需要已授权的 `--enable-linger`。

## 同一套流程，只有系统边界不同

`tunnel → key → host-install → host-wait → plugin → test`

- 每次使用独立状态、目录、host_id、空闲回环端口和有归属标记的服务；不借用或修改其他连接。
- POSIX目录0700/文件0600；Windows真实DACL保护。Key只在私有文件/stdin传输，不进聊天、argv或附件。
- Windows不保存登录密码，不用SYSTEM任务；目标权限仍受UAC和系统政策约束。
- 代理在目标侧发现或显式指定；不写死软件/端口，不把控制端localhost代理套到远端。
- 一次完整run先行，不先审计源码或例行dry-run。技术失败由当前AI兜底：诊断、修复、验证后继续原状态，不能直接把普通操作丢给用户。每次动作仍限时，不盲重试、不重复创建；真实登录/权限缺失或无法安全解决的外部阻塞才报告。
- 两秒检测动画帧；仅刚新建、未提交的入口冻结时，在同一指定profile内换新窗口一次。旧表单/恢复标签页不搬走，不改CSS、不重启浏览器。
- 空白页单独报告加载失败；未提交的空白入口最多延时刷新一次，401/403不盲重试。Key恢复复用本次已有弹窗。
- Platform/ChatGPT各用一个绑定标签页；插件创建后原页等连接，不去列表/API兜圈。
- 原任务中确认批准卡片属于本次app，直接点**允许一次**；不打开详情、不解析JSON、不点始终允许。派发点击不算成功：五秒仍有可用批准按钮且无执行证据就报告，不盲目补点或继续空等。
- 一次ChatGPT任务、一次终端命令：验证身份、写随机标记、读回；控制端独立核对文件和成功命令哈希。通过立即收尾，不等模型长回复。
- 90秒阶段预算，超时复查原证据而不自动重发。仅ready/ChatGPT说成功不算完成。

完整要求见 [SKILL.md](skills/chatgpt-host-connect/SKILL.md)，服务位置与故障恢复见[主机部署说明](skills/chatgpt-host-connect/references/host-bootstrap.md)。

## 测试与公开发布

```text
python tests/test-mcp.py
python tests/test-portability.py
node tests/browser/test-portability.mjs
node tests/browser/test-browser.mjs
```

Mac/Linux额外运行 `python3 tests/test-host.py`。浏览器测试需安装Chrome，可用 `CHROME` 指定；测试创建临时隔离无头profile，不操作用户浏览器、不访问正式账户、不使用真实Key或付费模型。服务管理调用模拟；Windows Job/ACL检查只能在原生Windows执行，计划任务XML只内存校验、不注册任务。

[CI配置](.github/workflows/test.yml)覆盖三系统，但**写好CI不等于CI已经跑过**。隔离测试不代表全新机器或真实ChatGPT端到端验证。每个平台、冷安装、重启、自启的验证结果应分别报告，不把AI补救说成脚本全自动通过。

技能名和CLI入口已改为 `chatgpt-host-connect`、`host-connect.mjs`。为兼容现有独立安装，默认状态目录 `~/.chatgpt-host-setup/`、主机归属标记和已安装服务名保持不变。恢复改名前的直接主机安装时，显式传入原 `--state`，不要重建。下载新版不会迁移或重启已安装主机。

旧Muse状态拒绝直接复用，不迁移/停用旧连接，不自动删除Key或用户数据。脱敏只是尽力处理，不是权限隔离；只向可信账户/工作区开放控制。
