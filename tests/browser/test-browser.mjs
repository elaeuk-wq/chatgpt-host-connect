#!/usr/bin/env node
// Offline end-to-end test of muse-setup.mjs against local fixture pages, in a
// throwaway headless Chrome (temporary profile; never the user's browser).
//   node tests/browser/test-browser.mjs [work-dir]      CHROME=/path/to/chrome to override
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '../../skills/muse-chatgpt-setup/scripts/browser/muse-setup.mjs');
const WORK = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'muse-browser-test-'));
fs.mkdirSync(WORK, { recursive: true });
for (const d of ['A', 'B']) fs.rmSync(path.join(WORK, d), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const CHROME = process.env.CHROME || [
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('SKIP: no Chrome found (set CHROME=)'); process.exit(0); }

let pass = 0, fail = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 600) : '')); } };

const FX = await freePort();
const CDP = await freePort();
const fixture = spawn(process.execPath, [path.join(HERE, 'fixture-server.mjs'), String(FX)], { stdio: ['ignore', 'pipe', 'inherit'] });
const profile = fs.mkdtempSync(path.join(WORK, 'chrome-profile-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill(); } catch {}
  try { fixture.kill(); } catch {}
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 0);
};
process.on('exit', cleanup);

const FXURL = `http://127.0.0.1:${FX}`;
const api = async (p, body) => (await fetch(`${FXURL}/api/${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${CDP}/json/version`); await api('config'); break; } catch { await sleep(250); } }

let ALL_OUT = '';
function cli(stateFile, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--state', stateFile, '--cdp', `http://127.0.0.1:${CDP}`,
    '--platform-url', `${FXURL}/platform`, '--muse-url', `${FXURL}/muse`, '--chatgpt-url', `${FXURL}/chatgpt`, '--timeout-scale', '0.4'], { encoding: 'utf8', timeout: 240000 });
  ALL_OUT += r.stdout + r.stderr;
  const lines = r.stdout.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  return { code: r.status, lines, last: lines[lines.length - 1] || {}, stderr: r.stderr };
}
const state = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ------------------------------------------------------------ A: clean run
console.log('A. dry run, then full automatic run, then re-run');
await api('reset', { fail: [] });
const SA = path.join(WORK, 'A', 'state.json');
let r = cli(SA, 'run', '--dry-run');
check('dry run locates every entry element', r.code === 0 && r.last.ok === true, r.last);
let n = await api('counts');
check('dry run created/sent nothing', n.tunnels === 0 && n.keys === 0 && n.plugins === 0 && n.muse_messages === 0, n);

r = cli(SA, 'run');
check('full run exits 0 with ok:true', r.code === 0 && r.last.ok === true, r.last);
n = await api('counts');
const st = state(SA);
check('one tunnel, associated with the workspace', n.tunnels === 1 && n.tunnel_workspaces[0]?.includes('Acme Team'), n);
check('one key: Restricted, Tunnels Read + Use only, 30 days', n.keys === 1 && n.last_key.restricted && n.last_key.perms.Tunnels === 'Read + Use' && n.last_key.perms.Models === 'None' && n.last_key.perms.Assistants === 'None' && n.last_key.expiry === '30 days', n.last_key);
check('Muse got exactly one install message, key only as attachment', n.muse_installs === 1 && n.secrets_in_messages === 0 && n.attachments.some((a) => /^control-plane-key-.*\.txt$/.test(a)), n);
check('approved api.openai.com with "always allow this site"', JSON.stringify(n.muse_approvals) === '["always-site"]', n.muse_approvals);
check('foreign approval card left alone', n.foreign_clicked === false);
check('one plugin: selected tunnel, no auth, connected', n.plugins === 1 && n.plugin_state[0].auth === 'No authentication' && n.plugin_state[0].connected && n.plugin_state[0].tunnel_id === st.steps.tunnel.outputs.tunnel_id, n.plugin_state);
check('two tool calls with distinct utc', n.tool_calls === 2 && st.steps.test.outputs.utc1 !== st.steps.test.outputs.utc2, st.steps.test?.outputs);
check('two-sided log lines carry the tunnel id', st.steps.logs?.outputs?.forwarded_with_tunnel_id >= 1, st.steps.logs?.outputs);
check('local key file removed after install OK', !fs.existsSync(st.key_file));
check('state file is 0600 and holds no key', (fs.statSync(SA).mode & 0o777) === 0o600 && !/sk-proj-/.test(fs.readFileSync(SA, 'utf8')));

r = cli(SA, 'run');
const n2 = await api('counts');
check('re-run skips every step and creates nothing', r.code === 0 && r.lines.filter((l) => l.event === 'skip').length === 7 && n2.tunnels === 1 && n2.keys === 1 && n2.plugins === 1 && n2.muse_messages === n.muse_messages, { skips: r.lines.filter((l) => l.event === 'skip').length, n2 });

// ------------------------------------------------------------ B: failure + manual takeover + resume
console.log('B. key step fails -> agent finishes it by hand -> resume; plugin readback fails after submit -> resume');
await api('reset', { fail: ['key-expiry-label', 'plugin-list-hidden-once'] });
const SB = path.join(WORK, 'B', 'state.json');
r = cli(SB, 'run');
check('run stops at step "key" with exit 10', r.code === 10 && r.last.step === 'key', r.last);
check('failure says what was expected and what was seen', /expir/i.test(JSON.stringify(r.last.expected)) && JSON.stringify(r.last.found).includes('1 month'), r.last);
check('failure carries takeover do/verify/record/resume', r.last.takeover?.do?.length && r.last.takeover.verify?.length && /state done key|key-from/.test(r.last.takeover.record) && r.last.takeover.resume, r.last.takeover);
let sb = state(SB);
check('state: tunnel done, key failed (not submitted)', sb.steps.tunnel.status === 'done' && sb.steps.key.status === 'failed');

// the agent creates the key by hand and stores it without printing it
const made = await api('keys', { name: sb.names.key, restricted: true, perms: { Models: 'None', Assistants: 'None', Tunnels: 'Read + Use' }, expiry: '1 month', project: 'Default project' });
fs.mkdirSync(path.dirname(sb.key_file), { recursive: true });
fs.writeFileSync(sb.key_file, `CONTROL_PLANE_API_KEY=${made.key}\n`, { mode: 0o600 });
r = cli(SB, 'state', 'done', 'key', `key_name=${sb.names.key}`);
check('state done key accepted', r.code === 0 && r.last.ok, r.last);

r = cli(SB, 'run');
check('resume skips tunnel+key, stops at plugin (readback failed after submit)', r.code === 10 && r.last.step === 'plugin' && r.last.submitted === true && r.lines.some((l) => l.event === 'skip' && l.step === 'tunnel') && r.lines.some((l) => l.event === 'skip' && l.step === 'key'), r.last);
r = cli(SB, 'run');
check('second resume recovers the plugin and finishes', r.code === 0 && r.last.ok === true, r.last);
n = await api('counts');
check('no duplicates: 1 tunnel, 1 key, 1 plugin, 1 install message', n.tunnels === 1 && n.keys === 1 && n.plugins === 1 && n.muse_installs === 1, n);
r = cli(SB, 'run', '--from-step', 'tunnel');
n = await api('counts');
check('--from-step on a done creating step does not create again', r.code === 0 && n.tunnels === 1 && n.keys === 1 && n.plugins === 1, n);

// ------------------------------------------------------------ C: submitted but not found -> refuse
console.log('C. a submitted step whose object cannot be found is refused, not re-created');
sb = state(SB);
sb.steps.plugin = { status: 'submitted', attempts: 1 };
sb.names.plugin = 'Muse VM never-created';
fs.writeFileSync(SB, JSON.stringify(sb));
r = cli(SB, 'run', '--from-step', 'plugin');
n = await api('counts');
check('exit 12 refused, plugin count unchanged', r.code === 12 && r.last.refused === true && n.plugins === 1, { last: r.last, plugins: n.plugins });

check('no key value in any CLI output', !/sk-proj-[0-9a-f]{10}/.test(ALL_OUT));
console.log(`\nresult: ${pass} passed, ${fail} failed   (work dir ${WORK})`);
cleanup();
await sleep(500);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
