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

export class StepError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.info = info;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

// ---------------------------------------------------------------- browser
export async function connect(endpoint) {
  const base = endpoint.replace(/\/+$/, '');
  let ver;
  try {
    const res = await fetch(base + '/json/version');
    ver = await res.json();
  } catch (e) {
    throw new StepError(`cannot reach the Chrome DevTools endpoint ${base} (${e.message})`, {
      expected: 'a Chrome started with --remote-debugging-port and a signed-in profile',
    });
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new StepError(`websocket to ${base} failed`)), { once: true });
  });
  return new Browser(ws);
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
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
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

  async newPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const page = await this.attach(targetId);
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
}

// ---------------------------------------------------------------- in-page helpers
// Installed into the page on demand. Everything returned is redacted + truncated.
const HELPERS = String.raw`(() => {
  if (window.__mcs && window.__mcs.v === 3) return;
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
    if (spec.within) return byId(spec.within) || document.body;
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
    if (el.disabled) s.disabled = true;
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
    out.sort((a, b) => b.s - a.s || textOf(a.el).length - textOf(b.el).length);
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
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: !!top && (top === el || el.contains(top) || top.contains(el)) };
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
    const r = root(spec) || document.body;
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
        card = card.parentElement;
        if ((card.innerText || '').length >= (spec.minText || 30)) break;
      }
      if (seen.has(card)) continue; seen.add(card);
      res.push({ button: b, card: tag(card), text: cut(card.innerText, 400) });
    }
    return res;
  }

  // Selected / non-default choices inside a container (for permission readback).
  function selectedIn(spec) {
    const r = root(spec) || document.body;
    return [...r.querySelectorAll('[aria-checked],[aria-pressed],[aria-selected],[data-state],input[type=checkbox],input[type=radio],[role=combobox],select')]
      .filter((el) => visible(el) && (isSelected(el) || el.matches('[role=combobox],select')))
      .slice(0, 60).map((el) => {
        let row = el;
        for (let i = 0; i < 6 && row.parentElement; i++) { row = row.parentElement; if ((row.innerText || '').length > 12) break; }
        return Object.assign(describe(el), { row: cut(row.innerText, 120) });
      });
  }

  function readSecret(spec) {
    const r = root(spec) || document.body;
    const re = new RegExp(spec.re);
    for (const el of r.querySelectorAll('input,textarea,code,pre,span,div')) {
      const v = el.matches('input,textarea') ? el.value : (el.children.length ? '' : el.textContent);
      if (v && re.test(v.trim())) return v.trim();
    }
    return null;
  }

  function countText(spec) { return grep(spec).length; }

  window.__mcs = { v: 3, tag, find, field, rect, state, focus, setNativeSelect, activeOption, snapshot, grep, cards, selectedIn, readSecret, countText, byId };
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

  send(method, params) { return this.b.send(method, params, this.sid); }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    this.b.on((m) => {
      if (m.sessionId === this.sid && m.method === 'Page.fileChooserOpened') this.chooser = m.params;
    });
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
    const loaded = this.waitEvent('Page.loadEventFired', 30000);
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(400);
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

  async mouseClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(40);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  // Real mouse click on an element (by descriptor id or by find spec).
  async click(target, opts = {}) {
    const el = typeof target === 'string' ? { id: target } : target.id ? target : await this.findOne(target, opts);
    let r = await this.mcs('rect', el.id);
    if (!r) throw new StepError('element vanished before click', { expected: el.text });
    if (!r.hit) { await sleep(300); r = (await this.mcs('rect', el.id)) || r; }
    await this.mouseClick(r.x, r.y);
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
    await sleep(150);
    const st = await this.state(f.id);
    const got = st?.value ?? st?.text ?? '';
    if (value && !String(got).includes(value.slice(0, 50))) {
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
