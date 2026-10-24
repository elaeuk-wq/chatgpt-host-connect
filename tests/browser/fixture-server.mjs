// Offline Platform / ChatGPT pages; host requests are separate local transport calls.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || 8899);
let S;
function reset(fail = []) {
  S = { fail: new Set(fail), tunnels: [], keys: [], plugins: [], pluginCreates: 0, connectCalls: 0, autoConnects: 0, afterCreateVisits: [], host: { installs: 0, statuses: 0, tokens: [], commands: [], config: null },
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
const TUNNELS = page('Tunnels', `<h1>Tunnels</h1><span aria-haspopup="dialog" aria-expanded="false" style="display:inline-block;padding:25px">Create tunnel</span><button id="ct">Create tunnel</button><table><tbody id="rows"></tbody></table>
<script>
async function draw(){ const ts = await fx.api('tunnels'); rows.innerHTML=''; for (const t of ts) rows.append(fx.h('tr',{},fx.h('td',{text:t.name}),fx.h('td',{text:t.id}),fx.h('td',{text:t.workspaces.join(', ')||'—'}))); }
ct.onclick = async () => {
  await fx.api('tunnels/open');
  await new Promise(resolve => setTimeout(resolve, 900));
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
  await fx.api('keys/open');
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
        else {
          const commit = () => { f.value = o; f.render(); onPick && onPick(o, f); };
          closePop();
          if (placeholder === 'Select project...') {
            window.fxProjectClicks=(window.fxProjectClicks||0)+1;
            if (cfg.fail.includes('project-ignored')) return;
            if (cfg.fail.includes('project-delayed-commit')) { setTimeout(commit,900); return; }
          }
          commit();
        }
      } })); } };
      draw(); document.body.append(el); trig.setAttribute('aria-expanded', 'true'); pop = { el, trig };
    });
    return f;
  };
  const project = field('Select project...', ['Default project'], { onPick: () => {
    const unlock = () => { exp.disabled = false; exp.render(); };
    if (cfg.fail.includes('expiry-delayed-unlock')) setTimeout(unlock,1100);
    else if (!cfg.fail.includes('expiry-never-unlocks')) unlock();
  } });
  window.fxExpiryOptions = cfg.fail.includes('key-expiry-label') ? ['1 周', '1 个月', '永不过期'] : ['1 天', '7 天', '30 天', '永不过期', '自定义'];
  const exp = field('有效期 选择有效期', window.fxExpiryOptions, { disabled: true });
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
  const projectRow = fx.h('div', {class:'row'},fx.h('label',{text:'Project'}),project.trig);
  if (cfg.fail.includes('project-delayed-field') || cfg.fail.includes('project-missing-field')) {
    project.trig.remove(); // Label remains: must not match a sibling field by climbing the form.
    if (cfg.fail.includes('project-delayed-field')) setTimeout(()=>projectRow.append(project.trig),1400);
  }
  const d = fx.dialog('Create new secret key',
    fx.h('div', { class: 'row' }, fx.h('label', { for: 'kn', text: 'Name Optional' }), name),
    projectRow,
    fx.h('div', { class: 'row' }, fx.h('label', { text: '有效期' }), exp.trig),
    fx.h('div', { class: 'row' }, fx.h('span', { text: 'Permissions' }), mode.el), permBox, footer,
    fx.h('button', { text: 'Cancel', onclick: () => { closePop(); d.remove(); } }), create);
  sync();
};
draw();
</script>`);

// ---------------------------------------------------------------- muse (zh)
// ---------------------------------------------------------------- chatgpt (en)
const PLUGINS = page('Plugins', `<h1>Plugins</h1><button id="add">Add</button><div id="menu" role="menu" style="display:none">
<div role="menuitem" id="custom">Add custom MCP server</div><div role="menuitem">Browse plugins</div></div><h3>Installed</h3><button id="personal" role="tab" aria-selected="false" style="display:none">个人</button><div id="inst"></div>
<script>
personal.onclick=()=>{personal.setAttribute('aria-selected','true');draw();};
async function draw(){ const cfg=await fx.api('config'); if(cfg.fail.includes('personal-install')){personal.style.display='';if(personal.getAttribute('aria-selected')!=='true'){inst.innerHTML='';return;}} const ps = await fx.api('plugins/list'); inst.innerHTML=''; ps.forEach((p) => inst.append(fx.h('div',{}, fx.h('a', { href: '/chatgpt/plugins/' + p.id, text: p.name })))); }
add.onclick = () => { menu.style.display = ''; };
custom.onclick = async () => {
  menu.style.display = 'none';
  const cfg = await fx.api('config');
  const name = fx.h('input', { id: 'pn' });
  const chips = fx.h('div', { style: 'display:none' }); const tid = fx.h('input', { readonly: true, 'aria-label': 'Tunnel ID', placeholder: 'tunnel_…' });
  const conn = fx.seg('Connection', ['URL', 'Tunnel'], 'URL', async (v) => {
    chips.style.display = v === 'Tunnel' ? '' : 'none'; chips.innerHTML = '';
    for (const t of await fx.api('plugins/tunnels')) chips.append(fx.h('button', { type: 'button', 'aria-pressed': 'false', text: t.name, onclick: (e) => { chips.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); tid.value = t.id; } }));
  });
  const auth = fx.select({ label: 'Authentication', options: ['OAuth', 'No authentication'], value: 'OAuth' });
  const ok = fx.h('input', { type: 'checkbox', id: 'und' });
  const err = fx.h('p', { role: 'alert' });
  const delayed = cfg.fail.includes('delayed-submit');
  const create = fx.h('button', { text: delayed ? '创建为插件' : 'Create', disabled: delayed });
  ok.onchange = () => { if (ok.checked) setTimeout(() => { create.disabled = false; }, 800); };
  const d = fx.dialog('Add custom MCP server', fx.h('div', { class: 'row' }, fx.h('label', { for: 'pn', text: 'Name' }), name), fx.h('div', { class: 'row' }, fx.h('span', { text: 'Connection' }), conn.el), chips, tid, auth.el,
    fx.h('label', {}, ok, delayed ? ' 我理解并希望继续' : ' I understand and want to continue'), err, create);
    create.onclick = async () => {
      create.disabled = true;
      const r = await fx.api('plugins', { name: name.value, tunnel_id: tid.value, auth: auth.value, understood: ok.checked });
      if (r.error) { err.textContent = r.error; create.disabled = false; return; }
      d.append(fx.h('p', { text: '正在创建，请稍候…' }));
      // A list heading / another app's toast must not be mistaken for our success.
      document.body.append(fx.h('span', { role: 'status', text: r.name + '-other 现已连接' }));
      if(cfg.fail.includes('slow-plugin-create')) await new Promise(resolve => setTimeout(resolve, 6000));
      d.remove();
      const confirmed = () => { document.body.append(fx.h('span', { role: 'status', text: r.name + ' 现已连接' })); draw(); };
      if(cfg.fail.includes('auto-connect')) { await fx.api('plugins/connect', { id: r.id, auto: true }); confirmed(); return; }
      const error = fx.h('p', { role: 'alert' });
      const button = fx.h('button', { text: '连接 ' + r.name });
      const c = fx.dialog('连接应用', fx.h('p', { text: r.name }), error, button);
      const connect = async () => {
        await fx.api('plugins/connect', { id: r.id });
        if(cfg.fail.includes('slow-plugin-create')) {
          // React-like replacement with the same enabled button while the response is pending.
          const replacement = button.cloneNode(true); replacement.onclick = connect; button.replaceWith(replacement);
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
        c.remove(); confirmed();
      };
      button.onclick = connect;
      if(cfg.fail.includes('plugin-connection-error')) {
        error.textContent = 'Connection failed'; button.disabled = true;
        const timer = setInterval(async () => {
          if(!(await fx.api('config')).fail.includes('plugin-connection-error')) {
            clearInterval(timer); error.textContent = ''; button.disabled = false;
          }
        }, 200);
      }
    };
};
draw();
</script>`);

const PLUGIN = (p) => page(p.name, `<h1>${p.name}</h1><p>${p.connected ? 'Connected' : ''}</p>${p.connected ? '' : `<button onclick="fx.api('plugins/connect',{id:'${p.id}'}).then(()=>location.reload())">${S.fail.has('personal-install') ? '安装 '+p.name : 'Connect'}</button>`}`);

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
  const cfg=await fx.api('config');
  const localized = cfg.fail.includes('localized-approval');
  const card = fx.h(localized ? 'form' : 'div', { class: 'tool' }, fx.h('p', { text: localized ? r.plugin + ' 允许 ChatGPT 使用 ' + r.plugin + '？ 在未沙盒化的服务登录用户环境中执行 Python 命令，验证主机并创建验收标记文件。' : r.plugin + ' wants to use execute_terminal' }),
    fx.h('button', { text: cfg.fail.includes('allow-once') ? 'Disabled option' : 'Always allow', onclick: async () => { await fx.api('chat/approve', { id: r.id, how: 'always' }); card.remove(); answer(); } }),
    fx.h('button', { text: cfg.fail.includes('allow-once') ? '允许一次 ⏎' : 'Allow', onclick: async () => {
      await fx.api('chat/clicked');
      if (cfg.fail.includes('ignored-approval')) return;
      await fx.api('chat/approve', { id: r.id, how: 'once' }); card.remove(); answer();
    } }),
    fx.h('button', { text: 'Deny', onclick: () => card.remove() }));
  card.addEventListener('submit', e => e.preventDefault());
  const args = JSON.stringify({path:'/asdk_app_fixture/link_fixture/execute_terminal',args:{command:r.command,timeout:20}});
  if (localized) {
    const details = fx.h('button', {type:'button',text:'查看详情',onclick:async()=>{
      await fx.api('chat/details');
      const dialog=fx.dialog('Tool details',fx.h('pre',{text:args}));
      dialog.append(fx.h('button',{type:'button',text:'关闭',onclick:()=>dialog.remove()}));
    }});
    card.append(details);
  } else card.append(fx.h('pre',{text:args}));
  if (cfg.fail.includes('nested-approval')) {
    const header = card.firstElementChild; header.remove();
    const group = fx.h('div', {}, fx.h('p', { text: 'Review this command before allowing it to run on the selected computer.' }));
    while (card.firstChild) group.append(card.firstChild);
    card.append(fx.h('p', { text: 'Additional context. '.repeat(30) }), header, group);
    const foreign = fx.h('div', { class: 'tool' }, fx.h('p', { text: r.plugin + '-other wants to use execute_terminal' }),
      fx.h('button', { text: 'Allow', onclick: () => fx.api('chat/approve', { id: r.id, how: 'foreign' }) }));
    log.append(foreign);
  }
  setTimeout(() => {
    if (cfg.fail.includes('ambiguous-approval')) log.append(card.cloneNode(true));
    log.append(card);
  }, 600);
};
</script>`);

// ---------------------------------------------------------------- api
const rid = (p) => p + crypto.randomBytes(16).toString('hex');
function api(p, b) {
  switch (p) {
    case 'counts': return { tunnels: S.tunnels.length, keys: S.keys.length, plugins: S.plugins.length,
      tunnel_opens: S.tunnelOpens || 0, key_opens:S.keyOpens||0, tunnel_visits:S.tunnelVisits||0, detail_opens: S.detailOpens || 0, plugin_creates: S.pluginCreates, connect_calls: S.connectCalls, auto_connects: S.autoConnects, after_create_visits: S.afterCreateVisits,
      host_installs: S.host.installs, host_statuses: S.host.statuses, approval_clicks:S.chat.clicks||0, tool_calls: S.chat.toolCalls, chat_approvals: S.chat.approvals, chat_submissions: Object.values(S.chat).filter(x=>x?.command).length,
      last_key: S.keys.at(-1) && { name: S.keys.at(-1).name, project:S.keys.at(-1).project, restricted: S.keys.at(-1).restricted, perms: S.keys.at(-1).perms, expiry: S.keys.at(-1).expiry },
      tunnel_workspaces: S.tunnels.map(t => t.workspaces), plugin_state: S.plugins.map(x => ({name:x.name,tunnel_id:x.tunnel_id,auth:x.auth,connected:x.connected})) };
    case 'host': {
      if (b.action === 'install') {
        S.host.installs++;
        S.host.config = {ok:true,installed:true,host_id:'fixture-host-id',hostname:'fixture-host',root:'/fixture/host',tunnel_id:b.tunnel_id,control_plane:S.fail.has('delayed-poll') ? 'PENDING' : 'OK'};
        return S.host.config;
      }
      if (b.action === 'status') {
        S.host.statuses++;
        if (S.host.config && S.host.statuses >= 3 && !S.fail.has('never-ready')) S.host.config.control_plane = 'OK';
        return S.host.config || {ok:false,error:'not installed'};
      }
      if (b.action === 'verify') {
        const shell_ok=S.host.commands.includes(b.command_hash) && !S.fail.has('missing-host-proof');
        const file_ok=S.host.tokens.includes(b.token);
        return {ok:true,verified:shell_ok && file_ok,shell_ok,file_ok,host_id:S.fail.has('wrong-host')?'wrong-host':'fixture-host-id',hostname:'fixture-host',tunnel_id:S.host.config.tunnel_id,token:b.token,verification_version:2};
      }
      return {ok:true,hostname:'fixture-host'};
    }
    case 'reset': reset(b?.fail || []); return { ok: true };
    case 'config': return { fail: [...S.fail] };
    case 'config/clear-failure': S.fail.delete(b.name); return {ok:true};
    case 'config/add-failure': S.fail.add(b.name); return {ok:true};
    case 'workspaces': return S.workspaces;
    case 'keys/open': S.keyOpens=(S.keyOpens||0)+1; return {ok:true};
    case 'tunnels/open': S.tunnelOpens=(S.tunnelOpens||0)+1; return {ok:true};
    case 'chat/details': S.detailOpens=(S.detailOpens||0)+1; return {ok:true};
    case 'tunnels': if (b) { const t = { name: b.name, id: rid('tunnel_'), workspaces: b.workspaces || [] }; S.tunnels.push(t); return t; } return S.tunnels;
    case 'keys': if (b) { const key = 'sk-proj-' + crypto.randomBytes(24).toString('hex'); const k = { ...b, key, masked: 'sk-...' + key.slice(-4) }; S.keys.push(k); return { key }; }
      return S.keys.map(({ key, ...k }) => k);
    case 'keys/value': return { key: S.keys.find((k) => k.name === b.name)?.key };
    case 'plugins/tunnels': return S.tunnels.filter((t) => t.workspaces.includes('Acme Team'));
    case 'plugins/list':
      if (S.listHide && S.plugins.length) { S.listHide--; return []; } // slow list right after creation
      return S.plugins;
    case 'plugins': {
      S.pluginCreates++;
      if (!b.understood) return { error: 'Please confirm you understand the risks' };
      if (S.plugins.some((x) => x.name === b.name)) return { error: 'An app with this name already exists' };
      const x = { id: rid('plugin_'), name: b.name, tunnel_id: b.tunnel_id, auth: b.auth, connected: false }; S.plugins.push(x); return x;
    }
    case 'plugins/connect': { if (b.auto) S.autoConnects++; else S.connectCalls++; const x = S.plugins.find((y) => y.id === b.id); if (x) x.connected = true; return { ok: true }; }
    case 'chat/send': {
      const plugin = S.plugins.find((x) => b.text.includes(`"${x.name}"`) && x.connected);
      let command='';
      try{command=JSON.parse(/argument object, unchanged: ([\s\S]*?)\. It checks/.exec(b.text)?.[1] || '{}').command || '';}catch{}
      const tok=/hcs-[a-f0-9]{16}/.exec(command)?.[0];
      const id = rid('m'); S.chat[id] = { plugin, tok, command };
      return { id, command, plugin: plugin?.name, needsApproval: !!plugin && !S.chat.always };
    }
    case 'chat/clicked': S.chat.clicks=(S.chat.clicks||0)+1; return {ok:true};
    case 'chat/approve': S.chat.approvals.push(b.how); if (b.how === 'always') S.chat.always = true; return { ok: true };
    case 'chat/answer': {
      const m = S.chat[b.id];
      if (!m.plugin) return { text: 'I do not have access to that app.' };
      S.chat.toolCalls++;
      S.host.tokens.push(m.tok);
      S.host.commands.push(crypto.createHash('sha256').update(m.command).digest('hex'));
      if(S.fail.has('empty-answer'))return {text:'{}'};
      return { text: JSON.stringify({ hostname: 'fixture-host', host_id: S.fail.has('wrong-host') ? 'wrong-host' : 'fixture-host-id', utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), echo_token: m.tok, exit_code: 0 }) };
    }
  }
  return { error: 'unknown api ' + p };
}
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, data) => { res.writeHead(code, { 'content-type': type }); res.end(data); };
    if (u.pathname === '/fx.js') return send(200, 'text/javascript', FX);
    if (u.pathname.startsWith('/api/')) return send(200, 'application/json', JSON.stringify(api(u.pathname.slice(5), body ? JSON.parse(body) : null)));
    if (S.plugins.length && (u.pathname.startsWith('/platform/') || u.pathname.startsWith('/chatgpt/plugins'))) S.afterCreateVisits.push(u.pathname);
    if (u.pathname === '/blocked-script.js') return send(403,'text/plain','Denied');
    if (u.pathname === '/platform/login') return send(200,'text/html',page('Login','<h1>Log in</h1>'));
    if (u.pathname === '/platform/settings/organization/tunnels') {
      S.tunnelVisits=(S.tunnelVisits||0)+1;
      if(S.fail.has('login-required')) {res.writeHead(302,{Location:'/platform/login'});return res.end();}
      if(S.fail.has('blank-denied')) return send(200,'text/html','<!doctype html><html><body><script src="/blocked-script.js"></script></body></html>');
      if(S.fail.has('denied-nonblank')) return send(200,'text/html','<!doctype html><html><body><h1>Loading Tunnels</h1><script src="/blocked-script.js"></script></body></html>');
      if(S.fail.has('denied-delayed-ready') || S.fail.has('denied-disabled')) {
        const unlock=S.fail.has('denied-delayed-ready') ? 'setTimeout(()=>{ct.disabled=false;},1800);' : '';
        return send(200,'text/html',TUNNELS+'<script>ct.disabled=true;'+unlock+'</script><script src="/blocked-script.js"></script>');
      }
      if(S.fail.has('blank-always') || S.fail.has('blank-once') && S.tunnelVisits===1) return send(200,'text/html','<!doctype html><html><body></body></html>');
      if(S.fail.has('frozen-entry') || S.fail.has('frozen-once') && S.tunnelVisits===1) return send(200,'text/html',TUNNELS+'<style>body{opacity:0}</style><script>window.requestAnimationFrame=()=>0</script>');
      return send(200, 'text/html', TUNNELS);
    }
    if (u.pathname === '/platform/settings/organization/api-keys') return send(200, 'text/html', KEYS);
    if (u.pathname === '/chatgpt/plugins') return send(200, 'text/html', PLUGINS);
    const pm = /^\/chatgpt\/plugins\/(plugin_\w+)$/.exec(u.pathname);
    if (pm) { const p = S.plugins.find((x) => x.id === pm[1]); return p ? send(200, 'text/html', PLUGIN(p)) : send(404, 'text/plain', 'no'); }
    if (u.pathname === '/chatgpt/' || u.pathname === '/chatgpt') return send(200, 'text/html', CHAT);
    send(404, 'text/plain', 'not found');
  });
});
srv.keepAliveTimeout = 600000;
srv.listen(PORT, '127.0.0.1', () => console.log(`fixture on http://127.0.0.1:${PORT}`));
