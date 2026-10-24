---
name: chatgpt-host-connect
description: Connect ChatGPT to an independent computer or server (macOS, Linux, or experimental native Windows) via OpenAI Secure MCP Tunnel. The same AI configures Platform, installs the bundled host tools, connects the app and verifies one task. Portable local/SSH setup; no previous connection, personal browser wrapper, fixed port or developer machine required.
---

# ChatGPT host connect — computers and servers

Use **one AI** to complete the entire workflow. This skill exposes login-user shell/file control through `execute_terminal`, `read_file`, `write_file` and `list_directory`. It is **not a sandbox**. Do not delegate ordinary clicks to the owner or another AI.

## Script first; do not turn installation into a debugging project

- Read this skill, resolve the owner's already-selected browser/target, confirm authorization, then invoke **one full `run`**. Do not pre-read every script, count source lines, run a routine `--dry-run`, enumerate every browser, or probe multiple proxies before an actual failure.
- Use a supplied/previously verified endpoint for that selected browser first. Reading its saved endpoint is allowed; borrowing an old connection's Key, Tunnel or host service is not. Otherwise inspect only the selected launcher's configuration and its profile metadata. Keep initial browser discovery/preparation short (normally within two minutes). If it fails, the same AI diagnoses the selected configuration/endpoint rather than immediately ending the task, searching unrelated directories or launching another browser. Ask the user only for a confirmed prerequisite that needs their action.
- Let the runner perform clicks, readiness polling and approval. If the harness backgrounds it, use its completion notification; do not issue sequences of `sleep 45/75/90` plus log tails. These waits do not fix a blocked page and delay handling failures.
- **The current AI owns recovery. A CLI failure stops automatic actions, not the task.** `next_action:SAME_AI_RECOVERY` means read the scoped `recovery`/`takeover` instructions, diagnose, repair within authorization, verify, and resume the same state/tab/task. Do not hand ordinary configuration clicks to the owner or another AI. Older `STOP_AND_REPORT` technical errors also mean stop the blind script path and take over—not abandon the task.
- There is no blanket 90-second limit on the AI's entire recovery or a rule to give up after two selector failures. Every diagnostic/action still has a finite timeout; repeated failure requires a different evidence-based approach. Continue while new evidence supports a safe next action. Avoid unchanged retries, fixed-sleep loops, broad source audits and unapproved network/browser changes. A proven external blocker with no safe authorized remedy must be reported honestly, not hidden behind endless activity.
- Dependency installation and real login/admin prerequisites are reported separately, not disguised as AI preparation. These limits do not relax the one-command proof or the existing 90-second acceptance budget. Offline tests do not establish real-world completion time.

## Portability contract

- Install this **entire directory**, including `scripts/` and `references/`, anywhere in the user's AI skill directory or checkout. Resolve paths relative to this skill, never a developer home directory or the current shell directory.
- No old Tunnel, Key, MCP server, client binary, virtualenv, browser wrapper or other project is required. Obtain missing public dependencies from their official distributions. Reusing an installed public dependency is allowed and must be reported; reusing another connection's private installation is not the fresh-install path.
- Ask only for inputs that affect the result and are not known: target (`local` or trusted SSH alias), intended browser/profile, desired app name, workspace/project when ambiguous, and authorization. Technical paths, free ports and installation layout are selected by the implementation, not copied from examples.
- There is no account, proxy, CDP port, browser display name, cloud provider or username default. Use the owner's actual selection; a unique discovered endpoint alone does not prove it is their intended account.
- A machine still needs a supported OS, internet access, account eligibility, authorized permissions and a logged-in browser. “Independent installation” does not mean bypassing these prerequisites.

## Platform boundary

| Target | Shell | Persistence | Dependencies |
|---|---|---|---|
| macOS | `/bin/bash` | owned LaunchAgents, after GUI login | Python >=3.9; official Homebrew `openai/tools/tunnel-client` |
| Linux x86_64/arm64 with systemd | `/bin/bash` | owned user units; authorized linger | Python >=3.9 via apt/dnf when needed; pinned official client ZIP + SHA256 |
| Native Windows 10/11 x64/ARM64 | Windows PowerShell | owned Task Scheduler tasks, after the same user logs in | Python >=3.9 via per-user winget when needed; pinned official `.exe` ZIP + SHA256 |

Native Windows is a **new backend, not yet live end-to-end validated**. Do not claim production parity from mocked tests. WSL2, if explicitly selected, is a separate Linux target—not native Windows support. Linux without systemd, other CPU architectures, Windows without the required task permissions, sleeping/offline hosts and enterprise policies blocking debugging are reported prerequisites, not silently worked around.

Windows tasks use `InteractiveToken` / least privilege: no saved login password, SYSTEM account or UAC bypass. They do not promise operation after logout. POSIX tools retain the login user's existing sudo rights; Windows tools use the normal non-elevated login token. Persistent elevation/boot-before-login is outside this default workflow.

Controller: Node >=22, plus OpenSSH for remote targets. If Node is missing, the current AI installs a supported official Node release using the user's package manager or verified official installer, within authorized dependency setup. Do not assume Node in an old project's private directory. Target Python is prepared by the bundled `bootstrap.sh` / `bootstrap.ps1`; no pip/npm packages are required. Missing real administrator approval, login, MFA, CAPTCHA, payment, unknown SSH host keys or absent authorization must be reported, never bypassed.

## Choose the browser once

Use the owner-selected Chromium-family browser (Chrome/Edge/Chromium) with Platform and ChatGPT signed in. Do not infer the selection from a machine-specific launcher name. See [browser-connection.md](references/browser-connection.md).

1. If the owner/tool already supplies a verified CDP URL, use `--cdp <URL>`.
2. Otherwise identify the selected browser's **user-data directory** (from its launcher/configuration or `chrome://version`; this is the parent of `Default`/`Profile N`). Run `browser-discover --browser-user-data-dir <directory>`.
3. `browser-discover` without a profile inspects only standard browser metadata for this OS; it returns all live candidates, not a guessed port or first-match browser. Multiple candidates require explicit selection. Custom profiles use the directory option.
4. No endpoint? Report how to enable debugging in the selected browser. Do not scan arbitrary ports, dump process argv/environment, search unrelated histories, restart a running browser, duplicate its cookies or create a replacement profile. A new dedicated profile or restart needs explicit authorization; never evade Chrome's default-profile restrictions.

The selected endpoint is saved in the private state and reused across recovery. One Platform tab handles Tunnel→Key; one ChatGPT tab handles plugin→acceptance. Both are newly created run-owned tabs in the **same selected browser/profile**, with their window binding verified. Only a brand-new entry tab with a stalled animation clock may be replaced in one fresh window, once per run. This is not a new profile/browser or a restart. Existing forms, submitted objects and saved recovery tabs are never moved/reloaded for this fallback. Do not operate unrelated tabs. The POSIX relay shares one CDP connection across CLI invocations; Windows uses one direct connection for a whole run without adding an unsafe public relay.

## Run the complete workflow

First confirm target identity and inspect existing connections once, without changing them. Use a fresh slug/state directory when requested. Full-control installation requires `--allow-control`; Linux linger changes additionally require authorized `--enable-linger`. Trading, withdrawal, publishing and paid inference are not implicitly authorized.

macOS/Linux controller:

```bash
S="<skill-dir>/scripts/browser/host-connect.mjs"
node "$S" browser-discover --browser-user-data-dir "<selected-user-data-dir>"
node "$S" run --target local --host-name <slug> --state "<private-dir>/state.json" --cdp <verified-CDP-URL> --allow-control
```

Windows PowerShell controller (not Bash syntax):

```powershell
$S = Join-Path '<skill-dir>' 'scripts/browser/host-connect.mjs'
node $S browser-discover --browser-user-data-dir '<selected-user-data-dir>'
node $S run --target local --host-name <slug> --state '<private-dir>/state.json' --cdp <verified-CDP-URL> --allow-control
```

For SSH, change `--target local` to the configured alias. A native Windows SSH target also needs **`--target-os windows`** and the same account logged in for its tasks to run; do not infer target OS from controller OS. POSIX SSH uses `--target-os posix` (default). Strict known-host checking and the user's ProxyJump/ProxyCommand remain in force. No key value is sent in argv.

Exact object names: run `state set names.tunnel=... names.key=... names.plugin=...` with this same `--state` first. Existing names are inspected and verified, not bypassed by random suffix retries.

Default `--host-mode script` performs all six steps. Explicit `--host-mode agent` is only for a necessary adaptation by **this same AI**; exit 13 is not a user/second-AI handoff. Do not copy/repoint/restart an old service or enlarge its permissions to make the new connection work.

`tunnel → key → host-install → host-wait → plugin → test`

- Create/verify the selected Tunnel and workspace, then capture a Key privately: Restricted, Tunnels Read + Use only, 30 days.
- `run` records these prerequisites before installation. Do not invoke `host install` with an empty state. For an actual host-side repair after prerequisites exist: `host install --state <file> --allow-control`, then resume `run`.
- `installed:true, control_plane:PENDING` means installed but not yet ready. `host-wait` polls read-only for up to 90 seconds. Do not reinstall for a slow first poll.
- Create the ChatGPT custom MCP app with the actual name, correct Tunnel, No authentication and risk acknowledgment. Check Personal/个人 for duplicates. Click Create once, **stay on that same page** until Connect appears, click once, confirm the named app. Already connected goes directly to acceptance. Creation+connection share 90 seconds. Never use a generic Installed heading/another app's toast as evidence.
- Keep the original tab/action record on failure; recover submitted objects, never recreate merely because a timeout occurred. Only a lost tab permits a list lookup to recover the existing object.

## Page failure recovery, not machine-specific workarounds

- A stopped animation clock is `page_render_stalled`, detected with a two-second host-side deadline, not by waiting indefinitely for a page timer. Keep the page/state; do not rewrite opacity/CSS, disable animations or move/reload submitted forms to fake readiness. A frozen page, or a resource denial with required controls still unavailable after their bounded wait, returns `SAME_AI_RECOVERY` with scoped instructions. The AI inspects the bound page/window and repairs a diagnosed issue; it does not simply end the task.
- A blank entry page is `page_load_failed`, not “button missing.” The driver makes at most one delayed reload of an untouched blank entry page. A resource 401/403 does not immediately mean the whole page failed: observe the original tab within the existing control wait (normally 12 seconds). Proceed only if the required control becomes visible/enabled and no login/CAPTCHA blocker is present; retain the resource warning. Otherwise the script stops and hands diagnostics to the current AI. Reinspect the same page: if controls have since appeared, continue with the saved state. Otherwise diagnose the specific access/session/network issue; a subresource 403 alone is not proof that the user must log in again. Do not repeatedly refresh a denied page, extend a script phase's wait, bypass the denied resource, swap accounts/proxies, or submit again. A submitted form/chat is never reloaded automatically.
- Key setup waits for a visible, enabled project selector, verifies the selected project has taken effect, then waits for expiry to unlock. Missing/uncommitted project stops before setting permissions or submitting; no blanket click delays or blind re-selection. Project, expiry and restricted permissions are read back before submission.
- Key creation records the owned form/tab before opening it. On recovery, reuse that form, close its own open dropdown if needed and fill/read back; never click the background Create button through an overlay. An unowned dialog stops automation.
- Click only enabled, visible, unobscured controls; a disabled Create button is not submission. No blind double-click retry. State records submission before dispatch, so an uncertain result is recovered rather than duplicated.
- Failures are handled by the current AI using the saved `--tab-id`. No unscoped “last tab” or broad browser-wide clicks. Repeated selector failures require inspecting the actual DOM/control state and changing the approach, not asking the user to finish ordinary clicks. Preserve private credential capture; never screenshot a Key-bearing page during fallback.
- Prefer completion notifications/emitted steps to repeated fixed `sleep`+log-tail commands. POSIX pipelines need `set -o pipefail`; PowerShell callers check `$LASTEXITCODE`, not just the pipeline's last command.

## One acceptance task, direct approval, then stop

Send **one ChatGPT task, one `execute_terminal` call**. The generated command uses the target's shell/Python, checks `MCP_HOST_ID`, exclusively writes a random marker, reads it back and asserts equality. Token/hash and original task/tab are saved before sending.

On the original bound ChatGPT tab, identify the **single approval card for this selected app** and directly click **Allow once / 允许一次**. **Do not open View details or parse tool-argument JSON.** The owner authorized this one acceptance call. Localized cards may be forms and omit the raw tool name. Never approve another app, user-message lookalikes or ambiguous cards; never choose Always allow. At most one approval is dispatched per task, including recovery. Intent is saved only after the control is actionable, immediately before input; returned input is **not** approval success. The runner waits for a UI transition or independent host evidence. If the active Allow once control remains unchanged for five seconds, it reports `approval_not_confirmed` for the same AI to investigate instead of silently waiting the whole 90 seconds or clicking again. Check host evidence before any repair; preserve the one-call constraint and do not erase dispatch records to force another click. Hover-induced layout changes are rechecked before pressing; uncertain clicks are not blindly replayed. If an earlier attempt left a details overlay open, close that dialog once; do not reopen it.

The controller independently verifies the target marker and successful command SHA256 in the owned MCP log. Correct host identity, marker and command log must all match. Readiness/ChatGPT prose alone are insufficient. Do not wait for the model to format its answer.

Acceptance has a **90-second budget**. On timeout the AI diagnoses the existing task and host evidence; do not extend/reset the original budget or automatically send a second task. Recovery is not a fresh on-time acceptance: report any late completion as late. `--from-step test` rechecks existing evidence; `--retry-test` is only an explicitly necessary new attempt after diagnosis. Late evidence is reported as late, not an on-time pass.

`summary.complete:true` and `next_action:REPORT_AND_STOP` mean **report and finish**. No repeated health checks, version/plist/tool enumeration, rereading ChatGPT prose, plugin/API round trips or extra acceptance files. At most one read-only comparison with the pre-recorded old connections remains; do not repeat it. Reboot/logout is not part of this acceptance.

## Private state, networks and reporting

The public skill/CLI names are `chatgpt-host-connect` / `host-connect.mjs`. The default `~/.chatgpt-host-setup/` state location, internal ownership marker and installed service names intentionally remain unchanged for compatibility. Resume an existing direct-host installation with its original explicit `--state`; never create replacement objects just because the skill was renamed.

- State and installation directories are private: POSIX 0700/0600; native Windows DACL permits the current user, SYSTEM and Administrators, not other ordinary users. Do not use shared/FAT storage or symlink/reparse paths for secrets. Protect the directory **before** capturing a Key. No secret in screenshots, stdout, argv, source control, prompts or attachments.
- Default auto key capture is portable. Clipboard mode is explicit only (macOS pasteboard, Windows clipboard, Linux Wayland/X11 tools when present). Do not use clipboard setup as a mandatory prerequisite.
- Proxy discovery is **on the target**, from its own supported environment/system settings, or `--control-plane-proxy auto|direct|<HTTP(S)-URL>`. No embedded proxy credentials or hardcoded app/port. A controller's localhost proxy is not a remote target's proxy. MCP loopback always stays direct. Corporate PAC/authenticated proxies may require owner-provided configuration; do not disable TLS checks.
- Preserve selected proxy/client paths for this installation's recovery. `--client-bin` is an explicit override, not the default fresh-machine workaround.
- Source Key format is dedicated `CONTROL_PLANE_API_KEY=sk-...` or a bare key. Do not point at a mixed credential inventory. Old Muse state is rejected; keys and old connections are not removed automatically.
- Report usable/not usable first, actual host evidence, configuration and acceptance wall times, dependency installs/reuse, script failures and AI fallback actions. Do not describe an AI repair as unattended script success or a warm machine as pristine. Native Windows/live/pristine/reboot tests not performed are **NOT VERIFIED**.
- Step `elapsed_ms` is one attempt; `first_started_at` and `wall_elapsed_ms` retain recovery time, and acceptance follows the original request. `workflow_wall_ms` starts at the first real `run`, **not** the user's initial prompt; report earlier AI/browser preparation separately. Do not present a fast final retry/evidence reread as the whole setup or acceptance.

Troubleshooting and service locations: [host-bootstrap.md](references/host-bootstrap.md). Exit 10: failed step; 11: owner prerequisite; 12: duplicate refusal; 13: same AI adapts host deployment. No runtime secrets are needed to run the repository's offline tests.
