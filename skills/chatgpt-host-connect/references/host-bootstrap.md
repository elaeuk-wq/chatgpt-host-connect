# Independent host installation / 独立跨平台部署

同一个 AI 完成网页配置、目标安装、连接和一次验收；不要把旧机器目录、端口、代理、账号或运行环境作为模板。正常使用完整 `run`；这份说明只用于理解平台边界和失败恢复，不是每次都要跑一遍的额外检查清单。

## 目标与依赖

控制端和目标端可以不同：例如 Windows 控制 Linux SSH、Mac 控制 Windows SSH。控制端需要 Node >=22，远程需要 OpenSSH；目标侧独立检测/安装 Python >=3.9。浏览器在控制端，通过用户指定的 CDP 访问，不要求目标服务器安装浏览器。使用已有 SSH alias，保留 StrictHostKeyChecking、ProxyJump/ProxyCommand，不改用户的主机密钥记录。

| 目标 | 安装方式 | 后台服务 | shell |
|---|---|---|---|
| macOS | Python/Homebrew；官方 `openai/tools/tunnel-client` | 当前用户 LaunchAgent，GUI 登录后 | Bash |
| Linux x86_64/arm64 + systemd | 缺 Python 时 apt/dnf；官方固定版本 ZIP + SHA256 | systemd 用户服务，授权 linger | Bash |
| 原生 Windows 10/11 x64/ARM64 | 缺 Python 时 winget 按用户安装；官方固定版本 `.exe` ZIP + SHA256 | Task Scheduler 当前用户登录任务 | Windows PowerShell |

Windows 是新增实现，真实系统端到端尚未验证，不能等同于已通过实机验证。WSL2 只在明确选择时作为 Linux 目标。Linux 没有 systemd、其他架构或被企业策略禁用的能力，应报告先决条件，不悄悄换系统/用户。

公开依赖：
- [Node](https://nodejs.org/en/download)、[Python](https://www.python.org/downloads/)
- [Homebrew](https://brew.sh)、[官方 Tunnel 客户端](https://github.com/openai/tunnel-client)
- [winget](https://learn.microsoft.com/windows/package-manager/winget/)

安装 Python 的包管理器不能读取存放私有请求的 stdin，也不能把 Key 当密码。Mac 遇到真实 Homebrew 管理员审批、Windows 缺 winget、系统政策拒绝安装等，明确报告后恢复；不绕过 Gatekeeper、UAC、执行策略或 TLS。Node 缺失时由当前 AI 在授权范围内通过官方安装器/系统包管理器准备；不要找旧项目的 Node。

## 正常入口

在完整技能目录之外也能运行；路径从技能自身解析，不依赖当前 shell 的工作目录。

```bash
# POSIX 控制端；原生 Windows PowerShell 对应 $S = Join-Path ...，参见 SKILL.md。
S="<skill-dir>/scripts/browser/host-connect.mjs"
node "$S" run --target <local-or-ssh-alias> --host-name <slug> --state "<private-dir>/state.json" --cdp <verified-endpoint> --allow-control
# Linux 尚未开启 linger 且已授权：添加 --enable-linger。
# 原生 Windows SSH 目标：添加 --target-os windows。
```

`run` 先创建/验证 Tunnel、工作区和受限 Key，再安装独立服务。只有 Tunnel/Key 已记录且确需处理部署时才直接 `host install --state ... --allow-control`。`host status` 是只读状态，不要用重复安装来探测 readiness。

目标本地的低层入口（不是完整网页流程）：

```bash
bash "<skill-dir>/scripts/install.sh" --name <slug> --tunnel-id <id> --key-file <private-file> --allow-control
```

```powershell
& '<skill-dir>/scripts/install.ps1' -Name <slug> -TunnelId <id> -KeyFile <private-file> -AllowControl
```

若 Windows 执行策略拒绝 `.ps1`，按组织政策处理或使用正常 Node `run` 入口；不要加 `-ExecutionPolicy Bypass`。直接安装入口需要已有 Key，且文件通过真实权限检查。Python/运行代码是随技能携带的标准库实现，没有 pip/npm 第三方依赖。

Windows SSH 远端必须能运行 `powershell.exe`；同一用户须已交互登录，登录任务才能立即运行。若需要机器启动但无人登录时的服务，另行设计经授权的服务身份/凭据，不能把当前登录任务宣传成该能力。

## 文件、服务和权限

| 系统 | 安装目录 | 服务/日志 |
|---|---|---|
| Mac/Linux | `~/.local/share/chatgpt-host/<slug>/` | 下述独立服务 |
| macOS | 同上 | `~/Library/LaunchAgents/com.chatgpt.host.<slug>.{mcp,tunnel}.plist`；目录内 `mcp.log` / `tunnel.log` |
| Linux | 同上 | `~/.config/systemd/user/chatgpt-host-<slug>-{mcp,tunnel}.service`；`journalctl --user -u <unit>` |
| Windows | `%LOCALAPPDATA%\ChatGPTHost\<slug>\` | 根任务目录下 `ChatGPTHost-<slug>-{mcp,tunnel}`；目录内 `mcp.log` / `tunnel.log` |

- 这些路径使用目标用户的实际主目录/LocalAppData，不使用示例用户名。同名目录/任务必须通过 ownership 校验，不能覆盖其他安装。
- `config.json` 不含 Key；`runtime-key` 单独保存，客户端参数仅引用 `file:<path>`。
- POSIX 目录0700/文件0600。Windows 先设置当前用户、SYSTEM、Administrators 的 DACL，再写入秘密；`chmod(0600)` 不能冒充 Windows 权限控制。共享/FAT存储不适合保存 Key。
- 服务部署携带 `host-mcp.py`、`host_runtime.py`；Windows 还携带自己的 `host.py` 启动器。成功安装后不依赖原技能 checkout；不得只复制一个脚本而漏掉运行库。
- Windows 采用密码为空的 `InteractiveToken` / `LeastPrivilege` 登录任务，无需额外服务包装器，不会自动提权。停止任务会关闭所管理的子进程 Job；单次命令超时也清理其子进程树。
- 所有平台 MCP/健康端口只监听回环，安装自动选空闲端口，不开放公网入站。旧连接端口不复用，旧服务不停止、不扩大权限。

## 网络与 readiness

代理选择基于**目标**的环境/系统设置，或显式 `--control-plane-proxy auto|direct|<HTTP(S)-URL>`。Mac/Windows 自动读取 Python 支持的系统代理，Linux 使用目标环境。无自动可用项就是直连；复杂 PAC、认证代理或企业 CA 需要用户配置，不能复制控制端 localhost 端口或关闭证书验证。

代理只作用于 OpenAI 出站，MCP 回环直连。客户端下载同样要求目标能访问 GitHub，不能用“浏览器能打开网页”代替目标网络诊断。重装只保留本次配置所选的代理/客户端；`--client-bin` 是显式外部依赖选项，不是默认路径。

安装 `installed:true` 与首次成功 poll 分开：MCP `/healthz` 校验 identity/control，客户端 `/metrics` 的 `commands_poll_last_successful_timestamp_seconds` 距今小于90秒才算控制面就绪。`PENDING` 不触发重装。退出 SSH 的 Linux 运行依赖已授权 linger；Mac/Windows 默认仍需要登录、机器醒着。没有重新启动/注销就不要说验证了自启。

## 只在失败时排错

| 现象 | 有限、针对性的恢复 |
|---|---|
| 找不到浏览器 | 用 [browser-connection.md](browser-connection.md) 的配置目录/明确端点发现；不要扫描端口、抄另一台机器的 launcher 或杀进程开新 profile。 |
| 页面有文字但按钮全透明、动画停止 | `page_render_stalled`：脚本暂停点击，由当前AI检查本次窗口渲染/焦点并修复，保留标签页/状态；不改CSS、不重启浏览器、不反复查选择器。仅刚新建、未提交且无弹窗的入口允许自动换到同一指定profile内的新窗口一次；已有表单/恢复标签页不搬走。 |
| 空白页、无按钮 | 看 Document/Script/Stylesheet 加载错误。单个资源401/403不直接判整页失败：在原控件等待期限内（通常12秒）观察原页，目标控件可见可用且无登录/验证码阻塞才继续，并保留警告；到期仍不可用由当前AI接手诊断；原页后来可用则继续原流程，不直接要求用户重登录。拒绝页不盲刷新、不绕过；未知临时空白只允许一次延时刷新，未恢复就停止，不反复点创建。提交过的表单/聊天不能自动刷新。 |
| Key 已有弹窗，重跑被遮挡 | 同一运行记录的表单复用，先关其下拉列表再填/核对；不点击背后的 Create。未知弹窗不擅自接管。已显示的 Key 可从本次弹窗私下捕获，不能再创建。 |
| Python/客户端无法运行 | 核对目标 OS/架构和官方发行物；不复制旧 `.venv` 或旧连接 binary。缺实际管理员权限就报告。 |
| 本次 MCP identity 不符 | 从本次 config 取端口/host_id；不能停止占用端口的其他服务，也不能把另一连接的健康结果当本次成功。 |
| MCP 健康，poll 仍 PENDING | 90秒内只读等待，超时区分本次 tunnel 的 DNS、TLS、代理、认证；不重复安装、不重建 Tunnel。 |
| 401 / invalid key | 核对独立 Key 来源、有效期、组织、Tunnels Read + Use；不打印秘密，不放宽权限。 |
| 403 / 404 / tunnel not found | 核对 ID、组织/工作区/角色，可见性也会造成404；只在诊断需要时访问相应页面。 |
| Windows task 不启动 | 核对同一用户是否登录、任务 ownership、Task Scheduler 权限。只检查本次任务结果/日志；不要改为 SYSTEM、保存密码或绕过UAC。 |
| plist/unit 修改未生效 | Mac 对本次 plist 先 lint，再 owned bootout/bootstrap；Linux 仅 daemon-reload 与本次 unit。不要批量重启其他连接。 |
| Desktop/Documents 被拒绝 | 区分文件权限、macOS TCC、Windows受控文件夹/政策；只对实际目标操作请求必要授权，不读取真实私钥证明权限。 |
| OAuth discovery 警告 | 本次 MCP 无 OAuth，插件 No authentication；结合 poll 与工具结果判断，不凭警告单独宣判失败/成功。 |
| 插件创建后 Connect 未出现 | 原页等待明确状态，不去列表/API兜圈；共90秒预算，已提交的对象恢复而不重建。 |
| 已派发批准但仍显示允许一次 | `approval_not_confirmed`：点击返回不等于批准成功；五秒仍无界面反馈/主机证据就由当前AI接手，先查执行证据，再处理原卡片的焦点/遮罩等已确认问题；不自动二次点击或耗尽90秒，不清空派发记录强行重试。原任务保留，修复后继续。 |
| 批准卡片未自动点击 | 原任务标签页确认唯一卡片归属本次 app，直接 Allow once；不打开详情、不解析 JSON，不批准其他应用、不改 Always allow、不发第二任务。若旧尝试已有详情遮罩，只关一次再批准。 |
| 命令超时/工具输出报错 | 核实是否已执行、有无文件/成功日志；超时不意味着未发生，不原样重复有副作用命令。 |

**脚本停，不等于任务停。** 技术失败返回 `SAME_AI_RECOVERY`，由当前AI接手：检查原页/本次服务和具体错误，修复可安全解决的问题，验证后沿用原状态继续。旧版技术错误里的 `STOP_AND_REPORT` 也不再作为直接放弃任务的理由。只有确认需登录/MFA/验证码、缺授权/管理员权限，或外部故障确实无法安全解决，才向用户明确报告阻塞。

不再把AI整个补救限制为90秒或失败两次就放弃；每次诊断和动作仍有超时，相同失败要根据新证据换方法，不能反复原样重跑、先读遍源码或连续固定sleep。脚本阶段及验收原有90秒预算不变，超时后的补救与迟到完成如实另计。

凭据诊断只用进程内部读取私有文件并设置请求头；输出状态码和必要元数据，不用 `curl -H` shell展开密钥。正常成功 poll 不再增加一个验Key请求。shell输出脱敏是尽力而为，不是数据访问隔离。

## 验收和报告

插件确认后只发一个 `execute_terminal` 任务：目标 shell/Python 验证 host_id，独占写随机标记并读回。控制端核对文件与成功命令哈希。Windows 用 PowerShell启动目标Python，编码/引用不套用Bash；标记写入固定UTF-8/LF，跨系统证据一致。

90秒预算过后停止等待；后续显式恢复仅复查原证据，不自动重发。通过后 `REPORT_AND_STOP`，不等聊天长回复、不反复查日志/健康/插件。最多做一次尚未完成的旧连接只读对照。总配置耗时、首次安装/复用依赖、原验收耗时、模型/人工补救分别报告；不要把51毫秒证据复查当全部验收时间。`workflow_wall_ms` 从首次正式run起算并包含恢复，不能冒充从用户提出任务起的总耗时；之前浏览器查找、AI准备时间另计。

本仓库隔离测试不使用生产账户、真实 Key、付费模型或真实持久服务；三系统CI配置不等于CI已运行。每个平台真实网页、全新机器、重启和登录后行为分别标明是否已验证。
