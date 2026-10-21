// Fake Platform / Muse / ChatGPT pages for offline tests of muse-setup.mjs.
// They imitate the parts that broke real runs: Radix-style selects that ignore
// element.click(), a file chooser opened by a button, approval cards with a
// split "allow once / more options" button, consent dialogs, slow lists.
// Muse is in Chinese, Platform and ChatGPT in English (bilingual matching).
//
//   node fixture-server.mjs PORT            GET /api/counts, POST /api/reset {fail:[...]}
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || 8899);
let S;
function reset(fail = []) {
  S = { fail: new Set(fail), tunnels: [], keys: [], plugins: [], muse: { messages: [], installs: 0, approvals: [], foreignClicked: false, secretsSeen: 0, cards: [], replies: [] },
    chat: { toolCalls: 0, approvals: [] }, listHide: fail.includes('plugin-list-hidden-once') ? 2 : 0, workspaces: ['Acme Team'] };
}
reset();

const FX = String.raw`
window.fx = {
  api: async (p, body) => (await fetch('/api/' + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json(),
  h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else if (v !== false && v !== undefined) e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k) e.append(k);
    return e;
  },
  dialog(title, ...kids) {
    const d = fx.h('div', { role: 'dialog', 'aria-modal': 'true', class: 'dlg' }, fx.h('h2', { text: title }), ...kids);
    document.body.append(d);
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('[role=listbox]')) d.remove(); });
    return d;
  },
  // Radix-like select: opens on pointerdown (ignores click()), portal listbox, keyboard nav.
  select({ label, options, value, placeholder = 'Select…', onChange }) {
    const lid = 'l' + Math.random().toString(36).slice(2);
    const lab = fx.h('span', { id: lid, class: 'lab', text: label });
    const val = fx.h('span', { text: value || placeholder });
    const trig = fx.h('button', { type: 'button', role: 'combobox', 'aria-expanded': 'false', 'aria-labelledby': lid, 'data-state': 'closed' }, val);
    let lb = null, openedAt = 0;
    const close = () => { if (lb) { lb.remove(); lb = null; } trig.setAttribute('aria-expanded', 'false'); trig.dataset.state = 'closed'; };
    const pick = (o) => { value = o; val.textContent = o; close(); trig.focus(); onChange && onChange(o); };
    const open = () => {
      if (lb) return;
      openedAt = Date.now();
      const r = trig.getBoundingClientRect();
      lb = fx.h('div', { role: 'listbox', style: 'position:absolute;left:' + r.left + 'px;top:' + (r.bottom + scrollY + 4) + 'px;background:#fff;border:1px solid #999;z-index:1000' });
      options.forEach((o) => {
        const it = fx.h('div', { role: 'option', tabindex: '-1', 'aria-selected': String(o === value), style: 'padding:4px 10px' , text: o });
        it.addEventListener('pointermove', () => { lb.querySelectorAll('[data-highlighted]').forEach((x) => x.removeAttribute('data-highlighted')); it.setAttribute('data-highlighted', ''); it.focus(); });
        it.addEventListener('pointerup', () => { if (Date.now() - openedAt > 120) pick(o); });
        lb.append(it);
      });
      lb.addEventListener('keydown', (e) => {
        const items = [...lb.children]; let i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { i = Math.min(items.length - 1, i + 1); }
        else if (e.key === 'ArrowUp') { i = Math.max(0, i - 1); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (i >= 0) pick(options[i]); return; }
        else if (e.key === 'Escape') { close(); trig.focus(); return; }
        else return;
        e.preventDefault();
        items.forEach((x) => x.removeAttribute('data-highlighted')); items[i].setAttribute('data-highlighted', ''); items[i].focus();
      });
      document.body.append(lb);
      trig.setAttribute('aria-expanded', 'true'); trig.dataset.state = 'open';
      const first = lb.children[Math.max(0, options.indexOf(value))]; first.setAttribute('data-highlighted', ''); first.focus();
    };
    trig.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); lb ? close() : open(); } });
    trig.addEventListener('keydown', (e) => { if (['Enter', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); open(); } });
    document.addEventListener('pointerdown', (e) => { if (lb && !lb.contains(e.target) && e.target !== trig && !trig.contains(e.target)) close(); });
    return { el: fx.h('div', { class: 'row' }, lab, trig), get value() { return value; } };
  },
  seg(name, options, value, onChange) {
    const g = fx.h('div', { role: 'radiogroup', 'aria-label': name, class: 'seg' });
    const draw = () => { g.innerHTML = ''; options.forEach((o) => g.append(fx.h('button', { type: 'button', role: 'radio', 'aria-checked': String(o === value), 'data-state': o === value ? 'on' : 'off', text: o, onclick: () => { value = o; draw(); onChange && onChange(o); } }))); };
    draw();
    return { el: g, get value() { return value; } };
  },
};`;

const CSS = `body{font:14px system-ui;margin:20px}.dlg{position:fixed;top:40px;left:40px;right:40px;background:#fff;border:2px solid #333;padding:16px;z-index:10}
.row{margin:6px 0;display:flex;gap:8px;align-items:center}.seg button[aria-checked=true]{background:#333;color:#fff}table td{padding:4px 8px;border:1px solid #ccc}
.side{position:fixed;right:0;top:0;width:320px;height:100%;border-left:1px solid #ccc;padding:8px;background:#fafafa}.chip{border:1px solid #888;border-radius:10px;padding:2px 6px;margin:2px}`;

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style><script src="/fx.js"></script></head><body>${body}</body></html>`;

// ---------------------------------------------------------------- platform
const TUNNELS = page('Tunnels', `<h1>Tunnels</h1><button id="ct">Create tunnel</button><table><tbody id="rows"></tbody></table>
<script>
async function draw(){ const ts = await fx.api('tunnels'); rows.innerHTML=''; for (const t of ts) rows.append(fx.h('tr',{},fx.h('td',{text:t.name}),fx.h('td',{text:t.id}),fx.h('td',{text:t.workspaces.join(', ')||'—'}))); }
ct.onclick = () => {
  // Mirrors the real Platform dialog (2026-10): Name* + Description* required,
  // Create disabled until valid; the workspaces field is a button that opens a
  // popover [role=dialog] with a search combobox and toggling [role=option]s;
  // a click elsewhere in the main dialog closes it; Escape does not.
  const name = fx.h('input', { id: 'tn', placeholder: 'e.g. West Coast MCP tunnel' });
  const desc = fx.h('textarea', { id: 'td', placeholder: 'Add a short description to help your team.' });
  const picked = [];
  const PH = 'Search workspaces by name or ID';
  const trigger = fx.h('span', { role: 'button', 'aria-expanded': 'false', text: PH });
  const create = fx.h('button', { text: 'Create', disabled: true, 'aria-disabled': 'true' });
  const sync = () => {
    const ok = !!(name.value && desc.value && picked.length);
    create.disabled = !ok; create.setAttribute('aria-disabled', String(!ok));
    trigger.textContent = picked.length ? picked.join(', ') : PH;
  };
  name.addEventListener('input', sync); desc.addEventListener('input', sync);
  let pop = null;
  const closePop = () => { if (pop) { pop.remove(); pop = null; trigger.setAttribute('aria-expanded', 'false'); sync(); } };
  trigger.addEventListener('click', async () => {
    if (pop) return closePop();
    const search = fx.h('input', { role: 'combobox', placeholder: PH, 'aria-expanded': 'true' });
    const list = fx.h('div', {});
    const show = async () => {
      list.innerHTML = '';
      for (const w of (await fx.api('workspaces')).filter((x) => x.toLowerCase().includes(search.value.toLowerCase()))) {
        const o = fx.h('div', { role: 'option', 'aria-selected': String(picked.includes(w)), text: w });
        o.addEventListener('click', () => { const i = picked.indexOf(w); if (i < 0) picked.push(w); else picked.splice(i, 1); o.setAttribute('aria-selected', String(picked.includes(w))); });
        list.append(o);
      }
    };
    search.addEventListener('input', show);
    const r = trigger.getBoundingClientRect();
    pop = fx.h('div', { role: 'dialog', style: 'position:fixed;left:' + r.left + 'px;top:' + (r.bottom + 4) + 'px;background:#fff;border:1px solid #999;z-index:1000' }, search, list);
    document.body.append(pop); trigger.setAttribute('aria-expanded', 'true');
    await show(); search.focus();
  });
  const d = fx.dialog('Create tunnel',
    fx.h('div',{class:'row'}, fx.h('label', { for: 'tn', text: 'Name *' }), name),
    fx.h('div',{class:'row'}, fx.h('label', { for: 'td', text: 'Description *' }), desc),
    fx.h('div',{class:'row'}, fx.h('label', { text: 'ChatGPT workspaces' }), trigger),
    fx.h('button', { text: 'Cancel', onclick: () => { closePop(); d.remove(); } }),
    create);
  create.addEventListener('click', async () => { if (create.disabled) return; await fx.api('tunnels', { name: name.value, workspaces: picked }); d.remove(); draw(); });
  document.addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target) && e.target !== trigger) closePop(); }, true);
};
draw();
</script>`);

const KEYS = page('API keys', `<h1>API keys</h1><button id="ck">+ Create new secret key</button><table><tbody id="rows"></tbody></table>
<script>
async function draw(){ const ks = await fx.api('keys'); rows.innerHTML=''; for (const k of ks) rows.append(fx.h('tr',{},fx.h('td',{text:k.name}),fx.h('td',{text:k.masked}),fx.h('td',{text:k.restricted?'Restricted':'All'}),fx.h('td',{text:k.expiry}))); }
ck.onclick = async () => {
  // Mirrors the real Platform dialog (2026-10). Fields are label + trigger
  // span[role=button][aria-expanded] opening a portaled [role=dialog] list of
  // [role=option]; project/expiry single-select (expiry disabled until a
  // project is set); per-resource permissions multi-select, Tunnels: Read/Use
  // (Use ticks Read; trigger then says "All selected"). The name input is
  // re-created by the first keystroke, like a React remount.
  const cfg = await fx.api('config');
  let name = fx.h('input', { id: 'kn', placeholder: 'My Test Key' });
  name.addEventListener('input', function remount() { const n2 = fx.h('input', { id: 'kn', placeholder: 'My Test Key' }); n2.value = name.value; name.replaceWith(n2); name = n2; n2.focus(); }, { once: true });
  let pop = null;
  const closePop = () => { if (pop) { pop.el.remove(); pop.trig.setAttribute('aria-expanded', 'false'); pop = null; sync(); } };
  document.addEventListener('pointerdown', (e) => { if (pop && !pop.el.contains(e.target) && !pop.trig.contains(e.target)) closePop(); }, true);
  const field = (placeholder, options, { multi = false, disabled = false, onPick, show } = {}) => {
    const f = { value: multi ? [] : null, disabled };
    const trig = fx.h('span', { role: 'button', 'aria-expanded': 'false', 'aria-disabled': String(disabled), text: placeholder });
    f.trig = trig;
    f.render = () => { trig.textContent = show ? show(f.value) : (f.value || placeholder); trig.setAttribute('aria-disabled', String(f.disabled)); };
    trig.addEventListener('click', () => {
      if (f.disabled) return;
      if (pop && pop.trig === trig) return closePop();
      closePop();
      const r = trig.getBoundingClientRect();
      const el = fx.h('div', { role: 'dialog', style: 'position:fixed;left:' + r.left + 'px;top:' + (r.bottom + 4) + 'px;background:#fff;border:1px solid #999;z-index:1000' });
      const lb = fx.h('div', { role: 'listbox' }); el.append(lb);
      const draw = () => { lb.innerHTML = ''; for (const o of options) { const sel = multi ? f.value.includes(o) : f.value === o; lb.append(fx.h('div', { role: 'option', 'aria-selected': String(sel), text: o, onclick: () => {
        if (multi) { const i = f.value.indexOf(o); if (i < 0) f.value.push(o); else f.value.splice(i, 1); onPick && onPick(o, f); draw(); f.render(); }
        else { f.value = o; f.render(); closePop(); onPick && onPick(o, f); }
      } })); } };
      draw(); document.body.append(el); trig.setAttribute('aria-expanded', 'true'); pop = { el, trig };
    });
    return f;
  };
  const project = field('Select project...', ['Default project'], { onPick: () => { exp.disabled = false; exp.render(); } });
  const exp = field('有效期 选择有效期', cfg.fail.includes('key-expiry-label') ? ['1 周', '1 个月', '永不过期'] : ['1 天', '7 天', '30 天', '永不过期', '自定义'], { disabled: true });
  exp.render = ((r) => () => { r(); if (exp.value) exp.trig.textContent = '有效期 ' + exp.value; })(exp.render);
  const showPerm = (all) => (v) => (!v.length ? 'None' : v.length === all.length ? 'All selected' : v.join(', '));
  const perms = {}; const permBox = fx.h('div', { style: 'display:none' });
  for (const r of ['Models', 'Assistants', 'Tunnels']) {
    const options = r === 'Tunnels' ? ['Read', 'Use'] : ['Read', 'Write'];
    perms[r] = field('None', options, { multi: true, show: showPerm(options), onPick: (o, f) => { if (r === 'Tunnels' && o === 'Use' && f.value.includes('Use') && !f.value.includes('Read')) f.value.push('Read'); } });
    permBox.append(fx.h('div', { class: 'row' }, fx.h('button', { text: r, disabled: true }), perms[r].trig));
  }
  const footer = fx.h('div', {});
  const mode = fx.seg('Permissions', ['All', 'Restricted', 'Read only'], 'All', (v) => { permBox.style.display = v === 'Restricted' ? '' : 'none'; sync(); });
  const create = fx.h('button', { text: 'Create secret key', disabled: true, 'aria-disabled': 'true' });
  const count = () => Object.values(perms).reduce((n, p) => n + p.value.length, 0);
  function sync() {
    footer.textContent = count() + ' selected permissions';
    const ok = !!(project.value && exp.value && (mode.value !== 'Restricted' || count()));
    create.disabled = !ok; create.setAttribute('aria-disabled', String(!ok));
  }
  const permValue = (r) => { const v = perms[r].value; if (!v.length) return 'None'; if (r === 'Tunnels') return v.includes('Use') ? 'Read + Use' : 'Read'; return v.includes('Write') ? 'Write' : 'Read'; };
  create.addEventListener('click', async () => {
    if (create.disabled) return;
    const r = await fx.api('keys', { name: name.value, restricted: mode.value === 'Restricted', perms: Object.fromEntries(Object.keys(perms).map((k) => [k, permValue(k)])), expiry: (exp.value || '').replace(/ 天$/, ' days'), project: project.value });
    closePop(); d.remove();
    const inp = fx.h('input', { readonly: true, value: r.key, style: 'width:420px' });
    const d2 = fx.dialog('Save your key', fx.h('p', { text: 'Please save this secret key somewhere safe.' }), inp, fx.h('button', { text: 'Copy' }), fx.h('button', { text: 'Done', onclick: () => { d2.remove(); draw(); } }));
  });
  const d = fx.dialog('Create new secret key',
    fx.h('div', { class: 'row' }, fx.h('label', { for: 'kn', text: 'Name Optional' }), name),
    fx.h('div', { class: 'row' }, fx.h('label', { text: 'Project' }), project.trig),
    fx.h('div', { class: 'row' }, fx.h('label', { text: '有效期' }), exp.trig),
    fx.h('div', { class: 'row' }, fx.h('span', { text: 'Permissions' }), mode.el), permBox, footer,
    fx.h('button', { text: 'Cancel', onclick: () => { closePop(); d.remove(); } }), create);
  sync();
};
draw();
</script>`);

// ---------------------------------------------------------------- muse (zh)
const MUSE = page('Muse', `<button id="nc">新对话</button><div id="log" style="margin-right:340px"></div>
<div class="side"><button id="badge" style="display:none">需要审核</button><div id="panel" style="display:none"></div></div>
<div style="position:fixed;bottom:10px;left:20px;right:340px"><div id="att"></div>
<textarea id="ta" placeholder="给 Muse 发消息" rows="4" style="width:100%"></textarea>
<button id="attach" aria-label="添加附件">📎</button><button id="send" aria-label="发送">↑</button></div>
<script>
let files = []; let shown = 0; let drawn = '';
nc.onclick = () => { log.innerHTML = ''; history.replaceState(null, '', '/muse/'); };
attach.onclick = () => {
  const inp = fx.h('input', { type: 'file', style: 'display:none' });
  inp.onchange = () => { files = [...inp.files].map((f) => f.name); att.innerHTML = ''; files.forEach((n) => att.append(fx.h('span', { class: 'chip', text: n }))); };
  document.body.append(inp); inp.click();
};
send.onclick = async () => {
  if (!ta.value.trim()) return;
  const r = await fx.api('muse/send', { text: ta.value, files });
  log.append(fx.h('div', { class: 'user', text: ta.value })); ta.value = ''; files = []; att.innerHTML = '';
  if (!location.pathname.includes('/chat/')) history.replaceState(null, '', '/muse/chat/' + r.chat);
};
badge.onclick = () => { panel.style.display = panel.style.display === 'none' ? '' : 'none'; };
function card(id, site) {
  const menu = fx.h('div', { role: 'menu', style: 'display:none' },
    fx.h('div', { role: 'menuitem', text: '总是允许此站点', onclick: () => decide(id, 'always-site') }),
    fx.h('div', { role: 'menuitem', text: '拒绝', onclick: () => decide(id, 'deny') }));
  return fx.h('div', { class: 'card', 'data-card': id }, fx.h('p', { text: '允许 Muse 与 ' + site + ' 分享信息' }),
    fx.h('button', { text: '允许一次', onclick: () => decide(id, 'once') }),
    fx.h('button', { 'aria-label': '更多允许选项', text: '▾', onclick: () => { menu.style.display = ''; } }), menu);
}
async function decide(id, how) { await fx.api('muse/approve', { id, how }); }
setInterval(async () => {
  const st = await fx.api('muse/state');
  const pend = st.cards.filter((c) => !c.decided);
  badge.style.display = pend.length ? '' : 'none';
  const key = pend.map((c) => c.id).join(',');
  if (key !== drawn) { drawn = key; panel.innerHTML = ''; pend.forEach((c) => panel.append(card(c.id, c.site))); }
  for (; shown < st.replies.length; shown++) log.append(fx.h('div', { class: 'agent' }, fx.h('pre', { text: st.replies[shown] })));
}, 400);
</script>`);

// ---------------------------------------------------------------- chatgpt (en)
const PLUGINS = page('Plugins', `<h1>Plugins</h1><button id="add">Add</button><div id="menu" role="menu" style="display:none">
<div role="menuitem" id="custom">Add custom MCP server</div><div role="menuitem">Browse plugins</div></div><h3>Installed</h3><div id="inst"></div>
<script>
async function draw(){ const ps = await fx.api('plugins/list'); inst.innerHTML=''; ps.forEach((p) => inst.append(fx.h('div',{}, fx.h('a', { href: '/chatgpt/plugins/' + p.id, text: p.name })))); }
add.onclick = () => { menu.style.display = ''; };
custom.onclick = async () => {
  menu.style.display = 'none';
  const name = fx.h('input', { id: 'pn' });
  const chips = fx.h('div', { style: 'display:none' }); const tid = fx.h('input', { readonly: true, 'aria-label': 'Tunnel ID', placeholder: 'tunnel_…' });
  const conn = fx.seg('Connection', ['URL', 'Tunnel'], 'URL', async (v) => {
    chips.style.display = v === 'Tunnel' ? '' : 'none'; chips.innerHTML = '';
    for (const t of await fx.api('plugins/tunnels')) chips.append(fx.h('button', { type: 'button', 'aria-pressed': 'false', text: t.name, onclick: (e) => { chips.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); tid.value = t.id; } }));
  });
  const auth = fx.select({ label: 'Authentication', options: ['OAuth', 'No authentication'], value: 'OAuth' });
  const ok = fx.h('input', { type: 'checkbox', id: 'und' });
  const err = fx.h('p', { role: 'alert' });
  const d = fx.dialog('Add custom MCP server', fx.h('div', { class: 'row' }, fx.h('label', { for: 'pn', text: 'Name' }), name), fx.h('div', { class: 'row' }, fx.h('span', { text: 'Connection' }), conn.el), chips, tid, auth.el,
    fx.h('label', {}, ok, ' I understand and want to continue'), err,
    fx.h('button', { text: 'Create', onclick: async () => {
      const r = await fx.api('plugins', { name: name.value, tunnel_id: tid.value, auth: auth.value, understood: ok.checked });
      if (r.error) { err.textContent = r.error; return; }
      d.remove();
      const c = fx.dialog('Connect', fx.h('p', { text: 'Allow ChatGPT to use ' + r.name + '?' }), fx.h('button', { text: 'Connect ' + r.name, onclick: async () => { await fx.api('plugins/connect', { id: r.id }); c.remove(); draw(); } }));
    } }));
};
draw();
</script>`);

const PLUGIN = (p) => page(p.name, `<h1>${p.name}</h1><p>${p.connected ? 'Connected' : ''}</p>${p.connected ? '' : `<button onclick="fx.api('plugins/connect',{id:'${p.id}'}).then(()=>location.reload())">Connect</button>`}`);

const CHAT = page('ChatGPT', `<div id="log"></div><div id="prompt-textarea" contenteditable="true" style="border:1px solid #999;min-height:40px"></div>
<button data-testid="send-button" aria-label="Send prompt">Send</button>
<script>
document.querySelector('[data-testid=send-button]').onclick = async () => {
  const ed = document.getElementById('prompt-textarea'); const text = ed.innerText.trim(); if (!text) return;
  ed.innerHTML = '';
  log.append(fx.h('div', { 'data-message-author-role': 'user', text }));
  const r = await fx.api('chat/send', { text });
  const answer = async () => { const a = await fx.api('chat/answer', { id: r.id }); log.append(fx.h('div', { 'data-message-author-role': 'assistant', text: a.text })); };
  if (!r.needsApproval) { setTimeout(answer, 500); return; }
  const card = fx.h('div', { class: 'tool' }, fx.h('p', { text: r.plugin + ' wants to use muse_vm_exec' }),
    fx.h('button', { text: 'Always allow', onclick: async () => { await fx.api('chat/approve', { id: r.id, how: 'always' }); card.remove(); answer(); } }),
    fx.h('button', { text: 'Allow', onclick: async () => { await fx.api('chat/approve', { id: r.id, how: 'once' }); card.remove(); answer(); } }),
    fx.h('button', { text: 'Deny', onclick: () => card.remove() }));
  setTimeout(() => log.append(card), 600);
};
</script>`);

// ---------------------------------------------------------------- api
const rid = (p) => p + crypto.randomBytes(8).toString('hex');
function api(p, b) {
  switch (p) {
    case 'counts': return { tunnels: S.tunnels.length, keys: S.keys.length, plugins: S.plugins.length, muse_installs: S.muse.installs, muse_messages: S.muse.messages.length,
      muse_approvals: S.muse.approvals, foreign_clicked: S.muse.foreignClicked, secrets_in_messages: S.muse.secretsSeen, tool_calls: S.chat.toolCalls, chat_approvals: S.chat.approvals,
      last_key: S.keys.at(-1) && { name: S.keys.at(-1).name, restricted: S.keys.at(-1).restricted, perms: S.keys.at(-1).perms, expiry: S.keys.at(-1).expiry },
      tunnel_workspaces: S.tunnels.map((t) => t.workspaces), plugin_state: S.plugins.map((x) => ({ name: x.name, tunnel_id: x.tunnel_id, auth: x.auth, connected: x.connected })),
      attachments: S.muse.messages.flatMap((m) => m.files) };
    case 'reset': reset(b?.fail || []); return { ok: true };
    case 'config': return { fail: [...S.fail] };
    case 'workspaces': return S.workspaces;
    case 'tunnels': if (b) { const t = { name: b.name, id: rid('tunnel_'), workspaces: b.workspaces || [] }; S.tunnels.push(t); return t; } return S.tunnels;
    case 'keys': if (b) { const key = 'sk-proj-' + crypto.randomBytes(24).toString('hex'); const k = { ...b, key, masked: 'sk-...' + key.slice(-4) }; S.keys.push(k); return { key }; }
      return S.keys.map(({ key, ...k }) => k);
    case 'keys/value': return { key: S.keys.find((k) => k.name === b.name)?.key };
    case 'plugins/tunnels': return S.tunnels.filter((t) => t.workspaces.includes('Acme Team'));
    case 'plugins/list':
      if (S.listHide && S.plugins.length) { S.listHide--; return []; } // slow list right after creation
      return S.plugins;
    case 'plugins': {
      if (!b.understood) return { error: 'Please confirm you understand the risks' };
      if (S.plugins.some((x) => x.name === b.name)) return { error: 'An app with this name already exists' };
      const x = { id: rid('plugin_'), name: b.name, tunnel_id: b.tunnel_id, auth: b.auth, connected: false }; S.plugins.push(x); return x;
    }
    case 'plugins/connect': { const x = S.plugins.find((y) => y.id === b.id); if (x) x.connected = true; return { ok: true }; }
    case 'muse/send': {
      S.muse.messages.push({ text: b.text, files: b.files || [] });
      if (/sk-[A-Za-z0-9]{10,}/.test(b.text)) S.muse.secretsSeen++;
      S.muse.chat ||= rid('c');
      if (b.text.includes('install.sh')) {
        S.muse.installs++;
        setTimeout(() => S.muse.cards.push({ id: 'ours', site: 'api.openai.com' }, { id: 'foreign', site: 'example.com' }), 800);
      } else if (b.text.includes('restore.sh')) setTimeout(() => S.muse.replies.push(report('OK')), 800);
      else if (b.text.includes('dispatcher forwarded')) {
        const id = S.tunnels.at(-1)?.id;
        setTimeout(() => S.muse.replies.push([1, 2].map((i) => `time=2026-10-21T10:00:0${i}Z level=INFO msg="dispatcher forwarded command to MCP server" tunnel_id=${id} cmd_request_id=r${i}`).join('\n') +
          '\n2026-10-21T10:00:01.1Z rpc method=tools/call tool=muse_vm_exec\n2026-10-21T10:00:02.1Z rpc method=tools/call tool=muse_vm_exec'), 800);
      }
      return { chat: S.muse.chat };
    }
    case 'muse/state': return { cards: S.muse.cards, replies: S.muse.replies };
    case 'muse/approve': {
      const c = S.muse.cards.find((x) => x.id === b.id); if (!c) return {};
      c.decided = b.how;
      if (c.id === 'foreign') S.muse.foreignClicked = true;
      else { S.muse.approvals.push(b.how); setTimeout(() => S.muse.replies.push(report(b.how === 'always-site' ? 'OK' : 'PENDING')), 600); }
      return { ok: true };
    }
    case 'chat/send': {
      const plugin = S.plugins.find((x) => b.text.includes(`"${x.name}"`) && x.connected);
      const tok = /echo_token (\S+?)\./.exec(b.text)?.[1];
      const id = rid('m'); S.chat[id] = { plugin, tok };
      return { id, plugin: plugin?.name, needsApproval: !!plugin && !S.chat.always };
    }
    case 'chat/approve': S.chat.approvals.push(b.how); if (b.how === 'always') S.chat.always = true; return { ok: true };
    case 'chat/answer': {
      const m = S.chat[b.id];
      if (!m.plugin) return { text: 'I do not have access to that app.' };
      S.chat.toolCalls++;
      return { text: JSON.stringify({ hostname: 'fixture-vm', utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), echo_token: m.tok, exit_code: 0 }) };
    }
  }
  return { error: 'unknown api ' + p };
}
function report(v) {
  return `---------------- report ----------------\ndir            : /root/muse-chatgpt\nmode           : nohup\ntunnel id      : ${S.tunnels.at(-1)?.id}\ncontrol-plane  : ${v}\n----------------------------------------`;
}

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, data) => { res.writeHead(code, { 'content-type': type }); res.end(data); };
    if (u.pathname === '/fx.js') return send(200, 'text/javascript', FX);
    if (u.pathname.startsWith('/api/')) return send(200, 'application/json', JSON.stringify(api(u.pathname.slice(5), body ? JSON.parse(body) : null)));
    if (u.pathname === '/platform/settings/organization/tunnels') return send(200, 'text/html', TUNNELS);
    if (u.pathname === '/platform/settings/organization/api-keys') return send(200, 'text/html', KEYS);
    if (u.pathname.startsWith('/muse')) return send(200, 'text/html', MUSE);
    if (u.pathname === '/chatgpt/plugins') return send(200, 'text/html', PLUGINS);
    const pm = /^\/chatgpt\/plugins\/(plugin_\w+)$/.exec(u.pathname);
    if (pm) { const p = S.plugins.find((x) => x.id === pm[1]); return p ? send(200, 'text/html', PLUGIN(p)) : send(404, 'text/plain', 'no'); }
    if (u.pathname === '/chatgpt/' || u.pathname === '/chatgpt') return send(200, 'text/html', CHAT);
    send(404, 'text/plain', 'not found');
  });
});
srv.keepAliveTimeout = 600000;
srv.listen(PORT, '127.0.0.1', () => console.log(`fixture on http://127.0.0.1:${PORT}`));
