#!/usr/bin/env node
// host-connect.mjs - drive a signed-in Chrome (over CDP) through the whole
// ChatGPT <-> local/SSH host setup. Node >= 22, no dependencies.
//
//   node host-connect.mjs run [--mode auto|manual] [--cdp auto|ws://...|http://host:port]
//   node host-connect.mjs run --dry-run            # locate elements only, no clicks
//   node host-connect.mjs run --from-step plugin   # resume after a manual fix
//   node host-connect.mjs state show|done|set|reset ...
//   node host-connect.mjs snapshot|click|fill|select|attach|grep ...   (fallback tools)
//   node host-connect.mjs key-from-clipboard | key-from-page
//
// stdout: one JSON object per line; the last line is the result.
// Exit: 0 ok, 10 step failed (agent takes over), 11 user needed (login/captcha/
// payment), 12 refused (would duplicate an object), 1 usage error.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acceptanceCommand, bindTarget, hostRequest } from './host-client.mjs';
import { connect, discoverEndpoints, StepError, sleep } from './cdp.mjs';
import { privateDir, privateFileOk, clipboard } from './platform.mjs';
import { LABELS as L, SELECTORS as S, mergeLabels } from './labels.mjs';


const SELF = fileURLToPath(import.meta.url);
const CMD = `node ${SELF}`;
const KEY_RE = '^sk-[A-Za-z0-9_\\-]{20,}$';

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
      else if (['allow-control', 'enable-linger', 'dry-run', 'no-relay', 'cdp-files', 'rename', 'retry-test'].includes(k)) opts[k] = true;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
      else opts[k] = true;
    } else pos.push(a);
  }
  return { cmd: pos[0], pos: pos.slice(1), opts };
}
const { cmd, pos, opts } = parseArgs(process.argv.slice(2));
const HOME_DIR = path.join(os.homedir(), '.chatgpt-host-setup');
const STATE_FILE = path.resolve(opts.state || path.join(HOME_DIR, 'state.json'));
const DATA_DIR = path.dirname(STATE_FILE);
let CDP = opts.cdp || process.env.HOST_SETUP_CDP || 'auto';
// One shared Chrome connection per state dir + endpoint (see relay.mjs); the
// everyday Chrome then asks for Allow once instead of once per command.
const relaySocket = () => {
  const tag = crypto.createHash('sha256').update(`${DATA_DIR}\0${CDP}`).digest('hex').slice(0, 10);
  const p = path.join(DATA_DIR, `cdp-${tag}.sock`);
  return p.length < 100 ? p : path.join(os.tmpdir(), `host-setup-cdp-${tag}.sock`); // Unix socket path limit
};
const browserConnect = () => {
  // Windows uses one direct connection for the complete run, not an unprotected
  // emulated Unix socket/named pipe. Dedicated CDP profiles need no relay prompt.
  if (opts['no-relay'] || process.platform === 'win32') return connect(CDP);
  ensureDir(DATA_DIR);
  return connect(CDP, { relay: relaySocket() });
};
async function chooseBrowser() {
  const saved = loadState().browser;
  if (opts['browser-user-data-dir']) {
    const found = await discoverEndpoints({profile:String(opts['browser-user-data-dir'])});
    if (found.length !== 1) throw new StepError('Selected browser profile has no live DevToolsActivePort; specify its verified --cdp endpoint or enable debugging', {});
    if (opts.cdp && opts.cdp !== found[0].endpoint) throw new StepError('--cdp does not match the selected profile', {});
    CDP = found[0].endpoint;
  } else if (!opts.cdp && !process.env.HOST_SETUP_CDP && saved) CDP = saved.endpoint;
  if (CDP === 'auto') {
    const found = await discoverEndpoints();
    if (found.length !== 1) throw new StepError('Select one debug browser using --cdp or --browser-user-data-dir; no port/profile guessed', {found:found.map(({endpoint,profile})=>({endpoint,profile}))});
    CDP = found[0].endpoint;
  }
}
const URLS = {
  platform: (opts['platform-url'] || 'https://platform.openai.com').replace(/\/+$/, ''),
  chatgpt: (opts['chatgpt-url'] || 'https://chatgpt.com').replace(/\/+$/, ''),
};
const TIMEOUT_SCALE = Number(opts['timeout-scale'] || 1);
const T = (ms) => Math.round(ms * TIMEOUT_SCALE);
const split = (s) => (s === undefined || s === true ? [] : String(s).split('|').map((x) => x.trim()).filter(Boolean));
if (opts.labels) mergeLabels(JSON.parse(fs.readFileSync(opts.labels, 'utf8')));

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const note = (m) => process.stderr.write(`[host-setup] ${m}\n`);

// ---------------------------------------------------------------- state
function ensureDir(d) { privateDir(d); }
function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const id = `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${crypto.randomBytes(2).toString('hex')}`;
  return {
    version: 1, run_id: id, created_at: d.toISOString(),
    names: { tunnel: `chatgpt-host-${id}`, key: `chatgpt-host-${id}`, plugin: `Host ${id}` },
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
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing symlink key file');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, `CONTROL_PLANE_API_KEY=${key}\n`, { mode: 0o600, flag:'wx' });
  fs.renameSync(tmp,file);
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}
function keyFileOk(file) {
  try {
    if (!privateFileOk(file)) return false;
    return /^CONTROL_PLANE_API_KEY=sk-[A-Za-z0-9_-]{20,}\n?$/.test(fs.readFileSync(file, 'utf8'));
  } catch { return false; }
}
function shred(file) {
  try { const n = fs.statSync(file).size; fs.writeFileSync(file, Buffer.alloc(n)); fs.unlinkSync(file); return true; } catch { return false; }
}
const clip = {
  read() { return clipboard(); },
  clear() { clipboard(true); },
  hash() { try { return crypto.createHash('sha256').update(clip.read()).digest('hex'); } catch { return ''; } },
};

// ---------------------------------------------------------------- host verification
const testPrompt = (plugin, command) =>
  `Use only the "${plugin}" app. Call execute_terminal exactly once with this JSON argument object, unchanged: ${JSON.stringify({command, timeout:20})}. It checks host identity and writes/reads one small acceptance file. Do not call host_probe or other tools, do not repeat the command. Briefly report its result.`;
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- page helpers
async function checkBlockers(page, site) {
  const url = await page.url();
  if (/\/(log-?in|sign-?in|signup|auth)(\/|\?|#|$)|\/\/auth\.|auth0\./i.test(url)) throw new NeedsUser('login', { site, url: url.split('?')[0] });
  const cap = await page.eval(() => !![...document.querySelectorAll('iframe')].find((f) => /challenges\.cloudflare|hcaptcha|recaptcha|arkoselabs|turnstile/.test(f.src)));
  if (cap) throw new NeedsUser('captcha', { site, url: url.split('?')[0] });
}

async function pageLoadState(page) {
  const view = await page.eval(() => ({
    blank: !(document.body?.innerText || '').trim() && !document.querySelector('button,input,textarea,[contenteditable=true]'),
    dialogs: [...document.querySelectorAll('[role=dialog],dialog[open],[aria-modal=true]')].filter(e=>e.getClientRects().length).length,
  }));
  return {...view, resources:page.loadErrors || []};
}
function loadingError(view) {
  return new StepError('page_load_failed: page content did not load; no object submitted', {
    found:view, expected:'a rendered page with the required visible, enabled control', next_action:'SAME_AI_RECOVERY',
    hint:view.resources.some(r=>[401,403].includes(r.status)) ?
      'The required control did not become usable within its normal wait, and page resources were denied. Keep this tab; check the reported access/session/network failure without repeated refreshes or blind account/proxy changes.' :
      'One safe reload was exhausted. Inspect network/site errors; this is not a missing-button failure.',
  });
}

// Only an untouched, blank entry page may be reloaded once. Never reload a form,
// submitted object or chat task; 401/403 are not blindly retried.
async function entry(page, site, spec, what, timeout = T(12000)) {
  await checkBlockers(page, site);
  // A failed subresource is diagnostic evidence, not proof the whole UI failed.
  // Observe the original tab for the existing budget; never refetch/bypass it.
  const usable = {...spec,enabled:true};
  let hit = await page.waitFor(() => page.find(usable), {timeout});
  if (hit) {
    await checkBlockers(page,site);
    const denied = (page.loadErrors || []).filter(r=>[401,403].includes(r.status));
    if (denied.length) emit({event:'page_resource_warning',site,resources:denied,required_control_ready:true,reloaded:false});
    return hit[0];
  }
  await checkBlockers(page,site);
  let view = await pageLoadState(page);
  if (view.resources.some(r=>[401,403].includes(r.status))) throw loadingError(view);
  if (view.blank && !view.dialogs) {
    emit({event:'page_reload',reason:'blank_entry_page',site,attempt:1});
    await sleep(T(1500));
    await page.goto(await page.url());
    await checkBlockers(page,site);
    hit = await page.waitFor(() => page.find(usable), {timeout});
    await checkBlockers(page,site);
    if (hit) {
      const denied = (page.loadErrors || []).filter(r=>[401,403].includes(r.status));
      if (denied.length) emit({event:'page_resource_warning',site,resources:denied,required_control_ready:true,reloaded:true});
      return hit[0];
    }
    view = await pageLoadState(page);
    if (view.blank || view.resources.some(r=>[401,403].includes(r.status))) throw loadingError(view);
  }
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
    name: 'host-install', creates: false, site: 'host',
    required: { host_id: /./, hostname: /./, root: /./ },
    manual: (c) => ({
      do: [`Install directly on ${c.state.target.alias}; no second AI or chat attachment.`,
           `Run: ${CMD} host install --state "${STATE_FILE}" --allow-control`,
           'Or follow references/host-bootstrap.md for agent-directed deployment; record the verified host identity.'],
      verify: ['MCP exposes shell/file tools as the intended login user', 'credentials stored privately; only loopback listeners'],
      record: `${CMD} host install records this step after checking the result`,
    }),
    run: async (c) => {
      if ((c.opts['host-mode'] || 'script') !== 'script') {
        const err = new NeedsUser('agent_host_setup', {});
        err.message = 'Current AI should perform host installation, then resume; no Muse handoff';
        throw err;
      }
      return hostRequest(c.state, c.opts, 'install', c.out);
    },
  },
  {
    name: 'host-wait', creates: false, site: 'host',
    required: { control_plane: /^OK$/ },
    manual: () => ({
      do: [`${CMD} host status --state "${STATE_FILE}"`],
      verify: ['this installation identity matches and its control-plane poll is fresh'],
      record: 'Resume run; host-wait checks the target directly, never trusts a pasted OK.',
    }),
    run: async (c) => {
      const end = Date.now() + T(90000);
      let r;
      for (let attempt = 0; Date.now() < end; attempt++) {
        r = hostRequest(c.state, { ...c.opts, _hostTimeoutMs: end - Date.now() }, 'status', c.out);
        if (r.host_id !== c.out.host_id || r.hostname !== c.out.hostname) throw new Error('Target host identity changed');
        if (r.control_plane === 'OK') return r;
        await sleep(Math.min(T(Math.min(10000, 2000 * (attempt + 1))), Math.max(0, end - Date.now())));
      }
      throw new StepError('Installed services have no fresh control-plane poll within 90 seconds', {
        found: { mcp_ok: r?.mcp_ok, control_plane: r?.control_plane },
        hint: 'Inspect owned service/network/credentials, then resume host-wait. Do not reinstall or create another tunnel.',
      });
    },
  },
  {
    name: 'plugin', creates: true, site: 'chatgpt',
    required: { plugin_name: /./ },
    manual: (c) => ({
      do: [
        `Open ${URLS.chatgpt}/plugins -> Add -> Add custom MCP server`,
        `Only if no plugin named "${c.names.plugin}" exists: Name "${c.names.plugin}", Connection Tunnel -> chip "${c.out.tunnel_name}", Authentication: No authentication, tick "I understand", Create`,
        `After Create, stay on that same tab until creation finishes and "Connect ${c.names.plugin}" appears; click it once and wait for this app's connection confirmation. Do not reopen the list or API page.`,
      ],
      verify: [`the selected tunnel chip is "${c.out.tunnel_name}" and the id field shows ${c.out.tunnel_id}`, 'the current page confirms this specific app is connected (e.g. <name> 现已连接); an Installed list heading is not proof'],
      record: `${CMD} state done plugin plugin_name="${c.names.plugin}"`,
    }),
    locate: async (c, page) => [await locate(page, 'chatgpt', { text: L.chatgpt.add }, 'plugins Add button')],
    run: stepPlugin, recover: recoverPlugin,
  },
  {
    name: 'test', creates: false, site: 'chatgpt',
    required: { verified: /^true$/, verification_version: /^2$/, token: /^hcs-[a-f0-9]{16}$/ },
    manual: (c) => ({
      do: [`Inspect the single acceptance task for "${c.out.plugin_name}". Fix only the reported blocker; do not resend or repeat passed checks.`,
           `Resume --from-step test to recheck existing evidence; use --retry-test only if a new task is necessary.`],
      verify: ['correct host identity, one successful shell command, random marker written/read, matching host-side execution log'],
      record: 'The test step checks target evidence automatically; no manual PASS.',
    }),
    locate: async (c, page) => locateComposer(page, 'chatgpt', false),
    run: stepTest,
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
  const btn = await page.waitFor(async () => (await page.find({ scope: 'dialog', text: labels, css: 'button,[role=button],input[type=submit]', enabled: true }))[0], { timeout: T(10000) });
  if (!btn) {
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
  const createTrigger = { text: L.platform.createTunnel, css: 'button,[role=button]', enabled: true };
  await entry(page, 'platform', createTrigger, 'Create tunnel button');
  if (await tunnelRow(page, name)) throw new Refuse(`a tunnel named ${name} already exists but is not in the state file`, { record: STEPS[0].manual(c).record });
  await page.click(createTrigger, { what: 'Create tunnel', settle: 0 });
  await payWall(page);
  const form = await page.waitFor(() => page.field({ scope: 'dialog', label: L.platform.tunnelName }), { timeout: T(10000) });
  if (!form && (await pageLoadState(page)).blank) throw loadingError(await pageLoadState(page));
  if (!form) throw new StepError('Create tunnel did not open its form; no tunnel submitted', {
    expected: 'visible creation dialog with the tunnel name field',
    hint: 'Inspect the actual button/dialog on this tab before retrying; do not record this as submitted.',
  });
  const nameField = await page.fill({ scope: 'dialog', label: L.platform.tunnelName }, name, { what: 'tunnel name' });
  let workspace = await pickWorkspace(page, c, nameField?.id);
  const desc = (await page.field({ scope: 'dialog', label: L.platform.tunnelDescription }))[0];
  if (desc) await page.fill({ scope: 'dialog', label: L.platform.tunnelDescription }, 'ChatGPT direct host control (chatgpt-host-connect)', { what: 'tunnel description' });
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
      if (!lab.getClientRects().length || !a.names.includes(n(lab.innerText))) continue;
      const own = lab.closest(a.trig);
      if (own && own !== lab) return window.__mcs.tag(own);
      if (lab.matches(a.trig)) continue;
      let row = lab;
      for (let i = 0; i < 4 && row.parentElement; i++) {
        row = row.parentElement;
        const triggers = [...row.querySelectorAll(a.trig)].filter(e=>e.getClientRects().length);
        if (triggers.length === 1) return window.__mcs.tag(triggers[0]);
        // Never climb into the entire form and mistake another field for this row.
        if (triggers.length > 1) break;
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
  const enabledTrigger = async (labels) => {
    const id = await rowTrigger(page, labels);
    const st = id && await page.state(id);
    return st?.visible && !st.state?.disabled && st.state?.['aria-disabled'] !== 'true' ? id : null;
  };
  const proj = await page.waitFor(() => enabledTrigger(L.platform.project), {timeout:T(5000)});
  if (!proj) throw new StepError('project field not available; no key submitted', {
    expected:'a visible, enabled project selector in the owned key form',
    found:await page.snapshot({scope:'dialog'}),
  });
  const shown = norm((await page.state(proj))?.text);
  let project = shown;
  if ((c.opts.project && norm(c.opts.project) !== shown) || !shown || /select|choose|选择/.test(shown)) {
    [project] = await pickOptions(page, proj, c.opts.project ? [[c.opts.project]] : null, {what:'project',preferred:L.platform.defaultProject});
  }
  // A closed option list/click acknowledgment is not a committed selection.
  // Re-find the trigger because the site may remount it after the selection.
  const committed = await page.waitFor(async () => {
    const id = await rowTrigger(page, L.platform.project);
    const st = id && await page.state(id);
    return st?.visible && st.state?.['aria-expanded'] !== 'true' && norm(st.text) === norm(project);
  }, {timeout:T(5000)});
  if (!committed) throw new StepError('project selection did not take effect; no key submitted', {
    expected:`project selector shows ${project}`, found:await triggerText(page,L.platform.project),
    hint:'Keep the owned form. Do not repeat the option click blindly or continue to expiry/permissions.',
  });
  const exp = await page.waitFor(() => enabledTrigger(L.platform.expiry), {timeout:T(5000)});
  if (!exp) throw new StepError('expiration field not available after confirmed project selection', {
    expected:'an enabled expiration field',found:{project:await triggerText(page,L.platform.project),expiry:await triggerText(page,L.platform.expiry)},
  });
  await pickOptions(page, exp, [L.platform.expiry30], { what: 'expiration' });
  const restricted = await page.findOne({ scope: 'dialog', text: L.platform.restricted, css: '[role=radio],button,label' }, { what: 'Permissions: Restricted' });
  if (restricted.state?.['aria-checked'] !== 'true' && restricted.state?.['data-state'] !== 'on') await page.click(restricted.id, { settle: 300 });
  const tun = await page.waitFor(() => rowTrigger(page, L.platform.tunnelsRow), { timeout: T(5000) });
  if (!tun) throw new StepError('"Tunnels" permission row not found', { expected: 'a Tunnels row under Restricted permissions', found: await page.snapshot({ scope: 'dialog' }) });
  await pickOptions(page, tun, [L.platform.tunnelsUse, L.platform.tunnelsRead], { what: 'Tunnels permission' });
  return project;
}

// Readback: Restricted on; Tunnels shows Read + Use; every other resource None;
// expiry 30 days; the footer counts exactly the two Tunnels permissions.
async function verifyKeyForm(page, expectedProject) {
  const problems = [];
  const project = await triggerText(page,L.platform.project);
  if (!expectedProject || project !== norm(expectedProject)) problems.push('project selection changed or is missing');
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
  return { problems, seen: { project, tunnels: tun, expiry: exp, footer: count || null } };
}

async function stepKey(c) {
  const page = await c.open('platform', '/settings/organization/api-keys');
  const name = c.names.key;
  const form = c.state.steps.key.form;
  const nameFields = await page.field({label:L.platform.keyName,css:'[role=dialog] input,[aria-modal=true] input,dialog[open] input'});
  const dialogs = (await pageLoadState(page)).dialogs;
  if (dialogs) {
    if (!nameFields.length || form?.target_id !== page.targetId) throw new StepError('An unowned or unexpected dialog is open; no background Create click sent', {
      hint:'Inspect the bound tab; resume only this run\'s key form. Do not click through an overlay or create another key.',
    });
    // Resume our existing form; a portaled selection list must be closed first.
    const expanded = await page.eval(() => {
      const dialog=[...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].find(e=>e.querySelector('input'));
      const el=dialog?.querySelector('[aria-expanded=true]');
      return el ? window.__mcs.tag(el) : null;
    });
    if (expanded) await page.click(expanded,{settle:0});
  } else {
    await entry(page, 'platform', { text: L.platform.createKey, css:'button,[role=button]',enabled:true }, 'Create new secret key button');
    if (await keyRow(page, name)) throw new Refuse(`a key named ${name} already exists but is not recorded`, { record: STEPS[1].manual(c).record });
    c.state.steps.key.form = {target_id:page.targetId}; c.save();
    await page.click({ text: L.platform.createKey, css:'button,[role=button]' }, { what: 'Create new secret key', settle: 0 });
    await payWall(page);
    const field = await page.waitFor(()=>page.field({scope:'dialog',label:L.platform.keyName}),{timeout:T(10000)});
    if (!field) {
      const view=await pageLoadState(page);
      if(view.blank) throw loadingError(view);
      throw new StepError('Key creation form did not open; no key submitted', {});
    }
  }
  const projectShown = await fillKeyForm(page, c, name);
  const v = await verifyKeyForm(page, projectShown);
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
  let row = await page.waitFor(() => keyRow(page, name), { timeout: T(10000) });
  if (!row) { // the list may not refresh by itself
    await page.goto(URLS.platform + '/settings/organization/api-keys');
    row = await page.waitFor(() => keyRow(page, name), { timeout: T(10000) });
  }
  if (!row) throw new StepError('new key not visible in the key list', { expected: `a row named ${name}`, found: await page.snapshot({ text: [name] }) });
  return { key_name: name, key_file: c.state.key_file, key_fp: fp, key_row: row, project: projectShown || null, expiry: '30 days' };
}

async function recoverKey(c) {
  if (keyFileOk(c.state.key_file)) return { key_name: c.names.key, key_file: c.state.key_file, recovered: true };
  const page = await c.open('platform', '/settings/organization/api-keys');
  const visibleKey = await page.readSecretInput(KEY_RE, 'dialog');
  if (visibleKey && c.state.steps.key.form?.target_id === page.targetId) {
    const fp = writeKeyFile(c.state.key_file,visibleKey);
    return {key_name:c.names.key,key_file:c.state.key_file,key_fp:fp,recovered:true};
  }
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

// ---------------------------------------------------------------- chatgpt plugin
async function pluginListed(page, name) {
  const find = async () => {
    // Prefer a real link/button; clicking an exact-text wrapper div can do nothing.
    const clickable = (await page.find({ text: [name], css: 'a,button,[role=button],[role=link]', limit: 10 })).find(h => h.score === 4);
    return clickable || (await page.find({ text: [name], css: 'li,div,span', limit: 10 })).find(h => h.score === 4) || null;
  };
  let item = await find();
  if (item) return item;
  const tab = (await page.find({ text: L.chatgpt.personal, css: '[role=tab],[role=tablist] button,[role=tablist] a', limit: 5 })).find(h => h.score === 4);
  if (tab && !(await page.state(tab.id))?.selected) {
    await page.click(tab.id, { settle: 250 });
    item = await find();
  }
  return item;
}

async function waitPluginConnection(c, page, name) {
  const progress = c.state.steps.plugin.connection;
  const end = progress.started_at_ms + progress.budget_ms;
  const actions = [...L.chatgpt.connect, ...L.chatgpt.install];
  const namedActions = actions.flatMap(w => [`${w} ${name}`, `${w}${name}`]);
  const namedSuccess = [`${name} 现已连接`, `${name}现已连接`, `${name} 已连接`,
    `${name}已连接`, `${name} is now connected`, `${name} is connected`, `Connected to ${name}`];
  await page.send('Page.bringToFront');
  for (;;) {
    // A list heading such as "Installed" is not proof that this app is connected.
    const named = (await page.find({ text: namedSuccess, css: 'p,span,div,[role=status],[role=alert]', limit: 20 })).some(h => h.score === 4);
    const url = await page.url();
    const detail = url.startsWith(URLS.chatgpt + '/plugins/') &&
      (await page.find({ text: [name], css: 'h1,h2,h3,[role=heading]' })).some(h => h.score === 4);
    const connected = detail && (await page.find({ text: L.chatgpt.connected, css: 'p,span,[role=status]' })).some(h => h.score === 4);
    if (named || connected) return { plugin_url: url.split('?')[0], connected: true };

    const taken = await page.find({ scope: 'dialog', text: L.chatgpt.nameTaken, css: 'p,span,[role=alert]', limit: 1 });
    if (taken.length) {
      c.submitted('failed'); // Explicitly rejected: do not rename or silently reuse another app.
      throw new Refuse(`plugin name "${name}" already exists; inspect it before retrying`, {});
    }
    const errors = await page.find({ text: [...L.chatgpt.rateLimited, ...L.chatgpt.connectionFailed],
      css: '[role=alert],[role=dialog] p,[role=dialog] span', limit: 3 });
    if (errors.length) throw new StepError('Plugin creation/connection reported an error', {
      found: errors, hint: 'Inspect the current page and service-provided retry guidance. Do not create another plugin.',
    });
    if (Date.now() >= end) throw new StepError('Plugin creation/connection did not finish within 90 seconds', {
      expected: `creation completes, then Connect ${name}, then confirmation for this app`,
      hint: 'The current tab is left open. Inspect it, then resume; no second Create or automatic return to the plugin/API pages.',
    });

    let button = (await page.find({ text: namedActions, css: 'button,[role=button]', enabled: true })).find(h => h.score === 4);
    let scope = 'named';
    if (!button) {
      const dialogOwner = (await page.find({ scope: 'dialog', text: [name], css: 'h1,h2,h3,span,p,a' })).some(h => h.score === 4);
      if (dialogOwner || detail) {
        scope = dialogOwner ? 'dialog' : 'detail';
        button = (await page.find({ ...(dialogOwner ? { scope: 'dialog' } : {}), text: actions,
          css: 'button,[role=button]', enabled: true })).find(h => h.score === 4);
      }
    }
    if (button) {
      const action = scope + ':' + norm(button.text);
      if (!progress.clicked_actions.includes(action)) {
        // Persist before dispatch: a slow response or rerender must not cause double submission.
        progress.clicked_actions.push(action); c.save();
        await page.click(button.id, { what: `Connect ${name}`, settle: 0 });
      }
    }
    await sleep(Math.min(T(500), Math.max(0, end - Date.now())));
  }
}

async function stepPlugin(c) {
  if (c.out.control_plane !== 'OK') throw new Refuse('tunnel not connected yet: finish host-wait first (creating the plugin earlier gives a misleading rate-limit error)', {});
  const page = await c.open('chatgpt', '/plugins');
  const name = c.names.plugin;
  await page.send('Page.bringToFront');
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
  const und = (await page.find({ scope: 'dialog', text: L.chatgpt.understand, css: 'label,[role=checkbox]' }))[0] ||
    (await page.find({ scope: 'dialog', text: L.chatgpt.understand }))[0];
  if (und) {
    const box = (await page.find({ within: und.id, css: 'input[type=checkbox],[role=checkbox]', text: [], hidden: true }))[0] || und;
    if (!(await page.state(box.id))?.selected) await page.click(und.id);
    if (!(await page.state(box.id))?.selected) throw new StepError('could not tick "I understand"', { expected: 'checkbox ticked', found: [await page.state(box.id)] });
  }
  await submitEnabled(page, L.chatgpt.create, 'Create plugin');
  c.state.steps.plugin.connection = { target_id: page.targetId, started_at_ms: Date.now(),
    budget_ms: T(90000), clicked_actions: [] };
  c.submitted();
  await page.click({ scope: 'dialog', text: L.chatgpt.create, css: 'button,[role=button]' }, { what: 'Create', settle: 0 });
  // Stay on the submitted page. Creation may still be discovering tools; the
  // Connect control is offered only once that work finishes.
  return { plugin_name: name, ...(await waitPluginConnection(c, page, name)) };
}

async function recoverPlugin(c) {
  const name = c.names.plugin;
  const previous = c.state.steps.plugin.connection;
  const tab = previous && (await c.browser.pages()).find(p => p.targetId === previous.target_id &&
    (p.url === URLS.chatgpt + '/plugins' || p.url.startsWith(URLS.chatgpt + '/plugins/') || p.url.startsWith(URLS.chatgpt + '/plugins?')));
  if (tab) {
    const page = await c.attach(tab.targetId);
    return { plugin_name: name, ...(await waitPluginConnection(c, page, name)), recovered: true };
  }
  // Only explicit recovery after losing the original tab/legacy state visits
  // the list. It may connect the existing object, never submit Create again.
  const page = await c.open('chatgpt', '/plugins');
  await page.send('Page.bringToFront');
  await entry(page, 'chatgpt', { text: L.chatgpt.add }, 'plugins page');
  const item = await page.waitFor(() => pluginListed(page, name), { timeout: T(6000) });
  if (!item) return null;
  await page.click(item.id, { settle: 0 });
  c.state.steps.plugin.connection = { target_id: page.targetId, started_at_ms: Date.now(),
    budget_ms: T(90000), clicked_actions: [] };
  c.save();
  return { plugin_name: name, ...(await waitPluginConnection(c, page, name)), recovered: true };
}

// ---------------------------------------------------------------- test
async function pumpChatGPT(page, plugin, ctx, request, save) {
  if (page.targetId !== request.target_id || Date.now() >= request.started_at_ms + request.budget_ms) return;
  const cards = await page.cards({ text: L.chatgpt.allow, css: 'button,[role=button]',
    // Localized cards can be forms and need not show a raw tool name.
    exclude: '[data-message-author-role=user],#prompt-textarea,[contenteditable=true],textarea', ownerText: plugin });
  for (const card of cards.filter(c => !c.matchesOwner)) {
    if (!ctx.foreign.has(card.card)) { ctx.foreign.add(card.card); emit({ event: 'foreign_approval_untouched' }); }
  }
  const ours = cards.filter(c => c.matchesOwner);
  if (ours.length > 1) throw new StepError('Multiple approval cards match this app; nothing approved', {
    hint: 'Inspect the saved task/card ownership. Do not approve another app, open details as a routine step or send a new task.',
  });
  const dispatched = request.approval_dispatch_intent_at_ms || request.approval_dispatched_at_ms;
  if (dispatched) {
    const active = ours.length && (await page.find({within:ours[0].card,text:L.chatgpt.allow,css:'button,[role=button]',enabled:true})).length;
    if (!active && !request.approval_confirmed_at_ms) {
      request.approval_confirmed_at_ms = Date.now(); request.approval_confirmation = 'ui_transition'; save();
      emit({event:'approved',site:'chatgpt',owner_verified:true,details_opened:false,ui_acknowledged:true});
    } else if (active && (request.approval_confirmed_at_ms || Date.now()-dispatched >= T(5000))) {
      throw new StepError('approval_not_confirmed: this app still has an active Allow once control; no second approval sent', {
        next_action:'SAME_AI_RECOVERY', found:{target_id:page.targetId,active_app_cards:ours.length},
        hint:'Keep the original task and inspect this card only. Do not open details, resend the task, wait in sleep loops or claim that dispatch meant approval. Resume only after a diagnosed repair.',
      });
    }
    return;
  }
  if (!ours.length) return;
  const card = ours[0];
  if (!request.approval_seen_at_ms) { request.approval_seen_at_ms = Date.now(); save(); }
  const btn = (await page.find({ within: card.card, text: L.chatgpt.allow, css: 'button,[role=button]', enabled: true }))[0];
  if (!btn) return;
  // The owner authorized this app's one acceptance call. Do not open View details
  // or require parsing a UI argument envelope; host evidence decides acceptance.
  await page.click(btn.id, { settle: 0, beforeDispatch: () => {
    request.approval_dispatch_intent_at_ms = Date.now(); save();
  } });
  request.approval_dispatched_at_ms = Date.now(); save(); ctx.done.add(card.card);
  emit({ event: 'approval_dispatched', site: 'chatgpt', how: btn.text, owner_verified: true, details_opened: false });
}

async function stepTest(c) {
  let request = c.state.steps.test?.request;
  const check = (timeout = 10000) => hostRequest(c.state, { ...c.opts, _hostTimeoutMs: timeout }, 'verify', { ...c.out, ...request });
  const verifyIdentity = r => {
    if (r.host_id !== c.out.host_id || r.hostname !== c.out.hostname) throw new Error('Acceptance reached the wrong host');
    return r;
  };
  // Resume without a new chat/tool call if the previous task already executed.
  if (request && !c.opts['retry-test']) {
    const r = verifyIdentity(check());
    if (r.verified) return { ...r, command_hash: request.command_hash, reused_evidence: true };
  }
  let page;
  if (!request || c.opts['retry-test']) {
    page = await c.open('chatgpt', '/');
    await composer(page, 'chatgpt');
    const token = 'hcs-' + crypto.randomBytes(8).toString('hex');
    const command = acceptanceCommand(c.out, token);
    request = { token, command_hash: crypto.createHash('sha256').update(command).digest('hex'),
      started_at_ms: Date.now(), budget_ms: T(90000), target_id: page.targetId, chat_url: await page.url() };
    c.state.steps.test.request = request;
    c.save(); // Persist BEFORE sending; a timeout is not permission to submit twice.
    const comp = await typeMessage(page, 'chatgpt', testPrompt(c.out.plugin_name, command));
    await sendMessage(page, 'chatgpt', L.chatgpt.send, comp);
    request.chat_url = await page.url();
    c.save();
  } else {
    if (Date.now() >= request.started_at_ms + request.budget_ms) {
      throw new StepError('acceptance budget expired; no task resubmitted', { hint: 'Inspect the existing ChatGPT approval/result and host logs. --retry-test is only for an explicitly needed new attempt.' });
    }
    const tabs = (await c.browser.pages()).filter(p => siteUrl(p.url, URLS.chatgpt) &&
      (request.target_id ? p.targetId === request.target_id : p.url === request.chat_url));
    if (tabs.length !== 1) throw new StepError('Original acceptance tab is missing or ambiguous; no new task sent', {
      hint: 'Inspect the saved task and host evidence; do not select an arbitrary ChatGPT tab.',
    });
    page = await c.attach(tabs[0].targetId);
    await page.ensureRendering({timeout:T(2000)});
  }
  const command = acceptanceCommand(c.out, request.token);
  if (crypto.createHash('sha256').update(command).digest('hex') !== request.command_hash) {
    throw new StepError('Saved acceptance command no longer matches target configuration; nothing approved', {});
  }
  const ctx = { done: new Set(), foreign: new Set() };
  const end = request.started_at_ms + request.budget_ms;
  let last;
  while (Date.now() < end) {
    // Host proof takes precedence over delayed UI acknowledgment; never click again
    // after the one authorized command has already executed.
    last = verifyIdentity(check(Math.max(1, end - Date.now())));
    if (last.verified) {
      if ((request.approval_dispatch_intent_at_ms || request.approval_dispatched_at_ms) && !request.approval_confirmed_at_ms) {
        request.approval_confirmed_at_ms = Date.now(); request.approval_confirmation = 'host_evidence'; c.save();
        emit({event:'approved',site:'chatgpt',owner_verified:true,details_opened:false,host_verified:true});
      }
      return { ...last, command_hash: request.command_hash, chat_url: await page.url() };
    }
    await pumpChatGPT(page, c.out.plugin_name, ctx, request, c.save);
    await sleep(Math.min(T(1500), Math.max(0, end - Date.now())));
  }
  throw new StepError('single acceptance task did not complete within 90 seconds', {
    expected: 'matching host execution log plus written/read marker',
    found: { shell_ok: last?.shell_ok, file_ok: last?.file_ok, approvals: ctx.done.size, foreign_cards: [...ctx.foreign] },
    hint: 'Check approval, app selection or tool error. Do not repeat passed checks or wait another ten minutes.',
  });
}

// ---------------------------------------------------------------- runner
// The CLI stops unsafe automatic actions, not the owning AI's setup task.
function technicalRecovery(err) {
  let inspect = 'Inspect the reported control/error on the saved tab and the same installation; repair only the identified cause.';
  if (/^page_load_failed:/.test(err.message)) inspect = 'Reinspect the saved page and required controls now. A subresource 403 alone does not prove login failure. If the page has become usable, resume the same state; otherwise diagnose that resource/session/network failure, without bypassing access checks or repeated reloads.';
  else if (/^page_render_stalled:|^page_window_mismatch:/.test(err.message)) inspect = 'Inspect the saved window/tab rendering and focus. Use authorized browser controls on that selected profile; preserve submitted forms/tasks. Do not rewrite CSS, change profiles or restart the browser without authorization.';
  else if (/^approval_not_confirmed:/.test(err.message)) inspect = 'Check host execution evidence first, then the original task and unique app card. Resolve the diagnosed focus/overlay/UI problem only. Do not open details or blindly repeat an uncertain approval, and do not send a new task.';
  else if (/^cdp_timeout:/.test(err.message)) inspect = 'Reconnect read-only to the selected endpoint and check whether the timed-out action already took effect before deciding any recovery action. Never replay an uncertain write/click.';
  return {
    next_action:'SAME_AI_RECOVERY',
    recovery:{owner:'current_ai',script_stopped:true,
      do:[inspect,'Verify the repair, then continue the original workflow with its saved state, owned objects and original acceptance task. Do not ask the user to do ordinary setup clicks.'],
      rule:'Each diagnostic/action is bounded. Continue while evidence identifies a safe new action; change approach after repeated failure, not unchanged retries or fixed-sleep loops. Missing authorization/login/MFA/admin permission or an evidenced external blocker requires an honest prerequisite report, never bypass or fabricated success.',
    },
  };
}
function failure(step, err, c, page) {
  const s = c.state.steps[step.name] || {};
  const base = { ok: false, step: step.name, attempts: s.attempts || 1, error: err.message };
  if (err instanceof NeedsUser && err.kind === 'agent_host_setup') return { ...base, needs_agent: true, takeover: step.manual(c), resume: `${CMD} run --state "${STATE_FILE}"` };
  if (err instanceof NeedsUser) return { ...base, next_action:'NEEDS_USER', needs_user: err.kind, info: err.info, message: `Ask the user to complete ${err.kind} in the CDP browser, then rerun: ${CMD} run` };
  if (err.info?.next_action === 'SAME_AI_RECOVERY') return {
    ...base, ...technicalRecovery(err), expected:err.info.expected, found:err.info.found,
    hint:err.info.hint, page:page || undefined, submitted:['submitted','awaiting_user'].includes(s.status) || undefined,
  };
  const m = step.manual(c);
  return {
    ...base, ...technicalRecovery(err),
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
      owner:'current_ai',
      rule: 'The same AI diagnoses and repairs within authorization, then resumes. Repeated failure requires a new evidence-based approach, not giving up or unchanged retries. Preserve original state/tab/task, acceptance deadline and evidence; report actual fallbacks and elapsed time.',
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
  bindTarget(state, opts);
  if (!['agent', 'script'].includes(opts['host-mode'] || 'script')) throw new Error('--host-mode must be agent or script');
  const dry = !!opts['dry-run'];
  if (!dry && (opts['host-mode'] || 'script') === 'script' && !opts['allow-control'] && state.steps['host-install']?.status !== 'done') {
    throw new Error('Authorized end-to-end setup requires --allow-control before creating any objects');
  }
  if (state.browser && state.browser.endpoint !== CDP) throw new Error('State is bound to another browser endpoint; use the original --cdp');
  if (!dry) {
    state.browser ||= { endpoint: CDP, tabs: {} };
    state.workflow_started_at ||= new Date().toISOString();
  }
  saveState(state);
  const browser = await browserConnect();
  const opened = [];
  const c = {
    browser, state, opts: { mode: opts.mode || 'auto', ...opts }, names: state.names,
    get out() { return outputsOf(state); },
    save: () => saveState(state),
    async open(site, p) {
      const url = URLS[site] + p;
      const saved = !dry && state.browser.tabs[site];
      const tabs = await browser.pages();
      const tab = saved && tabs.find(t => t.targetId === saved.target_id);
      const sibling = !dry && Object.values(state.browser.tabs).find(s => s.target_id !== saved?.target_id && tabs.some(t=>t.targetId===s.target_id && siteUrl(t.url,s.base)));
      if (tab && (saved.base !== URLS[site] || !siteUrl(tab.url, URLS[site]))) {
        throw new StepError('Bound tab moved to another site; no navigation or click sent', { found: { target_id: tab.targetId } });
      }
      // Start with new owned tabs, not repeated newWindow calls: some Chromium
      // builds freeze rendering when several headless windows are created.
      let pg = tab ? await browser.attach(tab.targetId) : await browser.newPage(null, {inWindowOf:sibling?.target_id});
      const bind = () => {
        opened.push(pg);
        if (!dry) { state.browser.tabs[site] = {target_id:pg.targetId,base:URLS[site]}; saveState(state); }
      };
      bind();
      await pg.send('Page.bringToFront');
      if (await pg.url() !== url) await pg.goto(url);
      try { await pg.ensureRendering({timeout:T(2000)}); }
      catch (err) {
        // Exactly one window fallback, only for a brand-new, unsubmitted entry
        // tab. Never transplant a saved form/chat or reset its submission state.
        if (tab || dry || state.browser.window_recovery_at || !err.message.startsWith('page_render_stalled:')) throw err;
        const view = await pageLoadState(pg);
        if (view.dialogs || view.resources.some(r=>[401,403].includes(r.status))) throw err;
        state.browser.window_recovery_at = new Date().toISOString(); saveState(state);
        emit({event:'page_window_recovery',site,attempt:1,reason:'new_entry_tab_render_stalled'});
        const original = pg;
        pg = await browser.newPage(null, {newWindow:true}); bind();
        await browser.send('Target.detachFromTarget',{sessionId:original.sid});
        opened.splice(opened.indexOf(original),1);
        await original.close(); // Our new entry tab only; never a user's existing tab.
        await pg.goto(url);
        await pg.ensureRendering({timeout:T(2000)});
      }
      return pg;
    },
    async attach(targetId) {
      const pg = await browser.attach(targetId); opened.push(pg);
      if (!dry && siteUrl(await pg.url(), URLS.chatgpt)) {
        state.browser.tabs.chatgpt = { target_id: targetId, base: URLS.chatgpt }; saveState(state);
      }
      return pg;
    },
  };
  if (!['auto', 'manual'].includes(c.opts.mode)) throw new Error('--mode must be auto or manual');

  if (dry) {
    const report = [];
    for (const [site, p, step] of [['platform', '/settings/organization/tunnels', 'tunnel'], ['platform', '/settings/organization/api-keys', 'key'], ['chatgpt', '/plugins', 'plugin'], ['chatgpt', '/', 'test']]) {
      const pg = await c.open(site, p);
      let res;
      try { res = await STEPS.find((s) => s.name === step).locate(c, pg); } catch (e) { res = [{ what: step, found: false, error: e instanceof NeedsUser ? `needs ${e.kind}` : e.message }]; }
      for (const r of res) report.push({ step, ...r });
      await pg.close();
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
    state.steps[step.name] = { ...(prev || {}), status: prev?.status === 'done' ? 'running' : (prev?.status || 'running'), attempts: (prev?.attempts || 0) + 1,
      first_started_at:prev?.first_started_at || prev?.started_at || new Date().toISOString(), started_at: new Date().toISOString() };
    c.submitted = (status = 'submitted') => { state.steps[step.name].status = status; saveState(state); };
    saveState(state);
    emit({ event: 'step', step: step.name });
    let pageInfo = null;
    const stepStarted = Date.now();
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
      const current = state.steps[step.name];
      const wallStart = current.request?.started_at_ms || current.connection?.started_at_ms || Date.parse(current.first_started_at);
      state.steps[step.name] = { ...current, status: 'done', by: 'script', at: new Date().toISOString(),
        attempts: current.attempts, elapsed_ms: Date.now() - stepStarted,
        wall_elapsed_ms: Date.now() - wallStart, outputs };
      delete state.steps[step.name].last_error;
      saveState(state);
      emit({ event: 'done', step: step.name, outputs });
      // Keep the two run-owned tabs: Platform tunnel -> key, ChatGPT plugin -> acceptance.
      // Releasing CDP sessions does not close or navigate those pages.
      for (const pg of opened.splice(0)) await browser.send('Target.detachFromTarget', { sessionId: pg.sid });
    } catch (err) {
      const cur = state.steps[step.name];
      if (!['submitted', 'awaiting_user'].includes(cur.status)) cur.status = 'failed';
      cur.last_error = err.message;
      cur.elapsed_ms = Date.now() - stepStarted;
      saveState(state);
      const last = opened[opened.length - 1];
      try { if (last) pageInfo = { target_id: last.targetId, url: (await last.url()).split('?')[0], left_open: true }; } catch { /* ignore */ }
      if (!(err instanceof StepError || err instanceof NeedsUser || err instanceof Refuse)) err.info = { expected: 'no internal error', found: String(err.stack || err).split('\n').slice(0, 4) };
      emit(failure(step, err, c, pageInfo));
      browser.close();
      return err instanceof NeedsUser ? (err.kind === 'agent_host_setup' ? 13 : 11) : err instanceof Refuse ? 12 : 10;
    }
  }
  const out = outputsOf(state);
  emit({ ok: true, summary: {
    tunnel: `${out.tunnel_name} (${out.tunnel_id})`, workspace: out.workspace, key: out.key_name, plugin: out.plugin_name,
    test: out.verified ? `single-task acceptance verified on ${out.hostname}` : undefined,
    workflow_wall_ms: Date.now()-Date.parse(state.workflow_started_at),
    timing_scope:'First real run to this result, including recovery; AI preparation before the first run is separate.',
    timings_ms: Object.fromEntries(Object.entries(state.steps).map(([k,v]) => [k, v.elapsed_ms ?? null])),
    wall_timings_ms: Object.fromEntries(Object.entries(state.steps).map(([k,v]) => [k, v.wall_elapsed_ms ?? null])),
    complete: STEPS.every(s => state.steps[s.name]?.status === 'done'),
    next_action: STEPS.every(s => state.steps[s.name]?.status === 'done') ? 'REPORT_AND_STOP' : 'RESUME_INCOMPLETE_STEP',
    stop_instruction: 'Verified file + successful command hash are final evidence. Report recorded timings and fallbacks. Do not reread ChatGPT prose, revisit plugin/API pages or repeat health/log/tool checks. At most one read-only comparison of the pre-recorded old connections remains.',
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
function siteUrl(url, base) {
  return url === base || url.startsWith(base + '/') || url.startsWith(base + '?') || url.startsWith(base + '#');
}

async function tabFor(browser) {
  const pages = await browser.pages();
  const selector = opts['tab-id'] || opts.tab;
  if (!selector || selector === true) throw new StepError('Specify --tab-id or an unambiguous --tab URL; no tab selected', {});
  const state = loadState();
  if (state.browser && state.browser.endpoint !== CDP) throw new StepError('Use the state-bound --cdp endpoint', {});
  let matches;
  if (opts['tab-id']) matches = pages.filter(p => p.targetId === selector);
  else {
    // Prefer an exact URL; broad URL prefixes must not silently choose the last tab.
    matches = pages.filter(p => p.url === selector);
    if (!matches.length) matches = pages.filter(p => siteUrl(p.url, String(selector).replace(/\/+$/, '')));
  }
  if (matches.length !== 1) throw new StepError('Tab selector is missing or ambiguous; no action sent', {
    found: matches.map(p => ({ target_id: p.targetId, url: p.url.split('?')[0] })),
    expected: 'one exact --tab-id from the failure page or browser target list',
  });
  const page = await browser.attach(matches[0].targetId);
  if (!['snapshot', 'grep'].includes(cmd)) await page.send('Page.bringToFront');
  return page;
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
    else if (cmd === 'attach') { if (opts['cdp-files'] || process.platform !== 'darwin') await page.setFiles([path.resolve(opts.file)], { buttonSpec: opts.button ? { text: split(opts.button) } : { text: ['Attach', 'Upload', '添加附件'] } }); else await page.nativeFiles(path.resolve(opts.file)); res = 'attached'; }
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
    emit({ ok: false, error: e.message, expected: e.info?.expected, found: e.info?.found, ...technicalRecovery(e) });
    return 10;
  } finally { browser.close(); }
}

function keyFromClipboard() {
  const state = loadState();
  let v;
  try { v = clip.read(); } catch (e) { emit({ ok: false, error: e.message }); return 1; }
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
  ${CMD} browser-discover [--browser-user-data-dir PATH]  # read-only, no guessed ports
  ${CMD} run [--mode auto|manual] [--cdp URL | --browser-user-data-dir PATH] [--workspace NAME] [--project NAME]
             --target local|SSH_ALIAS --host-name NAME [--target-os posix|windows] [--host-mode agent|script] [--allow-control] [--control-plane-proxy auto|direct|URL]
             [--from-step STEP] [--only STEP] [--dry-run] [--no-relay] [--state FILE] [--labels FILE] [--retry-test]
  ${CMD} state show | done <step> k=v ... | set names.plugin="..." | reset <step> [--rename]
  ${CMD} host install|status|logs|preflight --target local|SSH_ALIAS --host-name NAME [--allow-control] [--enable-linger]
  ${CMD} key-from-clipboard | key-from-page --tab URL
  ${CMD} relay stop          end the shared Chrome connection (otherwise: after a full run, or 10 idle minutes)
  ${CMD} snapshot|click|fill|select|attach|grep|press (--tab-id TARGET_ID | --tab UNIQUE_URL) [--scope dialog]
        [--text "A|B"] [--label "A|B"] [--value V] [--option "A|B"] [--file F] [--re REGEX] [--key Escape]
steps: ${STEP_NAMES.join(' -> ')}
default host-mode: script (one AI, end-to-end); --allow-control required for installation
 default CDP endpoint: ${CDP}   state file: ${STATE_FILE}
`);
  return cmd ? 1 : 0;
}

async function main() {
  try {
    if (cmd === 'browser-discover') {
      const candidates = await discoverEndpoints({profile:opts['browser-user-data-dir']});
      emit({ok:candidates.length===1,candidates:candidates.map(({endpoint,profile})=>({endpoint,profile})),
        hint:'Select the owner-chosen browser only. No launch, restart, profile creation or port scan was performed.'});
      return candidates.length===1 ? 0 : 10;
    }
    if (['run','snapshot','click','fill','select','attach','grep','press','key-from-page','relay'].includes(cmd)) await chooseBrowser();
    if (cmd === 'run') return await run();
    if (cmd === 'state') return stateCmd();
    if (cmd === 'key-from-clipboard') return keyFromClipboard();
    if (cmd === 'relay' && pos[0] === 'stop') {
      if (process.platform === 'win32' || !fs.existsSync(relaySocket())) { emit({ ok: true, relay: 'not running' }); return 0; }
      (await browserConnect()).shutdown();
      emit({ ok: true, relay: 'stopped' });
      return 0;
    }
    if (cmd === 'host') {
      const state = loadState();
      bindTarget(state, opts);
      saveState(state);
      const started = Date.now();
      const result = hostRequest(state, opts, pos[0] || 'status', { ...outputsOf(state), ...(state.steps.test?.request || {}) });
      if (pos[0] === 'install') {
        state.steps['host-install'] = { status: 'done', by: 'host-command', at: new Date().toISOString(), elapsed_ms: Date.now() - started, outputs: result };
        saveState(state);
      }
      emit({ ok: true, result }); return 0;
    }
    if (['snapshot', 'click', 'fill', 'select', 'attach', 'grep', 'press', 'key-from-page'].includes(cmd)) return await toolCmd();
    return usage();
  } catch (e) {
    emit({ ok: false, error: e.message, expected: e.info?.expected, hint:e.info?.hint, ...technicalRecovery(e) });
    return e instanceof StepError ? 10 : 1;
  }
}

process.exitCode = await main();
