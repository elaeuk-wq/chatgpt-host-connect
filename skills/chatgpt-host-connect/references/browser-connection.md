# Portable browser connection

This skill does not require a browser launcher from the repository author's computer. The owner selects a browser/account; the AI resolves that selection to an existing Chromium user-data directory or a verified CDP endpoint. Chrome, Edge and Chromium expose the same core CDP used here. Firefox/Safari are not supported by this driver.

## Selection order

1. An endpoint supplied by the owner or their automation environment: confirm it is the intended browser, then use `--cdp <URL>`. Do not dump cookies, auth headers, process environment or full process command lines.
2. A selected custom profile: use `browser-discover --browser-user-data-dir <directory>`. It reads only that directory's `DevToolsActivePort`, checks the live `/json/version` endpoint and verifies the browser websocket ID matches. A stale file is not accepted.
3. No custom path known: `browser-discover` lists live metadata candidates under standard per-OS locations. It does **not** scan ports or pick the first candidate when several exist. Select the owner's actual browser, not merely one logged-in page.

Standard metadata roots derive from the current user's home/XDG/LocalAppData:

| OS | Examples (not fixed user paths) |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome`, `Microsoft Edge`, `Chromium` |
| Linux | `$XDG_CONFIG_HOME/google-chrome`, `microsoft-edge`, `chromium`; falls back to `~/.config` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data`, `Microsoft\Edge\User Data`, `Chromium\User Data` |

These are discovery candidates, **not authorization to use a different profile**. Arbitrary custom locations work through `--browser-user-data-dir`. Fixed-port launches may not write `DevToolsActivePort`; use their configured, verified `--cdp` URL instead. Container/remote browser endpoints must be supplied by the owner, not inferred from the host OS.

The user-data directory contains `Local State`; `Default` and `Profile 1` are subdirectories, not user-data roots. `chrome://version` / `edge://version` displays Profile Path. Multi-profile browsers can expose several accounts on one endpoint: ensure the intended workspace/account before creating objects, and stop if uncertain.

## If debugging is not enabled

Do not spend minutes searching unrelated directories or trying random ports. Explain the actual prerequisite:

- Where the browser offers `chrome://inspect/#remote-debugging`, the owner can enable it and approve the connection. Do not bypass its confirmation.
- Starting a browser with `--remote-debugging-port` requires permission to start/restart that **selected** browser. Use a loopback listener and an explicitly selected non-default user-data directory. Do not kill a running browser to seize its profile.
- Chrome 136+ does not honor debugging switches against the default Chrome data directory. Do not copy cookies into another profile or weaken browser security. A new dedicated profile requires authorization and login; it is not silently substituted for the selected browser.
- Enterprise policy, authentication, MFA and CAPTCHA remain real prerequisites. The automation does ordinary configuration clicks after access is established; it does not bypass authentication.

The script itself performs no browser launch/restart or profile creation. If a new profile is explicitly authorized, the current AI can use the installed browser's supported launcher with a chosen directory; afterward verify the endpoint and account before `run`. No repository-specific browser helper is required.

## Persistent binding

The private state saves the resolved endpoint and two run-owned target IDs. The two new site tabs stay **within that same browser/profile**, with the second tab's window verified against the first. If a brand-new entry tab's animation clock is stalled, the driver may replace only that unsubmitted tab in a fresh window, once per run. It does not always create new windows: that can itself stall some headless Chromium versions. This neither starts a browser nor creates a profile. On recovery, preserve the original bound tab; never move/reload a saved form/chat to work around a frozen window. Resume uses the saved endpoint unless an explicit conflicting choice is supplied (then it refuses). CLI recovery clicks require `--tab-id` from the failure, or one unique URL. Do not close another user's tabs. On Windows the complete `run` uses one direct CDP connection; on POSIX a private local relay shares the connection across fallback CLI calls. Browser-level Allow prompts are separate from ChatGPT's per-tool Allow once.

## Frozen windows and bounded diagnosis

A page can contain all expected text yet have every control hidden under an unfinished transition. `document.readyState=complete`, `visibilityState=visible` and a maximized window do not prove rendering is progressing. The driver foregrounds its owned page and checks two animation frames with a two-second **controller-side** deadline. A stalled promise cannot hang the driver indefinitely. CDP requests also have deadlines and are never automatically replayed after timeout.

`page_render_stalled` stops automatic interaction and preserves the target/state; the same AI takes over to diagnose the selected window's rendering/focus, not inspect dozens of unrelated selectors, rewrite CSS, disable transitions, restart Chrome or swap profiles. A resource 401/403 stops only if the required controls remain unavailable through their existing bounded wait; it is not by itself proof of an unusable page. These errors emit `next_action:SAME_AI_RECOVERY` with scoped diagnostics and recovery instructions. The AI must inspect the original page, resolve a safely repairable issue and resume—not immediately tell the user to finish setup. No recurring refresh/proxy exploration. Keep initial browser discovery short; use evidence-based diagnosis if it fails. Source audits and routine dry runs are not prerequisites for installation.

## Blank pages

A loaded HTML document with no rendered controls can still be broken. CSS/JavaScript resource denial (401/403), authentication expiry and network failures are different from a missing selector. The driver records only bounded Document/Script/Stylesheet failure metadata, not response bodies or credentials. It may reload an untouched blank entry page once after backoff; after a resource denial, observe the original tab without refresh within the existing wait (normally 12 seconds). Required visible/enabled controls may proceed, with a resource warning retained and login/CAPTCHA checks intact; otherwise the script yields to the same AI for diagnosis. If the original page has since become usable, resume its saved workflow without recreating objects. Do not bypass the denied resource or add retry loops. Existing forms, pending plugin submissions and acceptance chats must not be reloaded to clear a failure.

## References

- [Chrome remote-debugging security changes](https://developer.chrome.com/blog/remote-debugging-port)
- [Chromium user-data directory](https://chromium.googlesource.com/chromium/src/+/master/docs/user_data_dir.md)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
