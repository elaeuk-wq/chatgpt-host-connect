#!/usr/bin/env node
// muse-setup.mjs - drive a signed-in Chrome (over CDP) through the whole
// ChatGPT <-> Muse setup. Node >= 22, no dependencies.
//
//   node muse-setup.mjs run [--mode auto|manual] [--cdp auto|ws://...|http://host:port]
//   node muse-setup.mjs run --dry-run            # locate elements only, no clicks
//   node muse-setup.mjs run --from-step plugin   # resume after a manual fix
//   node muse-setup.mjs state show|done|set|reset ...
//   node muse-setup.mjs snapshot|click|fill|select|attach|grep ...   (fallback tools)
//   node muse-setup.mjs key-from-clipboard | key-from-page
//
// stdout: one JSON object per line; the last line is the result.
// Exit: 0 ok, 10 step failed (agent takes over), 11 user needed (login/captcha/
// payment), 12 refused (would duplicate an object), 1 usage error.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, StepError, sleep } from './cdp.mjs';
import { LABELS as L, SELECTORS as S, mergeLabels } from './labels.mjs';


const SELF = fileURLToPath(import.meta.url);
const CMD = `node ${SELF}`;
const KEY_RE = '^sk-[A-Za-z0-9_\\-]{20,}$';
const VERDICT_RE = 'control[- ]plane\\s*[:：]\\s*(OK|PENDING|KEY REJECTED|KEY FORBIDDEN|KEY MISSING|TUNNEL EXITED|MCP FAILED TO START)';

class NeedsUser extends Error { constructor(kind, info) { super(kind); this.kind = kind; this.info = info; } }
class Refuse extends Error { constructor(msg, info) { super(msg); this.info = info; } }

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const opts = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) opts[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
      else opts[k] = true;
    } else pos.push(a);
  }
  return { cmd: pos[0], pos: pos.slice(1), opts };
}
const { cmd, pos, opts } = parseArgs(process.argv.slice(2));
// Scripts the Muse VM downloads: pinned release tag (override --ref only to test an unreleased ref).
const RELEASE_REF = opts.ref || 'v1.0.0';
const RAW = `https://raw.githubusercontent.com/elaeuk-wq/muse-chatgpt-setup-skill/${RELEASE_REF}/skills/muse-chatgpt-setup/scripts`;
const HOME_DIR = path.join(os.homedir(), '.muse-chatgpt-setup');
const STATE_FILE = path.resolve(opts.state || path.join(HOME_DIR, 'state.json'));
const DATA_DIR = path.dirname(STATE_FILE);
const CDP = opts.cdp || process.env.MUSE_SETUP_CDP || 'auto';
// One shared Chrome connection per state dir + endpoint (see relay.mjs); the
// everyday Chrome then asks for Allow once instead of once per command.
const RELAY_SOCK = (() => {
  const tag = crypto.createHash('sha256').update(`${DATA_DIR}\0${CDP}`).digest('hex').slice(0, 10);
  const p = path.join(DATA_DIR, `cdp-${tag}.sock`);
  return p.length < 100 ? p : path.join(os.tmpdir(), `muse-setup-cdp-${tag}.sock`); // Unix socket path limit
})();
const browserConnect = () => {
  if (opts['no-relay']) return connect(CDP);
  ensureDir(DATA_DIR);
  return connect(CDP, { relay: RELAY_SOCK });
};
const URLS = {
  platform: (opts['platform-url'] || 'https://platform.openai.com').replace(/\/+$/, ''),
  muse: (opts['muse-url'] || 'https://muse.ai').replace(/\/+$/, ''),
  chatgpt: (opts['chatgpt-url'] || 'https://chatgpt.com').replace(/\/+$/, ''),
};
const TIMEOUT_SCALE = Number(opts['timeout-scale'] || 1);
const T = (ms) => Math.round(ms * TIMEOUT_SCALE);
const split = (s) => (s === undefined || s === true ? [] : String(s).split('|').map((x) => x.trim()).filter(Boolean));
if (opts.labels) mergeLabels(JSON.parse(fs.readFileSync(opts.labels, 'utf8')));

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const note = (m) => process.stderr.write(`[muse-setup] ${m}\n`);

// ---------------------------------------------------------------- state
function ensureDir(d) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch { /* ignore */ } }
function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const id = `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${crypto.randomBytes(2).toString('hex')}`;
  return {
    version: 1, run_id: id, created_at: d.toISOString(),
    names: { tunnel: `muse-chatgpt-${id}`, key: `muse-chatgpt-${id}`, plugin: `Muse VM ${id}` },
    key_file: path.join(DATA_DIR, 'keys', `control-plane-key-${id}.txt`),
    steps: {},
  };
}
function saveState(st) {
  ensureDir(path.dirname(STATE_FILE));
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}
const outputsOf = (st) => Object.assign({}, ...Object.values(st.steps).map((s) => (s.status === 'done' ? s.outputs || {} : {})));

// ---------------------------------------------------------------- key files
function writeKeyFile(file, key) {
  if (!new RegExp(KEY_RE).test(key)) throw new StepError('value does not look like an API key (sk-...)', { expected: 'an sk-... key' });
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `CONTROL_PLANE_API_KEY=${key}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}
function keyFileOk(file) {
  try {
    const stt = fs.statSync(file);
    if ((stt.mode & 0o077) !== 0) return false;
    return /^CONTROL_PLANE_API_KEY=sk-[A-Za-z0-9_-]{20,}\n?$/.test(fs.readFileSync(file, 'utf8'));
  } catch { return false; }
}
function shred(file) {
  try { const n = fs.statSync(file).size; fs.writeFileSync(file, Buffer.alloc(n)); fs.unlinkSync(file); return true; } catch { return false; }
}
const clip = {
  read() { return execFileSync('pbpaste', { encoding: 'utf8' }).trim(); },
  clear() { execFileSync('pbcopy', { input: '' }); },
  hash() { try { return crypto.createHash('sha256').update(clip.read()).digest('hex'); } catch { return ''; } },
};

// ---------------------------------------------------------------- messages
function museInstallMessage(o) {
  return [
    '请在这台机器上安装一条到 ChatGPT 的连接，全部装在 ~/muse-chatgpt，不要动其他服务。',
    '',
    `附件 ${path.basename(o.key_file)} 是 API Key 文件：不要打开、不要打印或复述它的内容。先找到它在这台机器上的路径，记为 KEY_PATH。`,
    '',
    '然后原样执行（不要改脚本，不要自己重写实现）：',
    '',
    'mkdir -p ~/muse-chatgpt && cd ~/muse-chatgpt',
    `curl -fsSL ${RAW}/install.sh -o install.sh`,
    `curl -fsSL ${RAW}/muse-mcp.py -o muse-mcp.py`,
    `TUNNEL_ID=${o.tunnel_id} KEY_FILE="$KEY_PATH" CONSUME_KEY_FILE=1 bash install.sh`,
    '',
    '如果弹出允许访问 api.openai.com 的审批，选长期允许。',
    '装完只回复脚本最后 report 段的原文（两条横线之间的内容），不要输出任何密钥。',
  ].join('\n');
}
const MUSE_RESTORE_MESSAGE = '审批已处理。请运行 bash ~/muse-chatgpt/restore.sh ，只回复 report 段原文。';
const MUSE_LOGS_MESSAGE = [
  '只回报事实，不要改任何配置。运行下面两条命令并原样贴出输出：',
  '',
  "{ grep -h 'dispatcher forwarded' ~/muse-chatgpt/logs/tunnel.log 2>/dev/null; journalctl -u muse-chatgpt-tunnel.service --since '-30 min' -o cat --no-pager 2>/dev/null | grep 'dispatcher forwarded'; } | tail -4",
  "{ grep -h 'tools/call' ~/muse-chatgpt/logs/mcp.log 2>/dev/null; journalctl -u muse-chatgpt-mcp.service --since '-30 min' -o cat --no-pager 2>/dev/null | grep 'tools/call'; } | tail -4",
].join('\n');
const testPrompt = (plugin, tok) =>
  `Use the "${plugin}" app. Call its tool muse_vm_exec with command status_echo and echo_token ${tok}. Reply with only the raw JSON text the tool returned, unchanged.`;

// ---------------------------------------------------------------- page helpers
async function checkBlockers(page, site) {
  const url = await page.url();
  if (/\/(log-?in|sign-?in|signup|auth)(\/|\?|#|$)|\/\/auth\.|auth0\./i.test(url)) throw new NeedsUser('login', { site, url: url.split('?')[0] });
  const cap = await page.eval(() => !![...document.querySelectorAll('iframe')].find((f) => /challenges\.cloudflare|hcaptcha|recaptcha|arkoselabs|turnstile/.test(f.src)));
  if (cap) throw new NeedsUser('captcha', { site, url: url.split('?')[0] });
}

// Find the entry element of a step; when missing, decide whether the user is needed.
async function entry(page, site, spec, what, timeout = T(12000)) {
  await checkBlockers(page, site);
  const hit = await page.waitFor(() => page.find(spec), { timeout });
  if (hit) return hit[0];
  await checkBlockers(page, site);
  const login = await page.find({ text: L.common.login, limit: 1 });
  if (login.length) throw new NeedsUser('login', { site, url: (await page.url()).split('?')[0], seen: login[0].text });
  const cap = await page.find({ text: L.common.captcha, css: 'h1,h2,h3,p,span,div,label', limit: 1 });
  if (cap.length) throw new NeedsUser('captcha', { site });
  throw new StepError(`not found: ${what}`, { expected: what, found: await page.snapshot({ text: spec.text }) });
}

async function payWall(page) {
  const hit = await page.find({ text: L.common.payment, scope: 'dialog', limit: 1 });
  if (hit.length) throw new NeedsUser('payment', { seen: hit[0].text });
}

async function composer(page, site) {
  const css = site === 'chatgpt' ? `${S.chatgptComposer},${S.composerGeneric}` : S.composerGeneric;
  const hits = await page.waitFor(() => page.find({ css, text: [], exclude: '[role=dialog]' }), { timeout: T(12000) });
  if (!hits) {
    await checkBlockers(page, site);
    const login = await page.find({ text: L.common.login, limit: 1 });
    if (login.length) throw new NeedsUser('login', { site });
    throw new StepError('message composer not found', { expected: 'a textarea / contenteditable composer', found: await page.snapshot({}) });
  }
  return hits.find((h) => h.tag !== 'input') || hits[0];
}

async function typeMessage(page, site, text) {
  const c = await composer(page, site);
  await page.click(c.id);
  await page.focus(c.id);
  await page.insertText(text);
  await sleep(300);
  const st = await page.state(c.id);
  const probe = text.slice(0, 24);
  const got = `${st?.value || ''} ${st?.text || ''}`;
  if (!got.replace(/\s+/g, ' ').includes(probe.replace(/\s+/g, ' ').slice(0, 20))) {
    throw new StepError('composer did not take the text', { expected: `composer starts with "${probe}"`, found: [st] });
  }
  return c;
}

async function sendMessage(page, site, sendLabels, composerEl) {
  const css = site === 'chatgpt' ? `${S.chatgptSend},button,[role=button]` : 'button,[role=button]';
  let btn = (await page.find({ css, text: sendLabels, exclude: '[role=dialog]' }))[0];
  if (!btn && site === 'chatgpt') btn = (await page.find({ css: S.chatgptSend, text: [] }))[0];
  if (btn && !btn.state?.disabled) await page.click(btn.id);
  else { await page.focus(composerEl.id); await page.press('Enter'); }
  const cleared = await page.waitFor(async () => {
    const st = await page.state(composerEl.id);
    if (!st) return true;
    return !String(['textarea', 'input'].includes(st.tag) ? st.value || '' : st.text || '').trim();
  }, { timeout: T(8000) });
  if (!cleared) throw new StepError('message was not sent (composer still holds the text)', { expected: 'composer empty after send', found: await page.snapshot({ text: sendLabels }) });
}

async function readKeyFromPage(page) {
  const v = await page.waitFor(() => page.readSecretInput(KEY_RE, 'dialog'), { timeout: T(20000) });
  if (!v) throw new StepError('the "Save your key" dialog did not show a key', { expected: 'a dialog with a read-only sk-... field', found: await page.snapshot({ scope: 'dialog' }) });
  return v;
}

// ---------------------------------------------------------------- steps
const STEPS = [
  {
    name: 'tunnel', creates: true, site: 'platform',
    required: { tunnel_id: /^tunnel_[A-Za-z0-9]+$/, tunnel_name: /./ },
    manual: (c) => ({
      do: [
        `Open ${URLS.platform}/settings/organization/tunnels`,
        `Only if no tunnel named "${c.names.tunnel}" exists: Create tunnel, name it "${c.names.tunnel}"`,
        'Associate it with the ChatGPT workspace (Create dialog workspace field, or Edit tunnel -> ChatGPT workspaces -> Save)',
      ],
      verify: ['the list shows the name with a tunnel_... id', 'the tunnel shows the intended ChatGPT workspace'],
      record: `${CMD} state done tunnel tunnel_id=<tunnel_...> tunnel_name="${c.names.tunnel}" workspace="<workspace name>"`,
    }),
    locate: async (c, page) => [await locate(page, 'platform', { text: L.platform.createTunnel }, 'Create tunnel button')],
    run: stepTunnel, recover: recoverTunnel,
  },
  {
    name: 'key', creates: true, site: 'platform',
    required: { key_file: (v) => keyFileOk(v), key_name: /./ },
    manual: (c) => ({
      do: [
        `Open ${URLS.platform}/settings/organization/api-keys`,
        `Only if no key named "${c.names.key}" exists: Create new secret key -> Name "${c.names.key}" -> Permissions Restricted -> Tunnels: Read + Use, everything else None -> Expiration 30 days -> Create`,
        `While the "Save your key" dialog is open run: ${CMD} key-from-page   (or click Copy and run: ${CMD} key-from-clipboard)`,
      ],
      verify: ['key list row shows the name and Restricted', 'Tunnels is the only resource with access', 'expiry is 30 days'],
      record: 'key-from-page / key-from-clipboard record this step themselves; never paste the key anywhere',
    }),
    locate: async (c, page) => [await locate(page, 'platform', { text: L.platform.createKey }, 'Create new secret key button')],
    run: stepKey, recover: recoverKey,
  },
  {
    name: 'muse-install', creates: false, site: 'muse',
    required: { muse_chat_url: /^https?:\/\// },
    manual: (c) => ({
      do: [
        `Open ${URLS.muse} in a new chat`,
        `Attach the key file ${c.state.key_file} (never paste its content)`,
        `Paste the message in ${path.join(DATA_DIR, 'muse-install-message.txt')} and send it`,
      ],
      verify: ['the sent message and the attachment chip are visible in the chat'],
      record: `${CMD} state done muse-install muse_chat_url=<url of that chat>`,
    }),
    locate: async (c, page) => locateComposer(page, 'muse', true),
    run: stepMuseInstall, recover: recoverMuseInstall,
  },
  {
    name: 'muse-wait', creates: false, site: 'muse',
    required: { control_plane: /^OK$/ },
    manual: (c) => ({
      do: [
        `Open the Muse chat ${c.out.muse_chat_url || ''}`,
        'Approve only the card for api.openai.com with the long-lived option (More allow options -> Always allow this site); leave other cards to the user',
        'If the report says PENDING after approving, ask Muse to run: bash ~/muse-chatgpt/restore.sh',
      ],
      verify: ['the latest Muse reply contains the report line "control-plane  : OK"'],
      record: `${CMD} state done muse-wait control_plane=OK`,
    }),
    run: stepMuseWait,
  },
  {
    name: 'plugin', creates: true, site: 'chatgpt',
    required: { plugin_name: /./ },
    manual: (c) => ({
      do: [
        `Open ${URLS.chatgpt}/plugins -> Add -> Add custom MCP server`,
        `Only if no plugin named "${c.names.plugin}" exists: Name "${c.names.plugin}", Connection Tunnel -> chip "${c.out.tunnel_name}", Authentication: No authentication, tick "I understand", Create`,
        `On the consent screen click "Connect ${c.names.plugin}"`,
      ],
      verify: [`the selected tunnel chip is "${c.out.tunnel_name}" and the id field shows ${c.out.tunnel_id}`, 'the plugin is listed as installed AND connected'],
      record: `${CMD} state done plugin plugin_name="${c.names.plugin}"`,
    }),
    locate: async (c, page) => [await locate(page, 'chatgpt', { text: L.chatgpt.add }, 'plugins Add button')],
    run: stepPlugin, recover: recoverPlugin,
  },
  {
    name: 'test', creates: false, site: 'chatgpt',
    required: { token1: /./, token2: /./, utc1: /./, utc2: /./ },
    manual: (c) => ({
      do: [
        `New chat at ${URLS.chatgpt}; enable the "${c.out.plugin_name}" plugin in the composer if needed`,
        'Ask it to call muse_vm_exec (command status_echo) with a fresh random echo_token and to paste the raw JSON; approve only this plugin\'s tool card',
        'Repeat once with a different token',
      ],
      verify: ['each reply echoes its token verbatim', 'the two utc values differ'],
      record: `${CMD} state done test token1=<t1> utc1=<u1> token2=<t2> utc2=<u2> hostname=<h>`,
    }),
    locate: async (c, page) => locateComposer(page, 'chatgpt', false),
    run: stepTest,
  },
  {
    name: 'logs', creates: false, site: 'muse',
    required: { forwarded: /./ },
    manual: (c) => ({
      do: [`In the Muse chat ${c.out.muse_chat_url || ''}, send the message printed by: ${CMD} message logs`],
      verify: [`a "dispatcher forwarded command to MCP server" line for tunnel ${c.out.tunnel_id}`, 'an MCP "tools/call" line at about the same time'],
      record: `${CMD} state done logs forwarded=yes`,
    }),
    run: stepLogs,
  },
];
const STEP_NAMES = STEPS.map((s) => s.name);

async function locate(page, site, spec, what) {
  await checkBlockers(page, site);
  const hit = await page.waitFor(() => page.find(spec), { timeout: T(8000) });
  if (!hit) {
    const login = await page.find({ text: L.common.login, limit: 1 });
    return { what, found: false, hint: login.length ? 'login button visible - sign in first' : undefined };
  }
  return { what, found: true, text: hit[0].text };
}
async function locateComposer(page, site, withAttach) {
  const res = [];
  try { const c = await composer(page, site); res.push({ what: 'composer', found: true, tag: c.tag }); } catch (e) {
    res.push({ what: 'composer', found: false, hint: e instanceof NeedsUser ? `needs ${e.kind}` : undefined });
  }
  if (withAttach) {
    const input = await page.find({ css: 'input[type=file]', text: [], hidden: true });
    const btn = await page.find({ text: L.muse.attach });
    res.push({ what: 'attachment (file input or attach button)', found: !!(input.length || btn.length), detail: input.length ? 'file input' : btn[0]?.text });
  }
  return res;
}

// ---------------------------------------------------------------- tunnel
async function tunnelRow(page, name) {
  return page.eval((a) => {
    const all = [...document.querySelectorAll('tr,[role=row],li,a,div')].filter((e) => (e.innerText || '').includes(a.name) && (e.innerText || '').length < 600);
    all.sort((x, y) => (x.innerText.length - y.innerText.length));
    for (const row of all) {
      const m = /tunnel_[A-Za-z0-9]{6,}/.exec(row.innerText);
      if (m) return { id: m[0], text: row.innerText.replace(/\s+/g, ' ').slice(0, 300) };
    }
    return all.length ? { id: null, text: all[0].innerText.replace(/\s+/g, ' ').slice(0, 300) } : null;
  }, { name });
}

// Platform: the field is a button showing a placeholder; it opens a popover
// (a second [role=dialog]) with a search combobox and multi-select options.
// `closeOn` is an element of the main dialog; clicking it closes the popover
// (Escape is not reliable there).
async function pickWorkspace(page, c, closeOn) {
  const want = c.opts.workspace ? [c.opts.workspace] : null;
  const trigger = (await page.find({ scope: 'dialog', text: L.platform.workspaceField, css: '[role=button],button,[role=combobox]', limit: 1 }))[0];
  if (!trigger) return null;
  await page.click(trigger.id, { settle: 500 });
  if (want) {
    const box = (await page.find({ css: 'input[role=combobox]', limit: 1 }))[0];
    if (box) { await page.focus(box.id); await page.insertText(want[0]); await sleep(500); }
  }
  const opts = await page.waitFor(() => page.find({ css: '[role=option]', text: want || [], limit: 20 }), { timeout: T(5000) });
  if (!opts) throw new StepError('no ChatGPT workspace offered', { expected: want ? `workspace "${want[0]}" in the list` : 'at least one workspace option', found: await page.snapshot({ scope: 'dialog' }) });
  if (!want && opts.length > 1) {
    throw new StepError('several ChatGPT workspaces - choose one', { expected: 'rerun with --workspace "<name or id>"', found: opts.map((o) => o.text) });
  }
  const pick = opts[0];
  if (pick.state?.['aria-selected'] !== 'true') await page.click(pick.id, { settle: 400 });
  const selected = await page.find({ css: '[role=option][aria-selected=true]', limit: 20 });
  if (!selected.some((o) => o.text === pick.text)) {
    throw new StepError('workspace option did not get selected', { expected: `option "${pick.text}" aria-selected=true`, found: await page.snapshot({ scope: 'dialog' }) });
  }
  if (closeOn) await page.click(closeOn, { settle: 500 }); else await page.press('Escape');
  const shown = await page.waitFor(() => page.grep({ scope: 'dialog', re: pick.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }), { timeout: T(3000) });
  if (!shown) throw new StepError('workspace not shown in the dialog after picking', { expected: `the workspaces field shows "${pick.text}"`, found: await page.snapshot({ scope: 'dialog' }) });
  return pick.text;
}

async function submitEnabled(page, labels, what) {
  const btn = (await page.find({ scope: 'dialog', text: labels, css: 'button,[role=button],input[type=submit]', limit: 1 }))[0];
  if (!btn || btn.state?.disabled || btn.state?.['aria-disabled'] === 'true') {
    throw new StepError(`${what} is disabled - a required field is empty or invalid`, { expected: `${what} enabled`, found: await page.snapshot({ scope: 'dialog' }) });
  }
}

async function ensureWorkspace(page, c, name, workspace) {
  // Is the workspace visible on the row already?
  const row = await tunnelRow(page, name);
  if (workspace && row?.text?.includes(workspace)) return workspace;
  // Open the tunnel (row click) and its edit dialog.
  const rowEl = (await page.find({ text: [name], css: 'tr,[role=row],a,li,button,div', limit: 1 }))[0];
  if (rowEl) await page.click(rowEl.id, { settle: 800 });
  const edit = (await page.find({ text: L.common.edit, limit: 1 }))[0];
  if (edit) await page.click(edit.id, { settle: 600 });
  const dlgText = await page.grep({ scope: 'dialog', re: workspace ? workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : 'workspace|工作区' });
  if (workspace && dlgText.length) { await page.press('Escape'); return workspace; }
  const picked = await pickWorkspace(page, c);
  if (!picked) throw new StepError('no ChatGPT workspace control found on the tunnel', { expected: 'Edit tunnel -> ChatGPT workspaces field', found: await page.snapshot({ scope: 'dialog' }) });
  await page.click({ scope: 'dialog', text: L.common.save }, { what: 'Save' });
  return picked;
}

async function stepTunnel(c) {
  const page = await c.open('platform', '/settings/organization/tunnels');
  const name = c.names.tunnel;
  await entry(page, 'platform', { text: L.platform.createTunnel }, 'Create tunnel button');
  if (await tunnelRow(page, name)) throw new Refuse(`a tunnel named ${name} already exists but is not in the state file`, { record: STEPS[0].manual(c).record });
  await page.click({ text: L.platform.createTunnel }, { what: 'Create tunnel', settle: 600 });
  await payWall(page);
  const nameField = await page.fill({ scope: 'dialog', label: L.platform.tunnelName }, name, { what: 'tunnel name' });
  let workspace = await pickWorkspace(page, c, nameField?.id);
  const desc = (await page.field({ scope: 'dialog', label: L.platform.tunnelDescription }))[0];
  if (desc) await page.fill({ scope: 'dialog', label: L.platform.tunnelDescription }, 'ChatGPT to Muse VM link (muse-chatgpt-setup)', { what: 'tunnel description' });
  await submitEnabled(page, L.platform.createSubmit, 'Create (tunnel dialog)');
  // ids already on the page: the new tunnel's id must not be one of them
  const before = new Set((await page.grep({ re: 'tunnel_[A-Za-z0-9]{6,}', hidden: true })).flatMap((l) => l.match(/tunnel_[A-Za-z0-9]{6,}/g) || []));
  c.submitted();
  await page.click({ scope: 'dialog', text: L.platform.createSubmit, css: 'button,[role=button],input[type=submit]' }, { what: 'Create (tunnel dialog)', settle: 1000 });
  const row = await page.waitFor(async () => {
    const inDialog = await page.grep({ scope: 'dialog', re: 'tunnel_[A-Za-z0-9]{6,}' });
    const m = inDialog.length && /tunnel_[A-Za-z0-9]{6,}/.exec(inDialog[0]);
    if (m && !before.has(m[0])) return { id: m[0] };
    const r = await tunnelRow(page, name);
    return r?.id && !before.has(r.id) ? r : null;
  }, { timeout: T(15000) });
  let found = row;
  if (!found) { // the list may not refresh by itself
    await page.goto(URLS.platform + '/settings/organization/tunnels');
    found = await page.waitFor(async () => { const r = await tunnelRow(page, name); return r?.id && !before.has(r.id) ? r : null; }, { timeout: T(10000) });
  }
  if (!found) throw new StepError('tunnel id not found after Create', { expected: `a new tunnel_... id next to "${name}"`, found: await page.snapshot({ text: [name] }) });
  await page.press('Escape');
  workspace = await ensureWorkspace(page, c, name, workspace);
  return { tunnel_id: found.id, tunnel_name: name, workspace };
}

async function recoverTunnel(c) {
  const page = await c.open('platform', '/settings/organization/tunnels');
  await entry(page, 'platform', { text: L.platform.createTunnel }, 'tunnel list');
  const row = await page.waitFor(() => tunnelRow(page, c.names.tunnel), { timeout: T(6000) });
  if (!row?.id) return null;
  const workspace = await ensureWorkspace(page, c, c.names.tunnel, c.opts.workspace || null);
  return { tunnel_id: row.id, tunnel_name: c.names.tunnel, workspace };
}

// ---------------------------------------------------------------- key
async function keyRow(page, name) {
  return page.eval((a) => {
    const rows = [...document.querySelectorAll('tr,[role=row],li')].filter((e) => (e.innerText || '').includes(a.name));
    return rows.length ? rows[0].innerText.replace(/\s+/g, ' ').replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-[redacted]').slice(0, 300) : null;
  }, { name });
}

// Platform key dialog (2026-10): every field is a label (or a disabled label
// button) next to a [role=button][aria-expanded] trigger; the trigger opens a
// portaled list of [role=option]. Project and expiry are single-select (the
// list closes on pick, expiry stays disabled until a project is set); the
// per-resource permissions are multi-select (Tunnels: Read, Use - picking Use
// also ticks Read, the trigger then says "All selected").
const TRIGGER = '[role=button][aria-expanded],[role=combobox],button[aria-haspopup]';
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function rowTrigger(page, labels) {
  return page.eval((a) => {
    const d = [...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].find((e) => e.getClientRects().length) || document.body;
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (const lab of d.querySelectorAll('label,button,span,div,p')) {
      if (!a.names.includes(n(lab.innerText))) continue;
      const own = lab.closest(a.trig);
      if (own && own !== lab) return window.__mcs.tag(own);
      if (lab.matches(a.trig)) continue;
      let row = lab;
      for (let i = 0; i < 4 && row.parentElement; i++) {
        row = row.parentElement;
        const t = row.querySelector(a.trig);
        if (t) return window.__mcs.tag(t);
      }
    }
    return null;
  }, { names: labels.map((s) => s.toLowerCase()), trig: TRIGGER });
}

// Open `triggerId` and make sure one option per entry of `wants` (each a list
// of label alternatives) is selected. wants = null: take the only option, else
// one of `preferred`. Returns the chosen option texts.
async function pickOptions(page, triggerId, wants, { what, preferred = [], keepOpen = false } = {}) {
  await page.click(triggerId, { settle: 500 });
  let opts = await page.waitFor(() => page.find({ css: '[role=option]', text: [], limit: 40 }), { timeout: T(5000) });
  if (!opts) throw new StepError(`${what}: no options offered`, { expected: `a list of ${what} options`, found: await page.snapshot({ scope: 'dialog' }) });
  if (!wants) {
    const pref = opts.find((o) => preferred.map(norm).includes(norm(o.text)));
    if (opts.length > 1 && !pref) throw new StepError(`several ${what} options - choose one`, { expected: `rerun with --${what} "<name>"`, found: opts.map((o) => o.text) });
    wants = [[(pref || opts[0]).text]];
  }
  const chosen = [];
  for (const alts of wants) {
    const o = opts.find((x) => alts.map(norm).includes(norm(x.text)));
    if (!o) throw new StepError(`${what}: option not offered`, { expected: alts.join(' | '), found: opts.map((x) => x.text) });
    if (o.state?.['aria-selected'] !== 'true') await page.click(o.id, { settle: 400 });
    chosen.push(o.text);
    opts = (await page.find({ css: '[role=option]', text: [], limit: 40 })) || [];
    if (!opts.length) break; // single-select list closed itself
  }
  if (opts.length) {
    const sel = opts.filter((x) => x.state?.['aria-selected'] === 'true').map((x) => norm(x.text));
    const missing = chosen.filter((t) => !sel.includes(norm(t)));
    if (missing.length) throw new StepError(`${what}: option did not get selected`, { expected: chosen.join(' + '), found: opts.map((x) => `${x.text}=${x.state?.['aria-selected']}`) });
    if (!keepOpen) await page.click(triggerId, { settle: 400 }); // toggles the list closed
  }
  return chosen;
}

async function triggerText(page, labels) {
  const id = await rowTrigger(page, labels);
  return id ? norm((await page.state(id))?.text) : null;
}

async function fillKeyForm(page, c, name) {
  await page.fill({ scope: 'dialog', label: L.platform.keyName }, name, { what: 'key name' });
  const proj = await rowTrigger(page, L.platform.project);
  let project = null;
  if (proj) {
    const shown = norm((await page.state(proj))?.text);
    if (c.opts.project || !shown || /select|choose|选择/.test(shown)) {
      [project] = await pickOptions(page, proj, c.opts.project ? [[c.opts.project]] : null, { what: 'project', preferred: L.platform.defaultProject });
    } else project = shown;
  }
  const restricted = await page.findOne({ scope: 'dialog', text: L.platform.restricted, css: '[role=radio],button,label' }, { what: 'Permissions: Restricted' });
  await page.click(restricted.id, { settle: 600 });
  const tun = await rowTrigger(page, L.platform.tunnelsRow);
  if (!tun) throw new StepError('"Tunnels" permission row not found', { expected: 'a Tunnels row under Restricted permissions', found: await page.snapshot({ scope: 'dialog' }) });
  await pickOptions(page, tun, [L.platform.tunnelsUse, L.platform.tunnelsRead], { what: 'Tunnels permission' });
  const exp = await page.waitFor(async () => { const id = await rowTrigger(page, L.platform.expiry); return id && (await page.state(id))?.state?.['aria-disabled'] !== 'true' ? id : null; }, { timeout: T(5000) });
  if (!exp) throw new StepError('expiration field not available', { expected: 'an enabled expiration field (it unlocks after a project is chosen)', found: await page.snapshot({ scope: 'dialog' }) });
  await pickOptions(page, exp, [L.platform.expiry30], { what: 'expiration' });
  return project;
}

// Readback: Restricted on; Tunnels shows Read + Use; every other resource None;
// expiry 30 days; the footer counts exactly the two Tunnels permissions.
async function verifyKeyForm(page) {
  const problems = [];
  const r = (await page.find({ scope: 'dialog', text: L.platform.restricted, css: '[role=radio],button', limit: 1 }))[0];
  if (r?.state?.['aria-checked'] !== 'true' && r?.state?.['data-state'] !== 'on') problems.push('Permissions is not Restricted');
  const tun = await triggerText(page, L.platform.tunnelsRow);
  const allSel = L.platform.allSelected.map(norm);
  if (!(allSel.includes(tun) || (/read|读取/.test(tun) && /use|使用/.test(tun)))) problems.push(`Tunnels shows "${tun}", not Read + Use`);
  const others = await page.eval((a) => {
    const d = [...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].find((e) => e.getClientRects().length) || document.body;
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const out = [];
    for (const t of d.querySelectorAll(a.trig)) {
      let row = t; let label = '';
      for (let i = 0; i < 4 && row.parentElement && !label; i++) { row = row.parentElement; label = n([...row.querySelectorAll('button,label,span')].find((e) => e !== t && !t.contains(e) && n(e.innerText))?.innerText); }
      out.push({ label, value: n(t.innerText) });
    }
    return out;
  }, { trig: TRIGGER });
  const skip = [...L.platform.tunnelsRow, ...L.platform.project, ...L.platform.expiry].map(norm);
  const open = others.filter((o) => !skip.some((s) => o.label === s || o.label.startsWith(s)) && !L.platform.noneValue.map(norm).includes(o.value) && !/select|选择/.test(o.value));
  if (open.length) problems.push('other resources have access: ' + open.map((o) => `${o.label}=${o.value}`).join(' | '));
  const exp = await triggerText(page, L.platform.expiry);
  if (!/30/.test(exp || '')) problems.push(`expiry shows "${exp}", not 30 days`);
  const count = (await page.grep({ scope: 'dialog', re: '(\\d+)\\s*(selected permissions?|个已选权限|项已选权限)' }))[0];
  if (count && !/\b2\b/.test(count)) problems.push(`footer says "${count}" (expected 2: Tunnels Read + Use)`);
  return { problems, seen: { tunnels: tun, expiry: exp, footer: count || null } };
}

async function stepKey(c) {
  const page = await c.open('platform', '/settings/organization/api-keys');
  const name = c.names.key;
  await entry(page, 'platform', { text: L.platform.createKey }, 'Create new secret key button');
  if (await keyRow(page, name)) throw new Refuse(`a key named ${name} already exists but is not recorded`, { record: STEPS[1].manual(c).record });
  await page.click({ text: L.platform.createKey }, { what: 'Create new secret key', settle: 700 });
  await payWall(page);
  const projectShown = await fillKeyForm(page, c, name);
  const v = await verifyKeyForm(page);
  if (v.problems.length) throw new StepError('key form readback does not match', { expected: 'Restricted; Tunnels Read + Use only; 30 days', problems: v.problems, found: v.seen });
  await submitEnabled(page, L.platform.createKeySubmit, 'Create secret key');

  let fp;
  if (c.opts.mode === 'manual') {
    const before = clip.hash();
    c.submitted('awaiting_user');
    emit({ event: 'waiting_for_user', step: 'key', message: 'In the Platform tab click "Create secret key", then "Copy". The key is taken from the clipboard and the clipboard is cleared.' });
    note('waiting for you: click Create secret key, then Copy');
    const key = await (async () => {
      const end = Date.now() + T(Number(c.opts['manual-timeout'] || 300) * 1000);
      while (Date.now() < end) {
        if (clip.hash() !== before) { const v2 = clip.read(); if (new RegExp(KEY_RE).test(v2)) return v2; }
        await sleep(1000);
      }
      return null;
    })();
    if (!key) throw new StepError('no key arrived on the clipboard', { expected: 'user clicks Create secret key and Copy' });
    fp = writeKeyFile(c.state.key_file, key);
    clip.clear();
  } else {
    c.submitted();
    await page.click({ scope: 'dialog', text: L.platform.createKeySubmit, css: 'button,[role=button],input[type=submit]' }, { what: 'Create secret key (submit)', settle: 1200 });
    const key = await readKeyFromPage(page);
    fp = writeKeyFile(c.state.key_file, key);
    const done = (await page.find({ scope: 'dialog', text: L.common.done }))[0];
    if (done) await page.click(done.id);
  }
  const row = await page.waitFor(() => keyRow(page, name), { timeout: T(10000) });
  if (!row) throw new StepError('new key not visible in the key list', { expected: `a row named ${name}`, found: await page.snapshot({ text: [name] }) });
  return { key_name: name, key_file: c.state.key_file, key_fp: fp, key_row: row, project: projectShown || null, expiry: '30 days' };
}

async function recoverKey(c) {
  if (keyFileOk(c.state.key_file)) return { key_name: c.names.key, key_file: c.state.key_file, recovered: true };
  const page = await c.open('platform', '/settings/organization/api-keys');
  await entry(page, 'platform', { text: L.platform.createKey }, 'key list');
  const row = await keyRow(page, c.names.key);
  if (row) {
    throw new Refuse(`key "${c.names.key}" exists but its value was not captured`, {
      do: [
        'If its "Save your key" dialog is still open: run key-from-page',
        `Otherwise revoke "${c.names.key}" in the page, then: ${CMD} state reset key --rename  (creates a key with a new name next run)`,
      ],
    });
  }
  return null;
}

// ---------------------------------------------------------------- muse
async function stepMuseInstall(c) {
  if (!keyFileOk(c.state.key_file)) throw new StepError('key file missing or not 0600', { expected: c.state.key_file });
  const page = await c.open('muse', '/');
  await checkBlockers(page, 'muse');
  const nc = (await page.find({ text: L.muse.newChat, limit: 1 }))[0];
  if (nc) await page.click(nc.id, { settle: 800 });
  const comp = await composer(page, 'muse');
  await page.setFiles([c.state.key_file], { buttonSpec: { text: L.muse.attach, exclude: '[role=dialog]' }, what: 'attach button' });
  const base = path.basename(c.state.key_file);
  const chip = await page.waitFor(() => page.grep({ re: base.replace(/[.]/g, '\\.'), exclude: 'textarea,script,style' }), { timeout: T(15000) });
  if (!chip) throw new StepError('attachment did not appear', { expected: `a chip named ${base}`, found: await page.snapshot({ text: [base] }) });
  const msg = museInstallMessage({ key_file: c.state.key_file, tunnel_id: c.out.tunnel_id });
  fs.writeFileSync(path.join(DATA_DIR, 'muse-install-message.txt'), msg + '\n', { mode: 0o600 });
  await typeMessage(page, 'muse', msg);
  c.submitted();
  await sendMessage(page, 'muse', L.muse.send, comp);
  const sent = await page.waitFor(() => page.grep({ re: c.out.tunnel_id }), { timeout: T(8000) });
  if (!sent) throw new StepError('sent message not visible', { expected: `a message containing ${c.out.tunnel_id}` });
  await sleep(1500);
  return { muse_chat_url: (await page.url()).split('#')[0], sent_at: new Date().toISOString() };
}

async function recoverMuseInstall(c) {
  // The install message was sent before; find the chat that holds it instead of sending again.
  for (const t of await c.browser.pages()) {
    if (!t.url.startsWith(URLS.muse)) continue;
    const page = await c.browser.attach(t.targetId);
    if ((await page.grep({ re: c.out.tunnel_id })).length) return { muse_chat_url: t.url.split('#')[0], recovered: true };
  }
  return null;
}

// Approve only cards that belong to this flow; report the rest.
async function pumpMuse(page, ctx) {
  for (const spec of [L.muse.reviewBadge, L.muse.reviewButton]) {
    const b = (await page.find({ text: spec, limit: 1, exclude: '[data-mcs-done]' }))[0];
    if (b && !ctx.opened.has(b.id)) { ctx.opened.add(b.id); await page.click(b.id, { settle: 700 }); }
  }
  const cards = await page.cards({ text: L.muse.allowAny, css: 'button,[role=button]' });
  for (const card of cards) {
    const ours = /api\.openai\.com/i.test(card.text);
    if (!ours) {
      if (!ctx.foreign.has(card.text)) { ctx.foreign.add(card.text); emit({ event: 'foreign_approval_left_for_user', text: card.text }); }
      continue;
    }
    const caret = (await page.find({ within: card.card, text: L.muse.moreAllow }))[0];
    let how = null;
    if (caret) {
      await page.click(caret.id, { settle: 400 });
      const item = (await page.find({ text: L.muse.alwaysAllowSite, css: '[role=menuitem],[role=option],button,li,[role=menuitemradio]' }))[0];
      if (item) { await page.click(item.id); how = item.text; }
    }
    if (!how) {
      const always = (await page.find({ within: card.card, text: L.muse.alwaysAllow }))[0];
      if (always) { await page.click(always.id); how = always.text; }
    }
    if (!how) {
      const once = (await page.find({ within: card.card, text: L.muse.allowOnce }))[0] || card.button;
      await page.click(once.id); how = `${once.text} (one-shot: polling may stall again)`;
    }
    ctx.approved.push(how);
    emit({ event: 'approved', site: 'muse', target: 'api.openai.com', how });
    await sleep(800);
  }
}

async function museTab(c) {
  const url = c.out.muse_chat_url;
  const page = await c.browser.pageFor(url, url);
  await checkBlockers(page, 'muse');
  return page;
}

async function stepMuseWait(c) {
  const page = await museTab(c);
  const ctx = { opened: new Set(), foreign: new Set(), approved: [] };
  const end = Date.now() + T(Number(c.opts['install-timeout'] || 600) * 1000);
  let followed = false;
  let pendingSeenAt = 0;
  let baseline = 0;
  while (Date.now() < end) {
    await pumpMuse(page, ctx);
    const lines = (await page.grep({ re: VERDICT_RE })).slice(baseline);
    const last = lines.length ? new RegExp(VERDICT_RE, 'i').exec(lines[lines.length - 1])[1].toUpperCase() : null;
    if (last === 'OK') {
      const deleted = c.opts['keep-key'] ? false : shred(c.state.key_file);
      return { control_plane: 'OK', approvals: ctx.approved, local_key_file_deleted: deleted };
    }
    if (last && last !== 'PENDING') {
      throw new StepError(`install reported ${last}`, {
        expected: 'control-plane OK',
        found: lines.slice(-3),
        hint: last.startsWith('KEY') ? 'create a new key (state reset key --rename), then send Muse: KEY_FILE=<attached file> CONSUME_KEY_FILE=1 bash ~/muse-chatgpt/restore.sh' : 'ask Muse for the last 20 lines of ~/muse-chatgpt/logs/tunnel.log (journalctl -u muse-chatgpt-tunnel when systemd)',
      });
    }
    if (last === 'PENDING') {
      if (!pendingSeenAt) pendingSeenAt = Date.now();
      // give the approval a moment, then ask once for a restore run
      if (!followed && Date.now() - pendingSeenAt > T(5000)) {
        const comp = await typeMessage(page, 'muse', MUSE_RESTORE_MESSAGE);
        await sendMessage(page, 'muse', L.muse.send, comp);
        followed = true;
        baseline = (await page.grep({ re: VERDICT_RE })).length;
        pendingSeenAt = 0;
      }
    }
    await sleep(T(2500));
  }
  throw new StepError('timed out waiting for the install report', {
    expected: 'a Muse reply containing "control-plane  : OK"',
    found: { verdicts: await page.grep({ re: VERDICT_RE }), approvals: ctx.approved, foreign_cards: [...ctx.foreign] },
  });
}

// ---------------------------------------------------------------- chatgpt plugin
async function pluginListed(page, name) {
  return (await page.find({ text: [name], css: 'a,button,[role=button],[role=link],li,div,span', limit: 3 })).find((h) => h.score >= 2) || null;
}

async function connectConsent(page, name) {
  const named = (await page.waitFor(() => page.find({ text: [...L.chatgpt.connect.map((w) => `${w} ${name}`), ...L.chatgpt.connect.map((w) => `${w}${name}`)] }), { timeout: T(8000) })) || [];
  const btn = named[0] || (await page.find({ scope: 'dialog', text: L.chatgpt.connect, css: 'button,[role=button]' }))[0];
  if (!btn) return false;
  await page.click(btn.id, { settle: 1200 });
  return true;
}

async function stepPlugin(c) {
  if (c.out.control_plane !== 'OK') throw new Refuse('tunnel not connected yet: finish muse-wait first (creating the plugin earlier gives a misleading rate-limit error)', {});
  const page = await c.open('chatgpt', '/plugins');
  let name = c.names.plugin;
  await entry(page, 'chatgpt', { text: L.chatgpt.add }, 'plugins Add button');
  if (await pluginListed(page, name)) throw new Refuse(`a plugin named ${name} already exists but is not recorded`, { record: STEPS[4].manual(c).record });
  await page.click({ text: L.chatgpt.add }, { what: 'Add', settle: 500 });
  const custom = (await page.waitFor(() => page.find({ text: L.chatgpt.addCustomMcp }), { timeout: T(4000) })) || [];
  if (custom.length) await page.click(custom[0].id, { settle: 700 });
  await payWall(page);
  await page.fill({ scope: 'dialog', label: L.chatgpt.name }, name, { what: 'plugin name' });
  const tun = await page.findOne({ scope: 'dialog', text: L.chatgpt.tunnel }, { what: 'Connection: Tunnel' });
  await page.click(tun.id, { settle: 600 });
  const chip = (await page.waitFor(() => page.find({ scope: 'dialog', text: [c.out.tunnel_name] }), { timeout: T(8000) })) || [];
  if (!chip.length || chip[0].score < 4) {
    throw new StepError(`tunnel "${c.out.tunnel_name}" is not offered`, {
      expected: `a chip named ${c.out.tunnel_name}`,
      found: await page.snapshot({ scope: 'dialog' }),
      hint: 'the tunnel is probably not associated with this ChatGPT workspace: Platform -> Edit tunnel -> ChatGPT workspaces -> Save, then rerun --from-step plugin',
    });
  }
  await page.click(chip[0].id, { settle: 500 });
  const idOk = await page.waitFor(async () => (await page.grep({ scope: 'dialog', re: c.out.tunnel_id })).length || (await page.eval((a) => {
    const d = [...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].pop() || document;
    return [...d.querySelectorAll('input')].some((i) => i.value === a.id);
  }, { id: c.out.tunnel_id })), { timeout: T(4000) });
  const chipState = await page.state(chip[0].id);
  if (!idOk && !chipState?.selected) throw new StepError('tunnel selection did not stick', { expected: `chip ${c.out.tunnel_name} selected and id ${c.out.tunnel_id} shown`, found: [chipState] });
  const authField = (await page.field({ scope: 'dialog', label: L.chatgpt.auth }))[0];
  if (authField && /combobox|select|button/.test(authField.role || authField.tag)) {
    await page.select({ scope: 'dialog', label: L.chatgpt.auth }, L.chatgpt.noAuth, { what: 'authentication' });
  } else {
    const r = (await page.find({ scope: 'dialog', text: L.chatgpt.noAuth }))[0];
    if (!r) throw new StepError('"No authentication" option not found', { expected: 'Authentication = No authentication', found: await page.snapshot({ scope: 'dialog', text: L.chatgpt.auth }) });
    await page.click(r.id);
  }
  const und = (await page.find({ scope: 'dialog', text: L.chatgpt.understand }))[0];
  if (und) {
    const box = (await page.find({ within: und.id, css: 'input[type=checkbox],[role=checkbox]', text: [], hidden: true }))[0] || und;
    if (!(await page.state(box.id))?.selected) await page.click(und.id);
    if (!(await page.state(box.id))?.selected) throw new StepError('could not tick "I understand"', { expected: 'checkbox ticked', found: [await page.state(box.id)] });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    c.submitted();
    await page.click({ scope: 'dialog', text: L.chatgpt.create, css: 'button,[role=button]' }, { what: 'Create', settle: 1500 });
    const taken = await page.find({ scope: 'dialog', text: L.chatgpt.nameTaken, css: 'p,span,div,[role=alert]', limit: 1 });
    if (taken.length) {
      name = `${c.names.plugin} ${attempt + 2}`;
      c.state.names.plugin = name; c.save();
      await page.fill({ scope: 'dialog', label: L.chatgpt.name }, name, { what: 'plugin name (retry)' });
      continue;
    }
    const limited = await page.find({ text: L.chatgpt.rateLimited, css: 'p,span,div,[role=alert]', limit: 1 });
    if (limited.length) throw new StepError('ChatGPT reported a rate limit', { expected: 'plugin created', hint: 'usually the tunnel is not polling: rerun muse-wait / ask Muse to run restore.sh', found: limited });
    break;
  }
  await connectConsent(page, name);
  await page.goto(`${URLS.chatgpt}/plugins`);
  const listed = await page.waitFor(() => pluginListed(page, name), { timeout: T(10000) });
  if (!listed) throw new StepError('plugin not listed after Create', { expected: `"${name}" under installed plugins`, found: await page.snapshot({ text: [name] }) });
  return { plugin_name: name, ...(await connectedCheck(page, name)) };
}

async function connectedCheck(page, name) {
  const item = await pluginListed(page, name);
  await page.click(item.id, { settle: 900 });
  const needs = (await page.find({ text: L.chatgpt.connect, css: 'button,[role=button]', exclude: '[role=dialog]' })).filter((b) => b.score >= 3);
  if (needs.length) {
    await page.click(needs[0].id, { settle: 800 });
    await connectConsent(page, name);
  }
  const url = (await page.url()).split('?')[0];
  return { plugin_url: /plugin/.test(url) ? url : null };
}

async function recoverPlugin(c) {
  const page = await c.open('chatgpt', '/plugins');
  await entry(page, 'chatgpt', { text: L.chatgpt.add }, 'plugins page');
  const name = c.state.names.plugin;
  if (!(await page.waitFor(() => pluginListed(page, name), { timeout: T(6000) }))) return null;
  return { plugin_name: name, ...(await connectedCheck(page, name)), recovered: true };
}

// ---------------------------------------------------------------- test
async function pumpChatGPT(page, plugin, ctx) {
  const cards = await page.cards({ text: [...L.chatgpt.alwaysAllow, ...L.chatgpt.allow], css: 'button,[role=button]', exclude: 'form' });
  for (const card of cards) {
    if (ctx.done.has(card.card)) continue;
    const ours = card.text.includes(plugin) || /muse_(vm_exec|ping)/.test(card.text);
    if (!ours) { if (!ctx.foreign.has(card.text)) { ctx.foreign.add(card.text); emit({ event: 'foreign_approval_left_for_user', text: card.text }); } continue; }
    const btn = (await page.find({ within: card.card, text: L.chatgpt.alwaysAllow }))[0] || (await page.find({ within: card.card, text: L.chatgpt.allow }))[0];
    if (btn) { await page.click(btn.id); ctx.done.add(card.card); emit({ event: 'approved', site: 'chatgpt', how: btn.text }); }
  }
}

async function askTool(page, c, tok, ctx) {
  const comp = await typeMessage(page, 'chatgpt', testPrompt(c.out.plugin_name, tok));
  await sendMessage(page, 'chatgpt', L.chatgpt.send, comp);
  const re = `"echo_token"\\s*:\\s*"${tok}"`;
  const end = Date.now() + T(150000);
  while (Date.now() < end) {
    await pumpChatGPT(page, c.out.plugin_name, ctx);
    const got = await page.eval((a) => {
      const msgs = [...document.querySelectorAll(a.sel)];
      const pool = msgs.length ? [msgs[msgs.length - 1]] : [document.body];
      for (const m of pool) {
        const t = m.innerText || '';
        const hit = t.match(/\{[^{}]*"echo_token"[^{}]*\}/g) || [];
        for (const j of hit) if (new RegExp(a.re).test(j)) { try { return JSON.parse(j); } catch { return { raw: j.slice(0, 300) }; } }
      }
      return null;
    }, { sel: S.chatgptAssistant, re });
    if (got && got.utc) return got;
    await sleep(T(2000));
  }
  throw new StepError('no tool result with the token', {
    expected: `an assistant reply with JSON containing "echo_token": "${tok}"`,
    found: { assistant: await page.grep({ scope: S.chatgptAssistant, re: 'muse|tool|echo|error|plugin|插件|工具' }), foreign_cards: [...ctx.foreign] },
    hint: `if the model did not use the plugin, enable "${c.out.plugin_name}" in the composer (+ menu) and rerun --from-step test`,
  });
}

async function stepTest(c) {
  const page = await c.open('chatgpt', '/');
  await composer(page, 'chatgpt');
  const ctx = { done: new Set(), foreign: new Set() };
  const t1 = 'mcs-' + crypto.randomBytes(4).toString('hex');
  const r1 = await askTool(page, c, t1, ctx);
  await sleep(1100);
  const t2 = 'mcs-' + crypto.randomBytes(4).toString('hex');
  const r2 = await askTool(page, c, t2, ctx);
  if (r1.utc === r2.utc) throw new StepError('both calls returned the same utc', { expected: 'two different timestamps', found: [r1, r2] });
  return { token1: t1, utc1: r1.utc, token2: t2, utc2: r2.utc, hostname: r1.hostname, chat_url: (await page.url()).split('?')[0] };
}

async function stepLogs(c) {
  const page = await museTab(c);
  const FWD = 'dispatcher forwarded command to MCP server';
  const base = (await page.grep({ re: FWD })).length;
  const comp = await typeMessage(page, 'muse', MUSE_LOGS_MESSAGE);
  await sendMessage(page, 'muse', L.muse.send, comp);
  const ctx = { opened: new Set(), foreign: new Set(), approved: [] };
  const lines = await page.waitFor(async () => { await pumpMuse(page, ctx); const l = await page.grep({ re: FWD }); return l.length > base ? l.slice(base) : null; }, { timeout: T(180000), interval: T(2500) });
  if (!lines) throw new StepError('Muse did not return forwarded-command log lines', { expected: `"${FWD}" lines`, found: await page.grep({ re: 'dispatcher|tools/call|No such file|找不到' }) });
  const mcp = await page.grep({ re: 'rpc method=tools/call' });
  const withId = lines.filter((l) => l.includes(c.out.tunnel_id));
  return { forwarded: lines.length, forwarded_with_tunnel_id: withId.length, mcp_calls: mcp.length, sample: lines.slice(-2) };
}

// ---------------------------------------------------------------- runner
function failure(step, err, c, page) {
  const s = c.state.steps[step.name] || {};
  const base = { ok: false, step: step.name, attempts: s.attempts || 1, error: err.message };
  if (err instanceof NeedsUser) return { ...base, needs_user: err.kind, info: err.info, message: `Ask the user to complete ${err.kind} in the CDP browser, then rerun: ${CMD} run` };
  const m = step.manual(c);
  return {
    ...base,
    ...(err instanceof Refuse ? { refused: true } : {}),
    expected: err.info?.expected,
    problems: err.info?.problems,
    hint: err.info?.hint,
    found: err.info?.found,
    page: page || undefined,
    submitted: ['submitted', 'awaiting_user'].includes(s.status) || undefined,
    takeover: {
      do: err.info?.do || m.do,
      verify: m.verify,
      record: err.info?.record || m.record,
      resume: `${CMD} run`,
      rule: 'same step failing twice for the agent too -> stop and tell the user where it is stuck',
    },
  };
}

function validateOutputs(step, outputs) {
  const bad = [];
  for (const [k, rule] of Object.entries(step.required)) {
    const v = outputs[k];
    const ok = v !== undefined && v !== '' && (typeof rule === 'function' ? rule(String(v)) : rule.test(String(v)));
    if (!ok) bad.push(k);
  }
  return bad;
}

async function run() {
  const state = loadState();
  saveState(state);
  const dry = !!opts['dry-run'];
  const browser = await browserConnect();
  const opened = [];
  const museTabs = [];
  const c = {
    browser, state, opts: { mode: opts.mode || 'auto', ...opts }, names: state.names,
    get out() { return outputsOf(state); },
    save: () => saveState(state),
    // Muse tabs stay open: later steps continue in the same chat.
    async open(site, p) { const pg = await browser.newPage(URLS[site] + p); if (site !== 'muse') opened.push(pg); else museTabs.push(pg); return pg; },
  };
  if (!['auto', 'manual'].includes(c.opts.mode)) throw new Error('--mode must be auto or manual');

  if (dry) {
    const report = [];
    for (const [site, p, step] of [['platform', '/settings/organization/tunnels', 'tunnel'], ['platform', '/settings/organization/api-keys', 'key'], ['muse', '/', 'muse-install'], ['chatgpt', '/plugins', 'plugin'], ['chatgpt', '/', 'test']]) {
      const pg = await c.open(site, p);
      let res;
      try { res = await STEPS.find((s) => s.name === step).locate(c, pg); } catch (e) { res = [{ what: step, found: false, error: e instanceof NeedsUser ? `needs ${e.kind}` : e.message }]; }
      for (const r of res) report.push({ step, ...r });
      await pg.close();
      museTabs.length = 0;
    }
    const missing = report.filter((r) => !r.found);
    emit({ ok: missing.length === 0, dry_run: true, located: report });
    browser.close();
    return missing.length ? 10 : 0;
  }

  let from = opts['from-step'];
  if (from && !STEP_NAMES.includes(from)) throw new Error(`unknown step ${from}; steps: ${STEP_NAMES.join(', ')}`);
  const startIdx = from ? STEP_NAMES.indexOf(from) : 0;
  for (const s of STEPS.slice(0, startIdx)) {
    if (state.steps[s.name]?.status !== 'done') {
      emit({ ok: false, step: s.name, error: `--from-step ${from} needs "${s.name}" done first`, takeover: { record: s.manual(c).record } });
      browser.close();
      return 1;
    }
  }
  const only = opts.only;
  for (const step of STEPS.slice(startIdx)) {
    if (only && step.name !== only) continue;
    const prev = state.steps[step.name];
    if (prev?.status === 'done') {
      if (!(from === step.name && !step.creates)) { emit({ event: 'skip', step: step.name, reason: 'done' }); continue; }
    }
    state.steps[step.name] = { ...(prev || {}), status: prev?.status === 'done' ? 'running' : (prev?.status || 'running'), attempts: (prev?.attempts || 0) + 1, started_at: new Date().toISOString() };
    c.submitted = (status = 'submitted') => { state.steps[step.name].status = status; saveState(state); };
    saveState(state);
    emit({ event: 'step', step: step.name });
    let pageInfo = null;
    try {
      let outputs = null;
      if (['submitted', 'awaiting_user'].includes(prev?.status)) {
        outputs = step.recover ? await step.recover(c) : null;
        if (!outputs) throw new Refuse(`"${step.name}" was submitted earlier and its result was not found; not creating another one`, {
          do: [...step.manual(c).do, `if you are sure nothing was created: ${CMD} state reset ${step.name}`],
        });
      } else {
        outputs = await step.run(c);
      }
      const bad = validateOutputs(step, outputs);
      if (bad.length) throw new StepError(`step produced invalid outputs: ${bad.join(', ')}`, { expected: Object.keys(step.required).join(', '), found: outputs });
      state.steps[step.name] = { status: 'done', by: 'script', at: new Date().toISOString(), attempts: state.steps[step.name].attempts, outputs };
      saveState(state);
      emit({ event: 'done', step: step.name, outputs });
      for (const pg of opened.splice(0)) await pg.close();
    } catch (err) {
      const cur = state.steps[step.name];
      if (!['submitted', 'awaiting_user'].includes(cur.status)) cur.status = 'failed';
      cur.last_error = err.message;
      saveState(state);
      const last = opened[opened.length - 1] || museTabs[museTabs.length - 1];
      try { if (last) pageInfo = { url: (await last.url()).split('?')[0], left_open: true }; } catch { /* ignore */ }
      if (!(err instanceof StepError || err instanceof NeedsUser || err instanceof Refuse)) err.info = { expected: 'no internal error', found: String(err.stack || err).split('\n').slice(0, 4) };
      emit(failure(step, err, c, pageInfo));
      browser.close();
      return err instanceof NeedsUser ? 11 : err instanceof Refuse ? 12 : 10;
    }
  }
  const out = outputsOf(state);
  emit({ ok: true, summary: {
    tunnel: `${out.tunnel_name} (${out.tunnel_id})`, workspace: out.workspace, key: out.key_name, plugin: out.plugin_name,
    test: out.token1 ? `${out.token1} @ ${out.utc1}, ${out.token2} @ ${out.utc2}, host ${out.hostname}` : undefined,
    logs: out.forwarded !== undefined ? `${out.forwarded} forwarded lines (${out.forwarded_with_tunnel_id} with tunnel id), ${out.mcp_calls} MCP calls` : undefined,
  } });
  browser.shutdown();
  return 0;
}

// ---------------------------------------------------------------- state command
function stateCmd() {
  const state = loadState();
  const sub = pos[0];
  const kv = Object.fromEntries(pos.slice(2).concat(sub === 'set' ? pos.slice(1) : []).filter((x) => x.includes('=')).map((x) => x.split(/=(.*)/s).slice(0, 2)));
  if (sub === 'show' || !sub) { emit(state); return 0; }
  if (sub === 'done') {
    const step = STEPS.find((s) => s.name === pos[1]);
    if (!step) { emit({ ok: false, error: `unknown step; steps: ${STEP_NAMES.join(', ')}` }); return 1; }
    const outputs = { ...kv };
    if (step.name === 'key') outputs.key_file ||= state.key_file, outputs.key_name ||= state.names.key;
    if (step.name === 'plugin' && outputs.plugin_name) state.names.plugin = outputs.plugin_name;
    const bad = validateOutputs(step, outputs);
    if (bad.length) { emit({ ok: false, error: `missing/invalid: ${bad.join(', ')}`, required: Object.keys(step.required) }); return 1; }
    state.steps[step.name] = { status: 'done', by: 'manual', at: new Date().toISOString(), attempts: state.steps[step.name]?.attempts || 0, outputs };
    saveState(state);
    emit({ ok: true, recorded: step.name, outputs, next: `${CMD} run` });
    return 0;
  }
  if (sub === 'set') {
    for (const [k, v] of Object.entries(kv)) {
      const [a, b] = k.split('.');
      if (a === 'names' && b) state.names[b] = v; else if (k === 'key_file') state.key_file = v; else { emit({ ok: false, error: `cannot set ${k} (use names.tunnel|names.key|names.plugin|key_file)` }); return 1; }
    }
    saveState(state); emit({ ok: true, names: state.names, key_file: state.key_file }); return 0;
  }
  if (sub === 'reset') {
    const name = pos[1];
    if (!STEP_NAMES.includes(name)) { emit({ ok: false, error: 'unknown step' }); return 1; }
    delete state.steps[name];
    if (opts.rename) {
      const sfx = crypto.randomBytes(2).toString('hex');
      if (name === 'tunnel') state.names.tunnel += `-${sfx}`;
      if (name === 'key') { state.names.key += `-${sfx}`; state.key_file = state.key_file.replace(/\.txt$/, `-${sfx}.txt`); }
      if (name === 'plugin') state.names.plugin += ` ${sfx}`;
    }
    saveState(state);
    emit({ ok: true, reset: name, names: state.names, warning: 'make sure the page does not already hold an object with this name' });
    return 0;
  }
  emit({ ok: false, error: 'state show | done <step> k=v... | set names.<x>=v | reset <step> [--rename]' });
  return 1;
}

// ---------------------------------------------------------------- fallback tools
async function tabFor(browser) {
  const prefix = opts.tab || '';
  const t = (await browser.pages()).filter((p) => p.url.startsWith(prefix) || p.url.includes(prefix));
  if (!t.length) throw new StepError(`no open tab matches ${prefix}`, { found: (await browser.pages()).map((p) => p.url.split('?')[0]) });
  return browser.attach(t[t.length - 1].targetId);
}

async function toolCmd() {
  const browser = await browserConnect();
  try {
    const page = await tabFor(browser);
    const scope = opts.scope || 'page';
    let res;
    if (cmd === 'snapshot') res = await page.snapshot({ scope, text: split(opts.text), limit: Number(opts.limit || 40) });
    else if (cmd === 'click') res = await page.click({ scope, text: split(opts.text), css: opts.css }, { what: opts.text });
    else if (cmd === 'fill') res = await page.fill({ scope, label: split(opts.label) }, String(opts.value ?? ''), { what: opts.label });
    else if (cmd === 'select') res = await page.select({ scope, label: split(opts.label) }, split(opts.option), { what: opts.label });
    else if (cmd === 'attach') { await page.setFiles([path.resolve(opts.file)], { buttonSpec: opts.button ? { text: split(opts.button) } : { text: L.muse.attach } }); res = 'attached'; }
    else if (cmd === 'grep') res = await page.grep({ scope, re: opts.re });
    else if (cmd === 'press') { await page.press(opts.key || 'Escape', Number(opts.times || 1)); res = 'pressed'; }
    else if (cmd === 'key-from-page') {
      const state = loadState();
      const key = await readKeyFromPage(page);
      const fp = writeKeyFile(state.key_file, key);
      state.steps.key = { status: 'done', by: 'manual', at: new Date().toISOString(), outputs: { key_name: opts['key-name'] || state.names.key, key_file: state.key_file, key_fp: fp } };
      saveState(state);
      res = { recorded: 'key', key_file: state.key_file, key_fp: fp };
    }
    emit({ ok: true, result: res });
    return 0;
  } catch (e) {
    emit({ ok: false, error: e.message, expected: e.info?.expected, found: e.info?.found });
    return 10;
  } finally { browser.close(); }
}

function keyFromClipboard() {
  const state = loadState();
  let v;
  try { v = clip.read(); } catch { emit({ ok: false, error: 'pbpaste not available (macOS only)' }); return 1; }
  if (!new RegExp(KEY_RE).test(v)) { emit({ ok: false, error: 'clipboard does not hold an sk-... key (nothing written)' }); return 10; }
  const fp = writeKeyFile(state.key_file, v);
  clip.clear();
  state.steps.key = { status: 'done', by: 'manual', at: new Date().toISOString(), outputs: { key_name: opts['key-name'] || state.names.key, key_file: state.key_file, key_fp: fp } };
  saveState(state);
  emit({ ok: true, recorded: 'key', key_file: state.key_file, key_fp: fp, clipboard: 'cleared' });
  return 0;
}

function usage() {
  process.stdout.write(`usage:
  ${CMD} run [--mode auto|manual] [--cdp URL] [--workspace NAME] [--project NAME]
             [--from-step STEP] [--only STEP] [--dry-run] [--keep-key] [--no-relay] [--state FILE] [--labels FILE] [--ref TAG]
  ${CMD} state show | done <step> k=v ... | set names.plugin="..." | reset <step> [--rename]
  ${CMD} message install|restore|logs           print the Muse message text
  ${CMD} key-from-clipboard | key-from-page --tab URL
  ${CMD} relay stop          end the shared Chrome connection (otherwise: after a full run, or 10 idle minutes)
  ${CMD} snapshot|click|fill|select|attach|grep|press --tab URL-PREFIX [--scope dialog]
        [--text "A|B"] [--label "A|B"] [--value V] [--option "A|B"] [--file F] [--re REGEX] [--key Escape]
steps: ${STEP_NAMES.join(' -> ')}
default CDP endpoint: ${CDP}   state file: ${STATE_FILE}
`);
  return cmd ? 1 : 0;
}

async function main() {
  try {
    if (cmd === 'run') return await run();
    if (cmd === 'state') return stateCmd();
    if (cmd === 'key-from-clipboard') return keyFromClipboard();
    if (cmd === 'relay' && pos[0] === 'stop') {
      if (!fs.existsSync(RELAY_SOCK)) { emit({ ok: true, relay: 'not running' }); return 0; }
      (await browserConnect()).shutdown();
      emit({ ok: true, relay: 'stopped' });
      return 0;
    }
    if (cmd === 'message') {
      const st = loadState(); const o = outputsOf(st);
      const m = pos[0] === 'logs' ? MUSE_LOGS_MESSAGE : pos[0] === 'restore' ? MUSE_RESTORE_MESSAGE : museInstallMessage({ key_file: st.key_file, tunnel_id: o.tunnel_id || 'TUNNEL_ID' });
      process.stdout.write(m + '\n');
      return 0;
    }
    if (['snapshot', 'click', 'fill', 'select', 'attach', 'grep', 'press', 'key-from-page'].includes(cmd)) return await toolCmd();
    return usage();
  } catch (e) {
    emit({ ok: false, error: e.message, expected: e.info?.expected });
    return e instanceof StepError ? 10 : 1;
  }
}

process.exitCode = await main();
