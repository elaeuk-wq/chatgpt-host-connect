// Minimal Chrome DevTools Protocol driver. Node >= 22, no dependencies.
//
// Design rules
//  * real input: clicks and keys go through Input.dispatch*Event, so Radix-style
//    widgets that ignore element.click() (they open on pointerdown) still work
//  * file inputs are set with DOM.setFileInputFiles; a native file chooser is
//    intercepted and never shown
//  * page reads are scoped: only matched elements come back, always truncated
//    and redacted (API keys, JWT-like tokens, long opaque strings). The single
//    exception is readSecretInput(), whose result is never printed.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export class StepError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.info = info;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

// ---------------------------------------------------------------- browser
// Profile dirs whose DevToolsActivePort is written when remote debugging is
// switched on from chrome://inspect/#remote-debugging (the everyday profile).
export function browserProfileRoots(system = process.platform, home = os.homedir(), env = process.env) {
  if (system === 'win32') {
    const base = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return ['Google/Chrome/User Data','Google/Chrome Beta/User Data','Microsoft/Edge/User Data','Chromium/User Data']
      .map(p => path.win32.join(base, p));
  }
  if (system === 'darwin') return ['Google/Chrome','Google/Chrome Beta','Microsoft Edge','Chromium']
    .map(p => path.join(home, 'Library/Application Support', p));
  return ['google-chrome','google-chrome-beta','microsoft-edge','chromium']
    .map(p => path.join(env.XDG_CONFIG_HOME || path.join(home,'.config'),p));
}

async function wsFromHttp(base) {
  try {
    const res = await fetch(base + '/json/version', {signal:AbortSignal.timeout(3000)});
    return (await res.json()).webSocketDebuggerUrl;
  } catch { return null; }
}

// No process argv dumps, port scan or first-match selection. Explicit profile
// confines discovery to the owner's chosen user-data-dir, including custom paths.
export async function discoverEndpoints({profile, roots} = {}) {
  const {readFile} = await import('node:fs/promises');
  const candidates = [];
  for (const dir of profile ? [path.resolve(profile)] : (roots || browserProfileRoots())) {
    try {
      const [port, wsPath] = (await readFile(path.join(dir,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);
      if (!/^[0-9]+$/.test(port) || +port < 1 || +port > 65535 || !wsPath?.startsWith('/devtools/browser/')) continue;
      const endpoint = 'http://127.0.0.1:' + port;
      const live = await wsFromHttp(endpoint);
      // Ignore stale files and a port subsequently reused by another browser.
      if (live && new URL(live).pathname === wsPath.trim()) candidates.push({endpoint, profile:dir, websocket:live});
    } catch { /* absent/stale profile metadata is not a reason to start Chrome */ }
  }
  return candidates;
}

export async function resolveWsUrl(endpoint = 'auto') {
  if (endpoint === 'auto') {
    const candidates = await discoverEndpoints();
    if (candidates.length > 1) throw new StepError('Several debug browsers found; select the intended profile or --cdp', {found:candidates.map(({endpoint,profile})=>({endpoint,profile}))});
    return candidates[0]?.websocket || null;
  }
  const base = endpoint.replace(/\/+$/, '');
  let u;
  try { u = new URL(base); } catch { return null; }
  if (u.username || u.password) throw new StepError('CDP URLs must not embed credentials', {});
  if (u.protocol === 'ws:' || u.protocol === 'wss:') return base;
  if (u.protocol === 'http:' || u.protocol === 'https:') return wsFromHttp(base);
  return null;
}

const NO_ENDPOINT = {
  expected: 'remote debugging on: chrome://inspect/#remote-debugging in the signed-in Chrome, ' +
    'or a Chrome started with --remote-debugging-port and its own --user-data-dir',
};
const ALLOW_HINT = 'waiting for Chrome: click "Allow" on the remote-debugging prompt\n';

// With `relay` (a socket path) every process shares one Chrome connection held
// by relay.mjs, so the everyday Chrome asks for Allow once, not per command.
export async function connect(endpoint = 'auto', { relay, timeout = 90000 } = {}) {
  if (relay) return new Browser(await relayTransport(endpoint, relay));
  const url = await resolveWsUrl(endpoint);
  if (!url) throw new StepError(`cannot find a Chrome DevTools endpoint (${endpoint})`, NO_ENDPOINT);
  // The everyday profile asks the user to allow the connection; this can take a while.
  const hint = setTimeout(() => process.stderr.write(ALLOW_HINT), 3000);
  const ws = new WebSocket(url);
  let deadline;
  try {
    await new Promise((resolve, reject) => {
      deadline = setTimeout(() => {
        reject(new StepError('timed out waiting for the selected browser debugging connection', NO_ENDPOINT));
        try { ws.close(); } catch { /* unopened socket */ }
      }, timeout);
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new StepError(`websocket to ${url.replace(/\/devtools\/.*/, '')} failed`, {
        expected: 'the user clicks Allow on Chrome\'s remote-debugging prompt',
      })), { once: true });
    });
  } finally {
    clearTimeout(hint); clearTimeout(deadline);
  }
  return new Browser(ws);
}

// Unix socket speaking newline-delimited JSON, shaped like the WebSocket API
// Browser uses (addEventListener message/close, send, close).
async function socketTransport(sockPath) {
  const net = await import('node:net');
  const sock = await new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  const on = { message: [], close: [] };
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const data = buf.slice(0, i); buf = buf.slice(i + 1);
      if (data) for (const fn of on.message) fn({ data });
    }
  });
  sock.on('close', () => { for (const fn of on.close) fn(); });
  sock.on('error', () => {});
  return {
    addEventListener(type, fn) { on[type]?.push(fn); },
    send(s) { sock.write(s + '\n'); },
    close() { sock.end(); },
    shutdown() { sock.end('{"relay":"shutdown"}\n'); },
  };
}

async function relayTransport(endpoint, sockPath) {
  try { return await socketTransport(sockPath); } catch { /* not running: start it */ }
  const fs = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const statusFile = `${sockPath}.status`;
  try { fs.unlinkSync(statusFile); } catch { /* none */ }
  const relayJs = fileURLToPath(new URL('./relay.mjs', import.meta.url));
  spawn(process.execPath, [relayJs, endpoint, sockPath], { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + 180000;
  let hinted = false;
  while (Date.now() < deadline) {
    await sleep(300);
    let st = null;
    try { st = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { /* not yet */ }
    if (st?.state === 'error') {
      throw new StepError(st.error, st.error.startsWith('cannot find') ? NO_ENDPOINT : { expected: 'the user clicks Allow on Chrome\'s remote-debugging prompt' });
    }
    if (st?.state === 'ready') return socketTransport(sockPath);
    if (st?.state === 'waiting_for_allow' && !hinted && Date.now() > deadline - 177000) { process.stderr.write(ALLOW_HINT); hinted = true; }
  }
  throw new StepError('timed out waiting for Chrome to accept the connection (3 min)', { expected: 'the user clicks Allow on Chrome\'s remote-debugging prompt' });
}

class Browser {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method, timer } = this.pending.get(msg.id);
        clearTimeout(timer); this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject, method, timer } of this.pending.values()) {
        clearTimeout(timer); reject(new Error(`${method}: browser connection closed`));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId, { timeout = 10000 } = {}) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new StepError(`cdp_timeout: ${method} did not reply; no automatic replay`, {
          cdp_timeout: true, next_action: 'SAME_AI_RECOVERY',
        }));
      }, timeout);
      this.pending.set(id, { resolve, reject, method, timer });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async pages() {
    const { targetInfos } = await this.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page');
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.init();
    return page;
  }

  async newPage(url, { newWindow = false, inWindowOf } = {}) {
    let expectedWindow;
    if (inWindowOf) {
      expectedWindow = (await this.send('Browser.getWindowForTarget', {targetId:inWindowOf})).windowId;
      await this.send('Target.activateTarget', {targetId:inWindowOf});
    }
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', newWindow, background: false });
    if (expectedWindow !== undefined && (await this.send('Browser.getWindowForTarget', {targetId})).windowId !== expectedWindow) {
      await this.send('Target.closeTarget', {targetId}); // Only our new, still-blank tab.
      throw new StepError('page_window_mismatch: new tab did not open in the run-owned window', {next_action:'SAME_AI_RECOVERY'});
    }
    const page = await this.attach(targetId);
    await page.send('Page.bringToFront');
    if (url) await page.goto(url);
    return page;
  }

  // Reuse a tab whose URL starts with `prefix`, else open a new one.
  async pageFor(prefix, url) {
    const hit = (await this.pages()).find((t) => prefix && t.url.startsWith(prefix));
    if (hit) {
      const page = await this.attach(hit.targetId);
      await this.send('Target.activateTarget', { targetId: hit.targetId });
      return page;
    }
    return this.newPage(url || prefix);
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }

  // Also stop the shared relay (if any): the Chrome connection ends now.
  shutdown() {
    try { (this.ws.shutdown || this.ws.close).call(this.ws); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- in-page helpers
// Installed into the page on demand. Everything returned is redacted + truncated.
const HELPERS = String.raw`(() => {
  if (window.__mcs && window.__mcs.v === 6) return;
  const SECRET = /sk-[A-Za-z0-9_\-]{6,}|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-.]+|[A-Za-z0-9_\-+\/=]{40,}/g;
  const redact = (s) => String(s || '').replace(SECRET, (m) => m.startsWith('sk-') ? 'sk-[redacted]' : '[redacted]');
  const norm = (s) => String(s || '').normalize('NFKC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const cut = (s, n) => { s = redact(String(s || '').replace(/\s+/g, ' ').trim()); return s.length > n ? s.slice(0, n) + '…' : s; };
  const tag = (el) => { if (!el.dataset.mcs) el.dataset.mcs = String(window.__mcsCounter = (window.__mcsCounter || 0) + 1); return el.dataset.mcs; };
  const byId = (id) => document.querySelector('[data-mcs="' + id + '"]');
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  const isSecretField = (el) => el.matches && (el.matches('input[type=password]') || (el.matches('input[readonly],textarea[readonly]') && /^sk-/.test(el.value || '')));
  const textOf = (el) => {
    if (el.matches('input,textarea,select')) {
      if (el.matches('input[type=submit],input[type=button]')) return el.value;
      return el.getAttribute('aria-label') || el.placeholder || el.name || '';
    }
    const t = (el.innerText || el.textContent || '').trim();
    return t || el.getAttribute('aria-label') || el.getAttribute('title') || '';
  };
  const labelsOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), textOf(el)].filter(Boolean);
  const compile = (pats) => (pats || []).map((p) => {
    if (p instanceof RegExp) return { re: p };
    const m = /^\/(.*)\/([a-z]*)$/.exec(p);
    return m ? { re: new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i') } : { s: norm(p) };
  });
  const score = (texts, pats) => {
    let best = 0;
    for (const raw of texts) {
      const t = norm(raw);
      if (!t) continue;
      for (const p of pats) {
        if (p.re) { if (p.re.test(raw) || p.re.test(t)) best = Math.max(best, 3); continue; }
        if (t === p.s) best = Math.max(best, 4);
        else if (t.startsWith(p.s) && t.length <= p.s.length + 40) best = Math.max(best, 2);
        else if (t.includes(p.s) && t.length <= p.s.length + 80) best = Math.max(best, 1);
      }
    }
    return best;
  };
  const DIALOGS = '[role=dialog],[role=alertdialog],dialog[open],[aria-modal=true]';
  const root = (spec) => {
    if (spec.within) return byId(spec.within); // A vanished card must never widen scope to the whole page.
    if (spec.scope === 'dialog') {
      const ds = [...document.querySelectorAll(DIALOGS)].filter(visible);
      return ds.length ? ds[ds.length - 1] : null;
    }
    if (spec.scope && spec.scope !== 'page') return document.querySelector(spec.scope);
    return document.body;
  };
  const CLICKABLE = 'button,[role=button],a[href],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],[role=tab],[role=radio],[role=checkbox],[role=switch],label,input[type=submit],input[type=button],input[type=checkbox],input[type=radio],summary,[role=combobox],[aria-haspopup],[data-testid]';
  const CONTROLS = 'input:not([type=hidden]),textarea,select,[role=combobox],button[aria-haspopup],[contenteditable=true],[contenteditable=""],[role=textbox]';
  const stateOf = (el) => {
    const s = {};
    for (const a of ['aria-checked', 'aria-pressed', 'aria-selected', 'aria-expanded', 'aria-disabled', 'data-state']) {
      const v = el.getAttribute(a); if (v !== null) s[a] = v;
    }
    if (el.matches('input[type=checkbox],input[type=radio]')) s.checked = el.checked;
    if (el.matches(':disabled') || el.closest('[aria-disabled=true],[inert]') ||
        (el.tagName === 'LABEL' && el.control?.matches(':disabled'))) s.disabled = true;
    return s;
  };
  const describe = (el, extra) => {
    const d = Object.assign({ id: tag(el), tag: el.tagName.toLowerCase(), text: cut(textOf(el), 80) }, extra || {});
    const role = el.getAttribute('role'); if (role) d.role = role;
    const st = stateOf(el); if (Object.keys(st).length) d.state = st;
    if (el.matches('input,textarea') && !isSecretField(el) && el.type !== 'file') d.value = cut(el.value, 60);
    if (el.matches('select')) d.value = cut((el.selectedOptions[0] || {}).text, 60);
    if (el.matches('input[type=file]')) d.file = true;
    return d;
  };
  const isSelected = (el) => {
    const st = stateOf(el);
    return st.checked === true || st['aria-checked'] === 'true' || st['aria-pressed'] === 'true' ||
      st['aria-selected'] === 'true' || ['on', 'checked', 'active'].includes(st['data-state']);
  };

  function find(spec) {
    const r = root(spec); if (!r) return [];
    const pats = compile(spec.text);
    const sel = spec.css || CLICKABLE;
    const out = [];
    const seen = new Set();
    const consider = (el, s) => {
      if (seen.has(el)) return; seen.add(el);
      if (!spec.hidden && !visible(el)) return;
      if (spec.exclude && el.closest(spec.exclude)) return;
      if (spec.enabled && stateOf(el).disabled) return;
      out.push({ el, s });
    };
    for (const el of r.querySelectorAll(sel)) {
      const s = pats.length ? score(labelsOf(el), pats) : 1;
      if (s) consider(el, s);
    }
    if (!out.length && pats.length && !spec.css) {
      // text on a plain element: climb to the nearest clickable ancestor (or keep it)
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
      for (let el = walker.currentNode; el; el = walker.nextNode()) {
        if (el.children.length > 3) continue;
        const s = score([textOf(el), el.getAttribute('aria-label')].filter(Boolean), pats);
        if (s >= 2) consider(el.closest(CLICKABLE) || el, s);
      }
    }
    // A tooltip wrapper with aria-haspopup is not equivalent to its real button.
    const semantic = (el) => el.matches('button,a[href],input,select,textarea,[role=button],[role=radio],[role=checkbox],[role=tab],[role=option]') ? 2 :
      Number(el.matches(CLICKABLE.replace(',[data-testid]', '')));
    out.sort((a, b) => b.s - a.s || semantic(b.el) - semantic(a.el) || textOf(a.el).length - textOf(b.el).length);
    return out.slice(0, spec.limit || 10).map(({ el, s }) => describe(el, { score: s }));
  }

  function field(spec) {
    const r = root(spec); if (!r) return [];
    const pats = compile(spec.label);
    const want = spec.css || CONTROLS;
    const hits = [];
    const add = (el, how) => { if (el && el.matches && el.matches(want) && (spec.hidden || visible(el)) && !hits.some((h) => h.el === el)) hits.push({ el, how }); };
    for (const el of r.querySelectorAll(want)) {
      if (score([el.getAttribute('aria-label'), el.placeholder, el.name].filter(Boolean), pats)) add(el, 'attr');
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const t = lb.split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || '').join(' ');
        if (score([t], pats)) add(el, 'labelledby');
      }
      if (el.labels) for (const l of el.labels) if (score([l.innerText], pats)) add(el, 'label');
    }
    if (!hits.length) {
      const cands = [...r.querySelectorAll('label,legend,span,div,p,h1,h2,h3,h4,h5,h6,dt,th,td')]
        .filter((e) => e.children.length <= 2 && visible(e) && score([e.innerText], pats) >= 2);
      for (const lab of cands) {
        const inner = lab.querySelector(want);
        if (inner) { add(inner, 'inside'); continue; }
        let box = lab;
        for (let i = 0; i < 4 && box && !hits.length; i++) {
          box = box.parentElement; if (!box) break;
          const all = [...box.querySelectorAll(want)].filter(visible);
          const after = all.find((c) => lab.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
          if (after) add(after, 'near');
        }
        if (hits.length) break;
      }
    }
    return hits.slice(0, 5).map(({ el, how }) => describe(el, { how }));
  }

  function rect(id) {
    const el = byId(id); if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
    const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: !!top && (top === el || el.contains(top)),
      visible: visible(el), disabled: !!stateOf(el).disabled };
  }

  function state(id) { const el = byId(id); return el ? describe(el, { selected: isSelected(el), visible: visible(el) }) : null; }

  function focus(id) {
    const el = byId(id); if (!el) return false;
    el.focus();
    if (el.matches('input,textarea')) el.select();
    else if (el.isContentEditable) { const rg = document.createRange(); rg.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(rg); }
    return document.activeElement === el || el.contains(document.activeElement);
  }

  function setNativeSelect(id, pats) {
    const el = byId(id); if (!el || !el.matches('select')) return null;
    const p = compile(pats);
    const opt = [...el.options].find((o) => score([o.text, o.value], p));
    if (!opt) return { ok: false, options: [...el.options].map((o) => cut(o.text, 40)) };
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, text: cut(opt.text, 60) };
  }

  function activeOption() {
    const a = document.activeElement;
    let el = a && a.matches && a.matches('[role=option],[role=menuitem],[role=menuitemradio]') ? a : null;
    if (!el) {
      const ad = a && a.getAttribute && a.getAttribute('aria-activedescendant');
      if (ad) el = document.getElementById(ad);
    }
    if (!el) el = document.querySelector('[role=option][data-highlighted],[role=option][aria-selected=true][data-highlighted],[role=option].highlighted,[cmdk-item][data-selected=true]');
    return el ? describe(el) : null;
  }

  function snapshot(spec) {
    const r = root(spec) || document.body;
    const out = { url: location.href.split('?')[0], title: cut(document.title, 80), scope: spec.scope || 'page', dialogs: [...document.querySelectorAll(DIALOGS)].filter(visible).length };
    out.headings = [...r.querySelectorAll('h1,h2,h3,[role=heading]')].filter(visible).slice(0, 8).map((h) => cut(h.innerText, 80));
    out.controls = [...r.querySelectorAll(CLICKABLE + ',' + CONTROLS)].filter(visible)
      .filter((el) => !el.closest('[data-mcs-ignore]')).slice(0, spec.limit || 40).map((el) => describe(el));
    if (spec.text) {
      const pats = compile(spec.text);
      out.matches = [...r.querySelectorAll('*')].filter((e) => e.children.length <= 2 && visible(e) && score([e.innerText], pats))
        .slice(0, 8).map((e) => cut(e.innerText, 160));
    }
    return out;
  }

  // Lines of visible text matching a regex, excluding editors. Redacted.
  function grep(spec) {
    // scope 'dialog' with no dialog open matches nothing (never the whole page)
    const r = root(spec); if (!r) return [];
    const re = new RegExp(spec.re, spec.flags || 'i');
    const lines = [];
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    const skip = spec.exclude || 'textarea,[contenteditable=true],[contenteditable=""],script,style,noscript';
    const blocks = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement; if (!p || p.closest(skip)) continue;
      if (!re.test(n.textContent)) continue;
      const block = p.closest('pre,code,p,li,td,div') || p;
      blocks.add(block);
    }
    for (const b of blocks) {
      if (!visible(b) && !spec.hidden) continue;
      for (const line of (b.innerText || b.textContent || '').split(/\n/)) if (re.test(line)) lines.push(cut(line, spec.max || 300));
    }
    return [...new Set(lines)];
  }

  // Cards = nearest container of an approve button with enough text to judge it.
  function cards(spec) {
    const btns = find(Object.assign({}, spec, { limit: 30 }));
    const res = [];
    const seen = new Set();
    for (const b of btns) {
      let el = byId(b.id), card = el;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        const parent = card.parentElement;
        if (parent.matches('body,main,[role=main],[data-message-author-role=user]') || parent.querySelector('[data-message-author-role=user]')) break;
        card = parent;
        if ((card.innerText || '').length >= (spec.minText || 30)) break;
      }
      const owner = norm(spec.ownerText);
      const owns = (e) => {
        const t = norm(e.innerText);
        if (!owner) return true;
        let at = t.indexOf(owner);
        while (at >= 0) {
          if (!/[a-z0-9_-]/.test(t[at - 1] || '') && !/[a-z0-9_-]/.test(t[at + owner.length] || '')) return true;
          at = t.indexOf(owner, at + 1);
        }
        return false;
      };
      // Tool names/owner can be in a header above the button's immediate card.
      // Never expand into another approval group or the user prompt/thread root.
      const initial = card;
      for (let i = 0; owner && !owns(card) && i < 5; i++) {
        const parent = card.parentElement;
        if (!parent || parent.matches('body,main,[role=main],[data-message-author-role=user]') || parent.querySelector('[data-message-author-role=user]') ||
            btns.some(x => parent.contains(byId(x.id)) && !initial.contains(byId(x.id)))) break;
        card = parent;
      }
      if (seen.has(card)) continue; seen.add(card);
      res.push({ button: b, card: tag(card), matchesOwner: owns(card),
        matchesTool: !spec.toolText || norm(card.innerText).includes(norm(spec.toolText)), text: cut(card.innerText, 400) });
    }
    return res;
  }

  // Selected / non-default choices inside a container (for permission readback).
  function selectedIn(spec) {
    const r = root(spec); if (!r) return [];
    return [...r.querySelectorAll('[aria-checked],[aria-pressed],[aria-selected],[data-state],input[type=checkbox],input[type=radio],[role=combobox],select')]
      .filter((el) => visible(el) && (isSelected(el) || el.matches('[role=combobox],select')))
      .slice(0, 60).map((el) => {
        let row = el;
        for (let i = 0; i < 6 && row.parentElement; i++) { row = row.parentElement; if ((row.innerText || '').length > 12) break; }
        return Object.assign(describe(el), { row: cut(row.innerText, 120) });
      });
  }

  function readSecret(spec) {
    const r = root(spec); if (!r) return null;
    const re = new RegExp(spec.re);
    for (const el of r.querySelectorAll('input,textarea,code,pre,span,div')) {
      const v = el.matches('input,textarea') ? el.value : (el.children.length ? '' : el.textContent);
      if (v && re.test(v.trim())) return v.trim();
    }
    return null;
  }

  function countText(spec) { return grep(spec).length; }

  window.__mcs = { v: 6, tag, find, field, rect, state, focus, setNativeSelect, activeOption, snapshot, grep, cards, selectedIn, readSecret, countText, byId };
})()`;

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
};

// ---------------------------------------------------------------- page
export class Page {
  constructor(browser, sessionId, targetId) {
    this.b = browser;
    this.sid = sessionId;
    this.targetId = targetId;
    this.chooser = null;
  }

  send(method, params, options) { return this.b.send(method, params, this.sid, options); }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    this.loadErrors = [];
    this.b.on((m) => {
      if (m.sessionId !== this.sid) return;
      if (m.method === 'Page.fileChooserOpened') this.chooser = m.params;
      if (m.method === 'Network.responseReceived' && ['Document','Script','Stylesheet'].includes(m.params.type) && m.params.response.status >= 400) {
        const u = new URL(m.params.response.url);
        this.loadErrors.push({type:m.params.type,status:m.params.response.status,url:u.origin+u.pathname});
        this.loadErrors = this.loadErrors.slice(-8);
      }
    });
    await this.send('Network.enable');
  }

  waitEvent(method, ms = 20000) {
    return new Promise((resolve) => {
      const off = this.b.on((m) => {
        if (m.sessionId === this.sid && m.method === method) { off(); clearTimeout(t); resolve(m.params); }
      });
      const t = setTimeout(() => { off(); resolve(null); }, ms);
    });
  }

  async goto(url) {
    this.loadErrors = [];
    const loaded = this.waitEvent('Page.loadEventFired', 30000);
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(400);
  }

  // Node-side deadline: page timers/animation promises can themselves be frozen.
  // Never change CSS, disable animations or transplant a submitted page to pass.
  async ensureRendering({ timeout = 2000 } = {}) {
    await this.send('Page.bringToFront');
    try {
      const r = await this.send('Runtime.evaluate', {
        expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
        returnByValue: true, awaitPromise: true, timeout,
      }, { timeout });
      if (!r.exceptionDetails && r.result?.value === true) return;
    } catch (e) { if (!e.info?.cdp_timeout) throw e; }
    throw new StepError('page_render_stalled: selected tab is not producing animation frames', {
      next_action: 'SAME_AI_RECOVERY', expected: 'a responsive run-owned browser window',
      hint: 'Keep this tab and state. Do not change CSS, restart the browser, switch profiles, or loop through selectors/proxies. Resume only after the browser window is responsive.',
    });
  }

  async url() { return this.eval(() => location.href); }

  async close() { try { await this.b.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* ignore */ } }

  // Evaluate fn(arg) in the page with helpers installed.
  async eval(fn, arg) {
    const expression = `${HELPERS};(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`;
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('page eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
    return r.result.value;
  }

  mcs(name, arg) {
    return this.eval((a) => window.__mcs[a.name](a.arg), { name, arg });
  }

  find(spec) { return this.mcs('find', spec); }
  field(spec) { return this.mcs('field', spec); }
  state(id) { return this.mcs('state', id); }
  snapshot(spec = {}) { return this.mcs('snapshot', spec); }
  grep(spec) { return this.mcs('grep', spec); }
  cards(spec) { return this.mcs('cards', spec); }
  selectedIn(spec) { return this.mcs('selectedIn', spec); }

  async waitFor(fn, { timeout = 15000, interval = 300 } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await fn();
      if (v && (!Array.isArray(v) || v.length)) return v;
      if (Date.now() > end) return null;
      await sleep(interval);
    }
  }

  async findOne(spec, { timeout = 10000, what } = {}) {
    const hits = await this.waitFor(() => this.find(spec), { timeout });
    if (!hits) {
      throw new StepError(`not found: ${what || JSON.stringify(spec.text)}`, {
        expected: what || `an element matching ${JSON.stringify(spec.text)}`,
        found: await this.snapshot({ scope: spec.scope, text: spec.text }),
      });
    }
    return hits[0];
  }

  async fieldOne(spec, { timeout = 10000, what } = {}) {
    const hits = await this.waitFor(() => this.field(spec), { timeout });
    if (!hits) {
      throw new StepError(`field not found: ${what || JSON.stringify(spec.label)}`, {
        expected: what || `a form control labelled ${JSON.stringify(spec.label)}`,
        found: await this.snapshot({ scope: spec.scope, text: spec.label }),
      });
    }
    return hits[0];
  }

  async mouseClick(x, y, { move = true } = {}) {
    if (move) await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(40);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  // Real mouse click on an element (by descriptor id or by find spec).
  async click(target, opts = {}) {
    const spec = typeof target === 'object' && !target.id ? { ...target, enabled: true } : null;
    let el = spec ? await this.findOne(spec, opts) : typeof target === 'string' ? { id: target } : target;
    let previous = null, last = null;
    const ready = await this.waitFor(async () => {
      if (spec) el = (await this.find(spec))[0] || el;
      const r = await this.mcs('rect', el.id);
      last = r;
      const stable = r?.visible && r.hit && !r.disabled && previous &&
        Math.abs(r.x - previous.x) < 1 && Math.abs(r.y - previous.y) < 1;
      previous = r;
      if (!stable) return null;
      // Hover can move/re-render a control. Recheck AFTER moving, not before it.
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
      await sleep(60);
      const hovered = await this.mcs('rect', el.id);
      last = hovered; previous = hovered;
      return hovered?.visible && hovered.hit && !hovered.disabled &&
        Math.abs(hovered.x-r.x)<1 && Math.abs(hovered.y-r.y)<1 ? hovered : null;
    }, { timeout: opts.timeout ?? 5000, interval: 100 });
    if (!ready) throw new StepError('element not actionable; no click sent', {
      expected: opts.what || el.text || 'an enabled, unobscured, stable control', found: last,
    });
    // Persist intent only after actionability succeeds, immediately before input.
    // A lost CDP response is uncertain; never replay it automatically.
    await opts.beforeDispatch?.();
    await this.mouseClick(ready.x, ready.y, { move: false });
    await sleep(opts.settle ?? 250);
    return el;
  }

  async press(name, times = 1) {
    const k = KEYS[name];
    if (!k) throw new Error('unknown key ' + name);
    for (let i = 0; i < times; i++) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined });
      await sleep(60);
    }
  }

  async insertText(text) { await this.send('Input.insertText', { text }); }

  async focus(id) { return this.mcs('focus', id); }

  // Fill a text field and read the value back.
  async fill(spec, value, { what } = {}) {
    const f = await this.fieldOne(spec, { what });
    await this.click(f.id);
    await this.focus(f.id);
    await this.press('Backspace');
    if (value) await this.insertText(value);
    // React may re-render the input (its element id is then gone): re-find it by spec.
    const took = (st) => String(st?.value ?? st?.text ?? '').includes(value.slice(0, 50));
    let st = null;
    for (let i = 0; i < 6; i++) {
      await sleep(150);
      st = (await this.state(f.id)) || (await this.field(spec))[0] || null;
      if (!value || took(st)) break;
    }
    if (value && !took(st)) {
      throw new StepError(`field did not take the value: ${what}`, { expected: `${what} = ${value}`, found: [st] });
    }
    return f;
  }

  // Choose an option in a native <select>, a Radix/ARIA combobox, or a menu button.
  async select(spec, optionText, { what, verify } = {}) {
    const trig = await this.fieldOne({ ...spec, css: spec.css || 'select,[role=combobox],button[aria-haspopup],button[aria-expanded],input[role=combobox]' }, { what });
    const ok = async () => {
      const st = await this.state(trig.id);
      const shown = `${st?.text || ''} ${st?.value || ''}`;
      return verify ? verify(shown) : optionText.some((o) => shown.toLowerCase().includes(String(o).toLowerCase().replace(/^\/|\/i?$/g, '')));
    };
    if (trig.tag === 'select') {
      const res = await this.eval((a) => window.__mcs.setNativeSelect(a.id, a.pats), { id: trig.id, pats: optionText });
      if (res?.ok && (await ok())) return res.text;
      throw new StepError(`option not available: ${what}`, { expected: `${what} = ${optionText[0]}`, found: res?.options });
    }
    const optionSpec = { text: optionText, css: '[role=option],[role=menuitem],[role=menuitemradio],[cmdk-item],li[data-value],[role=listbox] li' };
    // 1) real mouse: open, pick
    await this.click(trig.id, { settle: 350 });
    let opt = await this.waitFor(() => this.find(optionSpec), { timeout: 2500 });
    if (opt) {
      await this.click(opt[0].id, { settle: 300 });
      if (await ok()) return opt[0].text;
    }
    // 2) keyboard: focus trigger, open with ArrowDown/Enter, walk the list.
    // Escape only while a list is open - otherwise it would close the dialog.
    const listOpen = async () => (await this.find({ css: optionSpec.css, text: [] })).length > 0;
    if (await listOpen()) await this.press('Escape');
    await this.focus(trig.id);
    for (const opener of ['ArrowDown', 'Enter', 'Space']) {
      await this.press(opener);
      await sleep(300);
      const any = await this.find({ css: optionSpec.css, text: [] });
      if (any.length) break;
    }
    for (let i = 0; i < 40; i++) {
      const cur = await this.mcs('activeOption');
      const match = cur && (await this.eval((a) => {
        const el = window.__mcs.byId(a.id); if (!el) return false;
        const t = (el.innerText || '').toLowerCase();
        return a.pats.some((p) => t.includes(String(p).toLowerCase()));
      }, { id: cur.id, pats: optionText }));
      if (match) { await this.press('Enter'); await sleep(300); break; }
      await this.press('ArrowDown');
    }
    if (await ok()) return optionText[0];
    const options = await this.find({ css: optionSpec.css, text: [], limit: 20 });
    if (await listOpen()) await this.press('Escape');
    throw new StepError(`could not select ${what}`, {
      expected: `${what} shows ${JSON.stringify(optionText)}`,
      found: { trigger: await this.state(trig.id), options },
    });
  }

  // Attach files: a file <input> directly, else intercept the chooser opened by `button`.
  async setFiles(files, { inputSpec, buttonSpec, what = 'attachment' } = {}) {
    const inputs = await this.find({ css: 'input[type=file]', text: [], hidden: true, ...(inputSpec || {}) });
    let backendNodeId;
    if (inputs.length) {
      backendNodeId = await this.backendId(inputs[inputs.length - 1].id);
    } else if (buttonSpec) {
      await this.send('Page.setInterceptFileChooserDialog', { enabled: true });
      this.chooser = null;
      await this.click(buttonSpec, { what });
      const ch = await this.waitFor(async () => this.chooser, { timeout: 5000, interval: 100 });
      await this.send('Page.setInterceptFileChooserDialog', { enabled: false });
      if (!ch) throw new StepError('no file input and no file chooser opened', { expected: what, found: await this.snapshot({ text: buttonSpec.text }) });
      backendNodeId = ch.backendNodeId;
    } else {
      throw new StepError('no file input on the page', { expected: what, found: await this.snapshot({}) });
    }
    await this.send('DOM.setFileInputFiles', { files, backendNodeId });
  }

  // Some sites (Muse) ignore files set through CDP: the message is then never
  // delivered. This goes through the real macOS open panel instead: focus the
  // file input, press Return for real (System Events) to open the panel, paste
  // the path into Go to Folder, confirm. Needs Accessibility for the terminal.
  async nativeFiles(file, { inputSpec, what = 'attachment' } = {}) {
    const { execFileSync } = await import('node:child_process');
    const osa = (script) => execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
    const sheets = () => Number(osa('tell application "System Events" to tell process "Google Chrome" to return count of sheets of window 1') || 0);
    const key = (code, mods = '') => osa(`tell application "System Events" to key code ${code}${mods ? ` using {${mods}}` : ''}`);
    const inputs = await this.find({ css: 'input[type=file]', text: [], hidden: true, ...(inputSpec || {}) });
    if (!inputs.length) throw new StepError('no file input on the page', { expected: what, found: await this.snapshot({}) });
    await this.send('Page.setInterceptFileChooserDialog', { enabled: false });
    await this.b.send('Target.activateTarget', { targetId: this.targetId });
    osa('tell application "Google Chrome" to activate');
    await sleep(500);
    await this.focus(inputs[inputs.length - 1].id);
    key(36); // Return on the focused input opens the panel
    if (!(await this.waitFor(async () => sheets() > 0, { timeout: 5000, interval: 300 }))) {
      throw new StepError('the file panel did not open', { expected: 'a macOS open panel on the Chrome window', hint: 'Accessibility permission for this terminal (System Settings > Privacy & Security > Accessibility)' });
    }
    let saved = null;
    try { saved = execFileSync('pbpaste', { encoding: 'utf8' }); } catch { /* empty clipboard */ }
    try {
      execFileSync('pbcopy', { input: file });
      key(5, 'command down, shift down'); // Cmd+Shift+G: Go to Folder
      await sleep(1000);
      key(9, 'command down'); // Cmd+V
      await sleep(600);
      for (let i = 0; i < 3 && sheets() > 0; i++) { key(36); await sleep(1200); }
    } finally {
      try { execFileSync('pbcopy', { input: saved ?? '' }); } catch { /* ignore */ }
    }
    if (sheets() > 0) { key(53); throw new StepError('file panel did not accept the path', { expected: file }); }
  }

  async backendId(mcsId) {
    const r = await this.send('Runtime.evaluate', { expression: `document.querySelector('[data-mcs="${mcsId}"]')` });
    const d = await this.send('DOM.describeNode', { objectId: r.result.objectId });
    return d.node.backendNodeId;
  }

  // The only unredacted read. Callers must never print the result.
  async readSecretInput(re, scope = 'dialog') {
    return this.eval((a) => window.__mcs.readSecret({ scope: a.scope, re: a.re }), { re, scope });
  }
}
