# chatgpt-host-connect

**Beta: connect ChatGPT to computers and servers.** macOS and Ubuntu live workflows have passed; native Windows remains experimental.

[中文说明](README.zh-CN.md) · [Skill](skills/chatgpt-host-connect/SKILL.md) · [MIT](LICENSE)

One AI connects ChatGPT to an **independent macOS, Linux or native Windows installation** through OpenAI Secure MCP Tunnel: create Tunnel/Key, install the host, connect the ChatGPT app and verify one tool call. No Muse, second-agent handoff, old connection, private runtime or author-specific browser helper.

## Platform status

| Target | Runtime / persistence | Verification |
|---|---|---|
| macOS | Bash, Python, official Homebrew client; LaunchAgents after GUI login | Current workflow passed live, including same-AI recovery of an interrupted setup. Not a pristine-machine or reboot test. |
| Linux x86_64/arm64 + systemd | Bash, Python, verified official release; user units + authorized linger | Current Ubuntu workflow passed live: six steps in one run, one automatic rendering recovery, one verified terminal call. Other distributions/architectures are not live-validated. |
| Native Windows 10/11 x64/ARM64 | PowerShell, Python, verified official EXE; least-privilege user logon tasks | New backend. Native/live end-to-end **NOT VERIFIED**; not a production-parity claim. |

WSL2 is an explicitly selected Linux target, not a substitute for native Windows. macOS/Windows default persistence requires a logged-in, awake user session. Other systems/architectures or restrictive policies stop with prerequisites; no silent elevation or OS substitution.

The tools provide shell execution, file read/write and directory listing with the service user's permissions. **Not sandboxed.** No trading, publishing or paid inference permission is implied.

## Download / install

Download a ZIP from [Releases](https://github.com/elaeuk-wq/chatgpt-host-connect/releases) or clone [the repository](https://github.com/elaeuk-wq/chatgpt-host-connect), then give your AI the full [`skills/chatgpt-host-connect/`](skills/chatgpt-host-connect) directory. Do not copy only `SKILL.md`. It can live anywhere supported by your agent; scripts locate their bundled files relative to themselves.

No secrets or state ship in the download. Controller: **Node >=22**, and OpenSSH for remote targets. Target: **Python >=3.9**, prepared by authorized Homebrew/apt/dnf/winget setup when missing. No pip/npm dependencies. The official tunnel client is installed independently of old services. Account access, real administrator approvals, login/MFA and browser-debugging permission remain user prerequisites.

Example request to your AI:

> Read this skill and independently connect ChatGPT to my selected computer or server (local or an authorized SSH alias), named work-host. Use my selected browser/profile. I authorize necessary dependency installation, a new Tunnel, restricted Key, ChatGPT app and persistent user services (including Linux linger when needed). Preserve existing connections. Complete ordinary setup/approval clicks yourself, stop for real owner prerequisites, and report actual evidence, timing and fallbacks.

### Select a browser, not a machine-specific launcher

Use the owner-selected Chrome/Edge/Chromium profile. `browser-discover --browser-user-data-dir <path>` reads its live debugging metadata; `--cdp <verified-URL>` supports fixed/custom endpoints. No guessed port, port scan, profile creation, browser restart or cookie copying. See [browser connection](skills/chatgpt-host-connect/references/browser-connection.md).

macOS/Linux controller:

```bash
S="<skill-dir>/scripts/browser/host-connect.mjs"
node "$S" browser-discover --browser-user-data-dir "<selected-user-data-dir>"
node "$S" run --target local --host-name work-host --state "<private-dir>/state.json" --cdp <verified-CDP-URL> --allow-control
```

Windows PowerShell controller:

```powershell
$S = Join-Path '<skill-dir>' 'scripts/browser/host-connect.mjs'
node $S run --target local --host-name work-host --state '<private-dir>/state.json' --cdp <verified-CDP-URL> --allow-control
```

For SSH use the owner's configured alias; add `--target-os windows` for a native Windows remote host. Controller and target OS are independent. Linux linger requires authorized `--enable-linger`. Default `--host-mode script` does all six steps; explicit agent mode means the same AI adapts the host, not a handoff.

## Workflow and safeguards

`tunnel → key → host-install → host-wait → plugin → test`

- Separate private state, install directory, identity, free loopback ports and owned services per installation. No repointing old connections.
- POSIX 0700/0600; Windows current-user DACL. Keys travel in private files/stdin, never argv/chat/attachments. The Windows backend uses no login password or SYSTEM task.
- Target-side proxy discovery or an explicit HTTP(S) proxy. Never copy the controller's localhost proxy to a remote host; no TLS verification bypass.
- Start with one full run, not a source audit/dry run. Technical failure yields `SAME_AI_RECOVERY`: the same AI diagnoses, repairs within authorization and resumes the original state, rather than asking the user to finish routine setup. Individual actions stay bounded; no blind retries or duplicate objects. Genuine login/permission prerequisites and proven external blockers are reported.
- A two-second animation-frame check detects frozen rendering. Only a brand-new, unsubmitted entry tab may move to one fresh window in the same selected profile; saved forms/tasks stay put. No CSS changes or browser restarts.
- Blank pages are page-load failures, with at most one safe entry-page retry; resource 401/403 is not blindly refreshed. Key recovery reuses the owned form rather than clicking a background button.
- One Platform tab, one ChatGPT tab. Plugin creation waits and connects on its original page; no API/list round trips.
- Acceptance approval directly clicks **Allow once** for the selected app in the original task tab. No routine View details or JSON review; no Always allow. Dispatch is not success: an unchanged approval control is reported within five seconds, not blindly clicked again.
- One ChatGPT task / one shell call verifies identity and writes/reads one marker. The controller independently matches the file and successful command hash. Finish without waiting for model prose.
- 90-second phase budgets; timeout recovery checks the same evidence, not a new task. Readiness alone is not success.

Read [SKILL.md](skills/chatgpt-host-connect/SKILL.md) for authorization, ownership and recovery; [host-bootstrap.md](skills/chatgpt-host-connect/references/host-bootstrap.md) for service locations and failure diagnosis.

## Offline tests

```text
python tests/test-mcp.py
python tests/test-portability.py
node tests/browser/test-portability.mjs
node tests/browser/test-browser.mjs
```

On macOS/Linux additionally run `python3 tests/test-host.py`. Node browser tests require a local Chrome executable (`CHROME` can override); they create a temporary isolated headless profile, never touch the user's browser or use production accounts. Windows Job/ACL checks run natively only on Windows. Service lifecycle calls are mocked; the native Task Scheduler XML test validates in memory without registering a task.

[CI](.github/workflows/test.yml) defines macOS/Linux/Windows offline jobs. Adding CI is not evidence that it has run, and offline tests do not establish pristine-machine or real ChatGPT end-to-end reliability. Report each separately.

The skill and CLI are now `chatgpt-host-connect` and `host-connect.mjs`. For compatibility, the existing default state directory `~/.chatgpt-host-setup/`, host ownership marker and installed service names are unchanged. To resume a pre-rename direct-host installation, pass its original `--state` explicitly; do not recreate it. This download does not migrate or restart installed hosts.

Legacy Muse states are refused, not migrated. Existing connections and runtime keys are not automatically removed. Redaction is best-effort, not access isolation; only grant control to trusted accounts/workspaces.
