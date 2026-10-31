# Independent host installation

[中文版](host-bootstrap.md)

The same AI completes the web configuration, target installation, connection and one acceptance test; do not use an old machine's directories, ports, proxy, account or runtime environment as a template. Normal use is a complete `run`; this document exists only to explain the platform boundaries and failure recovery, not as an extra checklist to work through every time.

## Targets and dependencies

The controller and the target can be different machines: for example, Windows controlling a Linux SSH target, or a Mac controlling a Windows SSH target. The controller needs Node >=22, plus OpenSSH for remote targets; the target side detects/installs Python >=3.9 independently. The browser runs on the controller and is reached through the user-specified CDP endpoint; the target server does not need a browser installed. Use the existing SSH alias and preserve StrictHostKeyChecking and ProxyJump/ProxyCommand; do not modify the user's known-hosts records.

| Target | Installation method | Background service | Shell |
|---|---|---|---|
| macOS | Python/Homebrew; official `openai/tools/tunnel-client` | Current user's LaunchAgent, after GUI login | Bash |
| Linux x86_64/arm64 + systemd | apt/dnf for Python when missing; pinned official release ZIP + SHA256 | systemd user service, authorized linger | Bash |
| Native Windows 10/11 x64/ARM64 | Per-user winget install for Python when missing; pinned official `.exe` ZIP + SHA256 | Task Scheduler logon task for the current user | Windows PowerShell |

Windows is a new implementation and has not yet been validated end to end on a real system; it must not be presented as equivalent to live-verified support. WSL2 counts as a Linux target only when explicitly selected. If Linux lacks systemd, the architecture is unsupported, or a capability is disabled by enterprise policy, report the prerequisite instead of silently switching systems or users.

Public dependencies:
- [Node](https://nodejs.org/en/download), [Python](https://www.python.org/downloads/)
- [Homebrew](https://brew.sh), [official Tunnel client](https://github.com/openai/tunnel-client)
- [winget](https://learn.microsoft.com/windows/package-manager/winget/)

The package manager that installs Python must not read stdin holding a private request, and must not treat the Key as a password. If macOS hits a real Homebrew administrator approval, Windows lacks winget, or system policy refuses an installation, report it clearly and then resume; do not bypass Gatekeeper, UAC, execution policy or TLS. When Node is missing, the current AI prepares it within its authorization through an official installer or the system package manager; do not go looking for an old project's Node.

## Normal entry point

It can also run outside the complete skill directory; paths are resolved from the skill itself and do not depend on the current shell's working directory.

```bash
# POSIX controller; for the native Windows PowerShell equivalent ($S = Join-Path ...), see SKILL.md.
S="<skill-dir>/scripts/browser/host-connect.mjs"
node "$S" run --target <local-or-ssh-alias> --host-name <slug> --state "<private-dir>/state.json" --cdp <verified-endpoint> --allow-control
# Linux with linger not yet enabled, when authorized: add --enable-linger.
# Native Windows SSH target: add --target-os windows.
```

`run` first creates/verifies the Tunnel, workspace and restricted Key, then installs the independent service. Only use `host install --state ... --allow-control` directly when the Tunnel/Key are already recorded and the deployment itself needs handling. `host status` is a read-only status check; do not probe readiness by reinstalling repeatedly.

Low-level entry points on the target itself (not the complete web flow):

```bash
bash "<skill-dir>/scripts/install.sh" --name <slug> --tunnel-id <id> --key-file <private-file> --allow-control
```

```powershell
& '<skill-dir>/scripts/install.ps1' -Name <slug> -TunnelId <id> -KeyFile <private-file> -AllowControl
```

If the Windows execution policy rejects the `.ps1`, handle it under organizational policy or use the normal Node `run` entry point; do not add `-ExecutionPolicy Bypass`. The direct installation entry point requires an existing Key, and the file must pass a real permission check. The Python/runtime code is a standard-library implementation bundled with the skill, with no pip/npm third-party dependencies.

A Windows SSH target must be able to run `powershell.exe`; the same user must already be interactively logged in for the logon task to run immediately. If a service that starts at machine boot with nobody logged in is required, design an authorized service identity/credential separately; do not advertise the current logon task as that capability.

## Files, services and permissions

| System | Installation directory | Service / logs |
|---|---|---|
| Mac/Linux | `~/.local/share/chatgpt-host/<slug>/` | The independent services below |
| macOS | Same as above | `~/Library/LaunchAgents/com.chatgpt.host.<slug>.{mcp,tunnel}.plist`; `mcp.log` / `tunnel.log` inside the directory |
| Linux | Same as above | `~/.config/systemd/user/chatgpt-host-<slug>-{mcp,tunnel}.service`; `journalctl --user -u <unit>` |
| Windows | `%LOCALAPPDATA%\ChatGPTHost\<slug>\` | `ChatGPTHost-<slug>-{mcp,tunnel}` under the root task folder; `mcp.log` / `tunnel.log` inside the directory |

- These paths use the target user's actual home directory/LocalAppData, not an example username. A same-named directory/task must pass the ownership check and must not overwrite another installation.
- `config.json` does not contain the Key; `runtime-key` is stored separately, and client arguments only reference `file:<path>`.
- POSIX directories are 0700 and files 0600. On Windows, set the DACL for the current user, SYSTEM and Administrators before writing any secret; `chmod(0600)` is not a substitute for Windows permission control. Shared/FAT storage is not suitable for storing a Key.
- The service deployment carries `host-mcp.py` and `host_runtime.py`; Windows also carries its own `host.py` launcher. After a successful installation it does not depend on the original skill checkout; do not copy a single script and leave out the runtime library.
- Windows uses an empty-password `InteractiveToken` / `LeastPrivilege` logon task, needs no extra service wrapper, and never elevates by itself. Stopping a task closes the child-process Job it manages; a single command timeout also cleans up its child process tree.
- On every platform the MCP/health ports listen on loopback only, installation automatically picks a free port, and no public inbound access is opened. Ports from old connections are not reused, and old services are not stopped or given larger permissions.

## Networking and readiness

Proxy selection is based on the **target's** environment/system settings, or an explicit `--control-plane-proxy auto|direct|<HTTP(S)-URL>`. macOS/Windows automatically read the system proxy that Python supports; Linux uses the target environment. If nothing automatic is available, the connection is direct; a complex PAC, an authenticated proxy or an enterprise CA needs user configuration — do not copy the controller's localhost port or disable certificate verification.

The proxy applies only to OpenAI outbound traffic; MCP loopback stays direct. Client downloads likewise require the target to reach GitHub, and "the browser can open the page" is not a substitute for diagnosing the target's network. A reinstall keeps only the proxy/client selected for this configuration; `--client-bin` is an explicit external-dependency option, not the default path.

Installation's `installed:true` is separate from the first successful poll: the MCP `/healthz` check validates identity/control, and the host counts as control-plane ready only when the client's `/metrics` value `commands_poll_last_successful_timestamp_seconds` is less than 90 seconds old. `PENDING` does not trigger a reinstall. A Linux host that keeps running after SSH exits depends on authorized linger; macOS/Windows by default still require the user to be logged in and the machine awake. Do not claim autostart was verified if there was no reboot/logoff.

## Troubleshoot only on failure

| Symptom | Bounded, targeted recovery |
|---|---|
| Browser not found | Discover it using the configuration directory / explicit endpoint in [browser-connection.md](browser-connection.md); do not scan ports, copy another machine's launcher, or kill processes to open a new profile. |
| Page has text but every button is transparent and animations have stopped | `page_render_stalled`: the script pauses clicking and the current AI inspects this window's rendering/focus and repairs it, preserving the tab/state; do not edit CSS, restart the browser, or re-check selectors repeatedly. Only a just-created, unsubmitted entry page with no dialog may automatically move once to a new window inside the same designated profile; existing forms/restored tabs are never moved. |
| Blank page, no buttons | Look at the Document/Script/Stylesheet loading errors. A single resource returning 401/403 does not by itself mean the whole page failed: within the original control wait (normally 12 seconds), observe the original page and continue only if the target control becomes visible and usable with no login/CAPTCHA blocker, keeping the warning; if it is still unusable when the wait expires, the current AI takes over the diagnosis; if the original page later becomes usable, continue the original flow instead of immediately asking the user to log in again. Never blindly refresh or bypass a denied page; an unexplained temporary blank page may be refreshed once after a delay, and if it does not recover, stop rather than clicking Create repeatedly. A submitted form/chat is never refreshed automatically. |
| A Key dialog already exists and a rerun is blocked behind it | Reuse the form recorded for this same run: close its dropdown first, then fill/verify; do not click the Create button behind it. Do not take over an unknown dialog on your own initiative. A Key already displayed can be captured privately from this run's dialog; do not create another one. |
| Python/client cannot run | Verify the target OS/architecture and the official release artifacts; do not copy an old `.venv` or an old connection's binary. Report it when real administrator permission is missing. |
| This run's MCP identity does not match | Take the port/host_id from this run's config; do not stop another service occupying a port, and do not count another connection's healthy result as this run's success. |
| MCP healthy, poll still PENDING | Wait read-only for up to 90 seconds; on timeout, distinguish this tunnel's DNS, TLS, proxy and authentication issues; do not reinstall or rebuild the Tunnel. |
| 401 / invalid key | Verify the independent Key's source, expiry, organization and Tunnels Read + Use permissions; do not print the secret and do not widen its permissions. |
| 403 / 404 / tunnel not found | Verify the ID, organization/workspace and role; visibility can also cause a 404. Visit the relevant pages only when the diagnosis requires it. |
| Windows task does not start | Verify that the same user is logged in, the task ownership, and Task Scheduler permissions. Inspect only this run's task results/logs; do not switch it to SYSTEM, save a password, or bypass UAC. |
| A plist/unit change did not take effect | On macOS, lint this run's plist first, then owned bootout/bootstrap; on Linux, only daemon-reload and this run's unit. Do not bulk-restart other connections. |
| Desktop/Documents access denied | Distinguish file permissions, macOS TCC, and Windows Controlled Folder Access/policy; request only the authorization the actual target operation needs, and do not read a real private key to prove permission. |
| OAuth discovery warning | This run's MCP has no OAuth and the plugin uses No authentication; judge from the poll and tool results together, and do not declare failure/success from the warning alone. |
| Connect does not appear after plugin creation | Wait for an explicit state on the original page; do not detour through lists/APIs. The shared budget is 90 seconds, and a submitted object is recovered rather than rebuilt. |
| Approval dispatched but the page still shows Allow once | `approval_not_confirmed`: a click returning is not approval success. If there is still no UI transition or host evidence after five seconds, the current AI takes over: check the execution evidence first, then address confirmed issues such as the original card's focus/overlay; do not click a second time automatically or burn the full 90 seconds, and do not clear the dispatch record to force a retry. Keep the original task and continue after the repair. |
| The approval card was not clicked automatically | On the original task's tab, confirm the single card belongs to this run's app and click Allow once directly; do not open the details, parse the JSON, approve another app, switch to Always allow, or send a second task. If an earlier attempt left a details overlay open, close it once and then approve. |
| Command timeout / tool output error | Verify whether it already executed and whether files/success logs exist; a timeout does not mean it never happened, and do not repeat a side-effecting command verbatim. |

**The script stopping does not mean the task stops.** A technical failure returns `SAME_AI_RECOVERY`, and the current AI takes over: inspect the original page, this run's service and the specific error, repair what can be safely repaired, verify, and then continue from the original state. The `STOP_AND_REPORT` wording in older technical errors is likewise no longer a reason to abandon a task outright. Only report a blocker clearly to the user when login/MFA/CAPTCHA is genuinely required, authorization/administrator permission is missing, or an external failure truly cannot be resolved safely.

The AI's overall recovery is no longer capped at 90 seconds or at giving up after two failures; every diagnosis and action still has a timeout, and the same failure must be met with a different method based on new evidence — not by rerunning it verbatim, reading the entire source first, or looping on fixed sleeps. The script phases and the acceptance test keep their original 90-second budgets, and any recovery or late completion after a timeout is reported separately and honestly.

For credential diagnostics, read the private file inside the process and set the request header there; output only the status code and necessary metadata, and do not use `curl -H` shell expansion of a secret. A normal successful poll does not add an extra key-verification request. Shell output redaction is best-effort, not data-access isolation.

## Acceptance and reporting

After the plugin is confirmed, send exactly one `execute_terminal` task: the target shell/Python verifies the host_id, exclusively writes a random marker and reads it back. The controller checks the file and the successful command's hash. On Windows, PowerShell launches the target Python; do not apply Bash encoding/quoting rules to it; the marker is written in fixed UTF-8/LF so the evidence matches across systems.

Stop waiting once the 90-second budget has passed; any later explicit recovery only rechecks the original evidence and does not resend automatically. Once it passes, `REPORT_AND_STOP`: do not wait for a long chat reply and do not re-check logs/health/the plugin repeatedly. At most one read-only comparison against the old connections that has not been done yet. Report the total configuration time, first-install versus reused dependencies, the original acceptance time, and any model/human recovery separately; do not present a 51-millisecond evidence recheck as the whole acceptance time. `workflow_wall_ms` starts at the first real `run` and includes recovery; it must not be presented as the total time since the user made the request — browser discovery and AI preparation time before that are counted separately.

This repository's isolated tests do not use production accounts, real Keys, paid models or real persistent services; CI configuration for three operating systems does not mean CI has run. For each platform, state separately whether the real web flow, a pristine machine, a reboot, and post-login behavior have been verified.
