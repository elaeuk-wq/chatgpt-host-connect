#!/usr/bin/env node
// Offline end-to-end test of host-connect.mjs against local fixture pages, in a
// throwaway headless Chrome (temporary profile; never the user's browser).
//   node tests/browser/test-browser.mjs [work-dir]      CHROME=/path/to/chrome to override
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect } from '../../skills/chatgpt-host-connect/scripts/browser/cdp.mjs';
import { privateDir, privateFileOk } from '../../skills/chatgpt-host-connect/scripts/browser/platform.mjs';
import { LABELS } from '../../skills/chatgpt-host-connect/scripts/browser/labels.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '../../skills/chatgpt-host-connect/scripts/browser/host-connect.mjs');
let WORK = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'host-browser-test-'));
fs.mkdirSync(WORK, { recursive: true });
WORK = fs.realpathSync(WORK);
for (const d of ['A', 'B']) fs.rmSync(path.join(WORK, d), { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const CHROME = process.env.CHROME || [
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files','Google/Chrome/Application/chrome.exe'),
  path.join(process.env.LOCALAPPDATA || os.homedir(),'Google/Chrome/Application/chrome.exe'),
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
  const r = spawnSync(process.execPath, [CLI, '--allow-control', ...args, '--target', 'local', '--host-name', 'fixture', '--state', stateFile, '--cdp', `http://127.0.0.1:${CDP}`,
    '--platform-url', `${FXURL}/platform`, '--chatgpt-url', `${FXURL}/chatgpt`, '--timeout-scale', '0.4', '--cdp-files'], { encoding: 'utf8', timeout: 240000, env: {...process.env, HOST_SETUP_TEST_TRANSPORT:path.join(HERE,'mock-host.mjs'), HOST_SETUP_FIXTURE:FXURL} });
  ALL_OUT += r.stdout + r.stderr;
  const lines = r.stdout.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  return { code: r.status, lines, last: lines[lines.length - 1] || {}, stderr: r.stderr };
}
const state = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ------------------------------------------------------------ A: clean run
console.log('A. dry run, then full automatic run, then re-run');
await api('reset', { fail: ['personal-install','allow-once','empty-answer','delayed-submit','nested-approval','delayed-poll','slow-plugin-create','localized-approval'] });
const SA = path.join(WORK, 'A', 'state.json');
let r = cli(SA, 'run', '--dry-run');
check('dry run locates every entry element', r.code === 0 && r.last.ok === true, r.last);
let n = await api('counts');
check('dry run created/sent nothing', n.tunnels === 0 && n.keys === 0 && n.plugins === 0, n);

r = cli(SA, 'run');
check('default integrated mode finishes without an agent/user handoff', !r.lines.some(l=>l.needs_agent || l.needs_user), r.last);
check('full run exits 0 with ok:true', r.code === 0 && r.last.ok === true, r.last);
n = await api('counts');
const st = state(SA);
check('real Create button beats aria-haspopup wrapper and delayed dialog opens once',n.tunnel_opens===1 && st.steps.tunnel.attempts===1,n.tunnel_opens);
check('one tunnel, associated with the workspace', n.tunnels === 1 && n.tunnel_workspaces[0]?.includes('Acme Team'), n);
check('one key: Restricted, Tunnels Read + Use only, 30 days', n.keys === 1 && n.last_key.restricted && n.last_key.perms.Tunnels === 'Read + Use' && n.last_key.perms.Models === 'None' && n.last_key.perms.Assistants === 'None' && n.last_key.expiry === '30 days', n.last_key);
check('host installed directly once', n.host_installs === 1, n);
check('cold first poll is awaited without reinstall', n.host_statuses === 3, n);
check('foreign approval with similar app name left untouched', !n.chat_approvals.includes('foreign'), n.chat_approvals);
check('slow creation stays on its tab; no plugin/API round trip', n.after_create_visits.length === 0, n.after_create_visits);
check('Create and Connect each submitted once despite delayed response/rerender', n.plugin_creates === 1 && n.connect_calls === 1, {creates:n.plugin_creates,connects:n.connect_calls});
check('one plugin: selected tunnel, no auth, connected', n.plugins === 1 && n.plugin_state[0].auth === 'No authentication' && n.plugin_state[0].connected && n.plugin_state[0].tunnel_id === st.steps.tunnel.outputs.tunnel_id, n.plugin_state);
check('one task, one shell call, even with empty model reply', n.tool_calls === 1 && n.chat_submissions === 1 && st.steps.test?.outputs?.verified, st.steps.test?.outputs);
check('target file and execution evidence verified together', st.steps.test?.outputs?.file_ok && st.steps.test?.outputs?.shell_ok);
check('plugin and acceptance share the same bound ChatGPT tab',st.steps.plugin.connection?.target_id === st.steps.test.request?.target_id && st.browser.tabs.chatgpt.target_id === st.steps.test.request?.target_id);
const inspectBrowser=await connect(`http://127.0.0.1:${CDP}`);
const runTabs=await inspectBrowser.pages();
check('full run owns just two site tabs, not one per step',runTabs.filter(p=>p.url.startsWith(FXURL+'/')).length===2 && st.browser.tabs.platform.target_id!==st.browser.tabs.chatgpt.target_id);
const platformWindow=await inspectBrowser.send('Browser.getWindowForTarget',{targetId:st.browser.tabs.platform.target_id});
const chatWindow=await inspectBrowser.send('Browser.getWindowForTarget',{targetId:st.browser.tabs.chatgpt.target_id});
check('new run-owned tabs share the verified selected browser window',platformWindow.windowId===chatWindow.windowId);
inspectBrowser.close();
check('Chinese Allow once handled', n.chat_approvals.includes('once'), n.chat_approvals);
check('localized approval inside form is direct, with zero details opened',n.detail_opens===0 && r.lines.some(l=>l.event==='approved' && l.owner_verified===true && l.details_opened===false),n.detail_opens);
check('approval timing is recorded and no Always allow used',st.steps.test.request.approval_seen_at_ms<=st.steps.test.request.approval_dispatched_at_ms && !n.chat_approvals.includes('always'));
check('approval confirmation is separate from attempted dispatch',!!st.steps.test.request.approval_confirmed_at_ms && st.steps.test.request.approval_dispatch_intent_at_ms<=st.steps.test.request.approval_dispatched_at_ms);
check('successful run explicitly instructs report-and-stop',r.last.summary?.next_action==='REPORT_AND_STOP',r.last);
check('private key file retained for explicit rotation/recovery', privateFileOk(st.key_file));
check('state file is 0600 and holds no key', privateFileOk(SA) && !/sk-proj-/.test(fs.readFileSync(SA, 'utf8')));

r = cli(SA, 'run');
const n2 = await api('counts');
check('re-run skips every step and creates nothing', r.code === 0 && r.lines.filter((l) => l.event === 'skip').length === 6 && n2.tunnels === 1 && n2.keys === 1 && n2.plugins === 1 && n2.host_installs === n.host_installs, { skips: r.lines.filter((l) => l.event === 'skip').length, n2 });

// A2: ambiguous cards must not turn direct approval into a broad Allow click.
await api('config/add-failure',{name:'ambiguous-approval'});
const ambiguous=state(SA);delete ambiguous.steps.test;
const SAA=path.join(WORK,'A2','state.json');
fs.mkdirSync(path.dirname(SAA),{recursive:true});
fs.writeFileSync(SAA,JSON.stringify(ambiguous),{mode:0o600});
const approvalBefore=await api('counts');
r=cli(SAA,'run','--from-step','test','--only','test');
const approvalAfter=await api('counts');
check('multiple matching app cards stop instead of guessing',r.code===10 && /Multiple approval cards/.test(r.last.error),r.last);
check('ambiguous approval asks AI to resolve ownership, never another broad click',r.last.next_action==='SAME_AI_RECOVERY' && r.last.recovery?.owner==='current_ai');
check('ambiguous approval neither clicks details nor approves',approvalAfter.detail_opens===approvalBefore.detail_opens && approvalAfter.chat_approvals.length===approvalBefore.chat_approvals.length);
await api('config/clear-failure',{name:'ambiguous-approval'});
cli(SAA,'relay','stop');

// A3: a delivered click is not proof that the approval actually took effect.
await api('config/add-failure',{name:'ignored-approval'});
const ignored=state(SA);delete ignored.steps.test;delete ignored.browser.tabs.chatgpt;
const SAI=path.join(WORK,'A3','state.json');
fs.mkdirSync(path.dirname(SAI),{recursive:true});fs.writeFileSync(SAI,JSON.stringify(ignored),{mode:0o600});
const ignoredBefore=await api('counts');const ignoredStarted=Date.now();
r=cli(SAI,'run','--from-step','test','--only','test');
let ignoredAfter=await api('counts');
check('unchanged Allow once stops promptly, not after the whole acceptance timeout',r.code===10 && /approval_not_confirmed/.test(r.last.error) && Date.now()-ignoredStarted<12000,r.last);
check('failed approval hands back to the same AI, never a false approved event',r.last.next_action==='SAME_AI_RECOVERY' && r.last.recovery?.owner==='current_ai' && r.last.recovery?.do?.length>=2 && !r.lines.some(l=>l.event==='approved') && !state(SAI).steps.test.request.approval_confirmed_at_ms);
check('ignored approval sent exactly one click, no details or tool execution',ignoredAfter.approval_clicks===ignoredBefore.approval_clicks+1 && ignoredAfter.tool_calls===ignoredBefore.tool_calls && ignoredAfter.detail_opens===ignoredBefore.detail_opens);
r=cli(SAI,'run','--from-step','test','--only','test');ignoredAfter=await api('counts');
check('resume does not replay an uncertain approval or submit another task',r.code===10 && ignoredAfter.approval_clicks===ignoredBefore.approval_clicks+1 && ignoredAfter.chat_submissions===ignoredBefore.chat_submissions+1);
await api('config/clear-failure',{name:'ignored-approval'});cli(SAI,'relay','stop');

// ------------------------------------------------------------ B: failure + manual takeover + resume
console.log('B. key takeover; explicit plugin error; resume the same pending tab');
await api('reset', { fail: ['key-expiry-label', 'plugin-connection-error', 'personal-install'] });
const SB = path.join(WORK, 'B', 'state.json');
r = cli(SB, 'run');
check('run stops at step "key" with exit 10', r.code === 10 && r.last.step === 'key', r.last);
check('failure says what was expected and what was seen', /expir/i.test(r.last.error + JSON.stringify(r.last.expected)) && JSON.stringify(r.last.found).includes('1 个月'), r.last);
check('failure carries same-AI takeover do/verify/record/resume', r.last.next_action==='SAME_AI_RECOVERY' && r.last.recovery?.owner==='current_ai' && r.last.takeover?.owner==='current_ai' && !('budget_ms' in r.last.takeover) && r.last.takeover?.do?.length && r.last.takeover.verify?.length && /state done key|key-from/.test(r.last.takeover.record) && r.last.takeover.resume, r.last.takeover);
let sb = state(SB);
check('state: tunnel done, key failed (not submitted)', sb.steps.tunnel.status === 'done' && sb.steps.key.status === 'failed');

// the agent creates the key by hand and stores it without printing it
const made = await api('keys', { name: sb.names.key, restricted: true, perms: { Models: 'None', Assistants: 'None', Tunnels: 'Read + Use' }, expiry: '1 month', project: 'Default project' });
privateDir(path.dirname(sb.key_file));
fs.writeFileSync(sb.key_file, `CONTROL_PLANE_API_KEY=${made.key}\n`, { mode: 0o600 });
r = cli(SB, 'state', 'done', 'key', `key_name=${sb.names.key}`);
check('state done key accepted', r.code === 0 && r.last.ok, r.last);

r = cli(SB, 'run');
check('resume skips tunnel+key, stops at plugin (readback failed after submit)', r.code === 10 && r.last.step === 'plugin' && r.last.submitted === true && r.lines.some((l) => l.event === 'skip' && l.step === 'tunnel') && r.lines.some((l) => l.event === 'skip' && l.step === 'key'), r.last);
const pendingTab = state(SB).steps.plugin.connection?.target_id;
await api('config/clear-failure', {name:'plugin-connection-error'});
// The operator resolves the error before resuming; server config alone is not
// proof that the existing browser page has consumed that update yet.
const repairBrowser = await connect(`http://127.0.0.1:${CDP}`);
const repairPage = await repairBrowser.attach(pendingTab);
await repairPage.send('Page.bringToFront');
const repaired = await repairPage.waitFor(() => repairPage.eval(() =>
  ![...document.querySelectorAll('[role=alert]')].some(e => e.textContent.includes('Connection failed'))), {timeout:5000});
check('explicit error is actually resolved on the original page before resume',!!repaired);
repairBrowser.close();
r = cli(SB, 'run');
check('second resume recovers the plugin and finishes', r.code === 0 && r.last.ok === true, r.last);
n = await api('counts');
check('pending tab reused, no new plugin/API navigation during recovery', !!pendingTab && n.after_create_visits.length === 0, n.after_create_visits);
check('no duplicates: 1 tunnel, 1 key, 1 plugin, 1 direct host install', n.tunnels === 1 && n.keys === 1 && n.plugins === 1 && n.host_installs === 1, n);
r = cli(SB, 'run', '--from-step', 'tunnel');
n = await api('counts');
check('--from-step on a done creating step does not create again', r.code === 0 && n.tunnels === 1 && n.keys === 1 && n.plugins === 1, n);

// Lost/legacy tab state may inspect the list once, but never re-create the app.
sb = state(SB);
sb.steps.plugin = {status:'submitted',attempts:1};
fs.writeFileSync(SB,JSON.stringify(sb));
r = cli(SB,'run','--from-step','plugin');
n = await api('counts');
check('lost-tab recovery finds the existing Personal app without Create',r.code===0 && n.plugin_creates===1 && n.connect_calls===1,r.last);

// ------------------------------------------------------------ C: submitted but not found -> refuse
console.log('C. a submitted step whose object cannot be found is refused, not re-created');
sb = state(SB);
sb.steps.plugin = { status: 'submitted', attempts: 1 };
sb.names.plugin = 'Host never-created';
fs.writeFileSync(SB, JSON.stringify(sb));
r = cli(SB, 'run', '--from-step', 'plugin');
n = await api('counts');
check('exit 12 refused, plugin count unchanged', r.code === 12 && r.last.refused === true && n.plugins === 1, { last: r.last, plugins: n.plugins });

// ------------------------------------------------------------ D: one shared Chrome connection
console.log('D. all commands share one relay connection (one Allow click on the everyday Chrome)');
const relaySock = (stateFile) => {
  const dir = path.dirname(path.resolve(stateFile));
  const tag = crypto.createHash('sha256').update(`${dir}\0http://127.0.0.1:${CDP}`).digest('hex').slice(0, 10);
  const p = path.join(dir, `cdp-${tag}.sock`);
  return p.length < 100 ? p : path.join(os.tmpdir(), `host-setup-cdp-${tag}.sock`);
};
const relayPid = (stateFile) => { try { return JSON.parse(fs.readFileSync(relaySock(stateFile) + '.status', 'utf8')).pid; } catch { return null; } };
if(process.platform!=='win32') check('a fully successful run ends its relay', !fs.existsSync(relaySock(SA)));
const pid0 = relayPid(SB);
r = cli(SB, 'snapshot', '--tab-id', state(SB).browser.tabs.chatgpt.target_id, '--limit', '3');
const pid1 = relayPid(SB);
r = cli(SB, 'grep', '--tab-id', state(SB).browser.tabs.chatgpt.target_id, '--re', 'Host');
const pid2 = relayPid(SB);
if(process.platform!=='win32') check('relay kept across run + fallback tools (same pid)', pid0 && pid0 === pid1 && pid1 === pid2 && r.code === 0, { pid0, pid1, pid2, last: r.last });
if(process.platform!=='win32') check('relay socket is 0600', pid2 && (fs.statSync(relaySock(SB)).mode & 0o777) === 0o600);
r=cli(SB,'click','--text','Create new secret key');
check('fallback without a tab cannot click the API page',r.code===10 && /Specify --tab-id/.test(r.last.error),r.last);
r=cli(SB,'click','--tab',FXURL,'--text','Create new secret key');
check('ambiguous URL refuses instead of choosing the last tab',r.code===10 && /ambiguous/.test(r.last.error),r.last);
r=cli(SB,'snapshot','--tab-id',state(SB).browser.tabs.chatgpt.target_id);
check('exact tab recovery stays on ChatGPT, not API',r.code===0 && r.last.result?.url.startsWith(FXURL+'/chatgpt'),r.last);
r = cli(SB, 'relay', 'stop');
await sleep(500);
let alive = true; try { process.kill(pid2, 0); } catch { alive = false; }
if(process.platform!=='win32') check('relay stop ends the relay process and removes the socket', r.last.relay === 'stopped' && !alive && !fs.existsSync(relaySock(SB)), { last: r.last, alive });

// E: AI-owned middle, and target proof cannot be replaced by a ready status.
console.log('E. agent handoff and verified resume');
await api('reset', {fail:['auto-connect']});
const SC=path.join(WORK,'C','state.json');
r=cli(SC,'run','--host-mode','agent');
check('agent mode exits 13 for current AI, not for a Muse/user chat',r.code===13 && r.last.needs_agent===true,r.last);
n=await api('counts');
check('handoff did not install a host or create plugin',n.host_installs===0 && n.plugins===0,n);
r=cli(SC,'host','install');
check('same AI can perform host install without browser handoff',r.code===0,r.last);
r=cli(SC,'run','--host-mode','agent');
check('agent resume completes full workflow',r.code===0 && r.last.summary?.complete,r.last);
n=await api('counts');
check('already auto-connected app goes straight to acceptance',n.auto_connects===1 && n.connect_calls===0 && n.after_create_visits.length===0,n);
check('step timings recorded',state(SC).steps['host-install'].elapsed_ms>=0 && state(SC).steps.test?.elapsed_ms>0);
await api('reset',{fail:['missing-host-proof']});
const SD=path.join(WORK,'D','state.json');
r=cli(SD,'run');
check('missing target proof blocks completion',r.code===10 && r.last.step==='test',r.last);
const beforeResume=await api('counts');
r=cli(SD,'run','--from-step','test');
const afterResume=await api('counts');
check('timed-out acceptance is not automatically resubmitted',r.code===10 && beforeResume.chat_submissions===afterResume.chat_submissions && afterResume.chat_submissions===1,r.last);
await api('config/clear-failure',{name:'missing-host-proof'});
r=cli(SD,'run','--from-step','test');
check('late evidence completes without another tool call',r.code===0 && r.last.summary?.complete,r.last);
const finished=state(SD).steps.test;
check('acceptance request and real wall time survive recovery',!!finished.request?.target_id && finished.wall_elapsed_ms>=finished.request.budget_ms && finished.wall_elapsed_ms>finished.elapsed_ms);
r=cli(SD,'run','--from-step','test');
n=await api('counts');
check('rechecking a completed task reuses proof without another chat',r.code===0 && n.chat_submissions===1 && n.tool_calls===1,r.last);
check('all acceptance covered by six workflow steps',Object.keys(state(SA).steps).length===6);

// F: exercise mouse actionability independently, in this throwaway browser only.
console.log('F. actionable clicks, not disabled/covered controls or wrapper divs');
const browser = await connect(`http://127.0.0.1:${CDP}`);
const page = await browser.newPage(FXURL+'/chatgpt');
await page.eval(() => {
  document.body.innerHTML = '<div data-testid="wrapper" aria-haspopup="dialog"><button id="go" disabled>Create tunnel</button></div><button id="stuck" aria-disabled="true">Blocked</button><div id="cover" style="position:fixed;inset:0;z-index:9999;background:white"></div>';
  window.clicks = [];
  document.getElementById('go').onclick = () => window.clicks.push('go');
  document.getElementById('stuck').onclick = () => window.clicks.push('stuck');
  setTimeout(() => { document.getElementById('go').disabled = false; document.getElementById('cover').remove(); }, 500);
});
const clicked = await page.click({text:['Create tunnel'],css:'button'}, {timeout:2000,settle:0});
check('waits for disabled and overlay before sending one click', clicked.tag==='button' && (await page.eval(()=>window.clicks)).join()==='go');
const hit = (await page.find({text:['Create tunnel']}))[0];
check('semantic button beats matching data-testid wrapper',hit.tag==='button');
let blocked=false;
let unsafeIntent=false;
try { await page.click((await page.find({text:['Blocked']}))[0].id,{timeout:250,beforeDispatch:()=>{unsafeIntent=true;}}); } catch(e) { blocked=/not actionable/.test(e.message); }
check('permanently aria-disabled control is never clicked or marked dispatched',blocked && !unsafeIntent && (await page.eval(()=>window.clicks)).join()==='go');
await page.eval(() => { document.getElementById('go').style.pointerEvents='none'; });
blocked=false;
try { await page.click(clicked.id,{timeout:250}); } catch(e) { blocked=/not actionable/.test(e.message); }
check('parent hit is not misreported as a button hit',blocked && (await page.eval(()=>window.clicks)).join()==='go');
await page.eval(()=>{
  document.body.innerHTML='<button id="trap" style="position:absolute;left:50px;top:50px;width:120px;height:40px">Wrong action</button><button id="moving" style="position:absolute;left:50px;top:50px;width:120px;height:40px">Allow once</button>';
  window.hoverClicks=[];const b=document.getElementById('moving');
  b.addEventListener('mouseenter',()=>{b.style.left='400px';},{once:true});
  b.onclick=()=>window.hoverClicks.push('once');document.getElementById('trap').onclick=()=>window.hoverClicks.push('wrong');
});
await page.click({text:['Allow once'],css:'button'},{timeout:2000,settle:0});
check('hover-induced layout shift is rechecked before pressing, never clicks the old position',(await page.eval(()=>window.hoverClicks)).join()==='once');
let rpcBounded=false;
try {await page.send('Runtime.evaluate',{expression:'new Promise(()=>{})',awaitPromise:true},{timeout:150});} catch(e){rpcBounded=!!e.info?.cdp_timeout;}
check('hung CDP evaluation has a host-side deadline, no replay',rpcBounded);
// Direct approval scope: exact one-shot labels, one app, no user-message lookalikes.
const approvalSpec={text:LABELS.chatgpt.allow,css:'button,[role=button]',
  exclude:'[data-message-author-role=user],#prompt-textarea,[contenteditable=true],textarea',ownerText:'ubuntu1'};
for(const [name,owner,button,user,want] of [
  ['localized app card','ubuntu1','允许一次 ⏎',false,true],
  ['English app card','ubuntu1','Allow once',false,true],
  ['similar app name','ubuntu1-other','允许一次',false,false],
  ['another app','mac10','Allow',false,false],
  ['user-message lookalike','ubuntu1','允许一次',true,false],
  ['Always allow is never a one-shot control','ubuntu1','Always allow',false,false],
  ['Chinese Always allow is never a one-shot control','ubuntu1','始终允许',false,false],
]) {
  await page.eval(({owner,button,user})=>{
    document.body.replaceChildren();
    const card=document.createElement('form');
    if(user)card.setAttribute('data-message-author-role','user');
    const heading=document.createElement('p');heading.textContent=owner+' 请求允许 ChatGPT 在本机执行已经授权的验收操作';
    const b=document.createElement('button');b.textContent=button;card.append(heading,b);document.body.append(card);
  },{owner,button,user});
  const cards=await page.cards(approvalSpec);
  check('direct approval scope: '+name,cards.some(c=>c.matchesOwner)===want);
}
await page.eval(()=>{document.body.innerHTML='<div id="gone"><button>允许一次</button></div>';});
const gone=await page.eval(()=>window.__mcs.tag(document.getElementById('gone')));
await page.eval(()=>{document.getElementById('gone').remove();document.body.innerHTML='<button>允许一次</button>';});
check('vanished card scope cannot fall back to entire page',(await page.find({within:gone,text:LABELS.chatgpt.allow,css:'button'})).length===0);
await page.close();

console.log('G. expired creation waits do not click or navigate; unrelated success is not accepted');
const pending = await browser.newPage(FXURL+'/chatgpt/plugins');
const sg=state(SD);
await pending.eval(({name}) => {
  document.body.replaceChildren();
  for (const [tag,text] of [['h3','Installed'],['span',name+'-other 现已连接'],['button','连接 '+name]]) {
    const el=document.createElement(tag);el.textContent=text;document.body.append(el);
  }
  window.connectClicks=0;document.querySelector('button').onclick=()=>window.connectClicks++;
}, {name:sg.names.plugin});
sg.steps.plugin={status:'submitted',attempts:1,connection:{target_id:pending.targetId,started_at_ms:Date.now()-100000,budget_ms:90000,clicked_actions:[]}};
const SG=path.join(WORK,'G','state.json');fs.mkdirSync(path.dirname(SG),{recursive:true});fs.writeFileSync(SG,JSON.stringify(sg),{mode:0o600});
const prior=await api('counts');
r=cli(SG,'run','--from-step','plugin','--only','plugin');
const after=await api('counts');
check('timeout reports the pending creation/connection instead of passing Installed/other app',r.code===10 && /did not finish within 90/.test(r.last.error),r.last);
check('timeout leaves the bound page untouched, without re-Create or Connect',
  (await pending.eval(()=>window.connectClicks))===0 && prior.plugin_creates===after.plugin_creates && prior.after_create_visits.length===after.after_create_visits.length);
await pending.close();browser.close();

console.log('H. portable page-load recovery and existing key form');
for(const [mode,ok,visits] of [['blank-once',true,2],['blank-always',false,2],['blank-denied',false,1],['denied-delayed-ready',true,1],['denied-disabled',false,1],['denied-nonblank',false,1],['frozen-entry',false,2],['frozen-once',true,2]]) {
  await api('reset',{fail:[mode]});
  const sh=path.join(WORK,mode,'state.json');
  const failureStarted=Date.now();r=cli(sh,'run','--only','tunnel');
  const counts=await api('counts');
  check(mode+' bounded entry recovery',ok ? r.code===0 : r.code===10 && /page_load_failed|page_render_stalled/.test(r.last.error),r.last);
  check(mode+' does not retry denied resources or create duplicates',counts.tunnel_visits===visits && counts.tunnels===(ok?1:0),counts);
  if(mode.startsWith('denied-')) {
    check(mode+' never refreshes or opens a replacement window',!r.lines.some(l=>['page_reload','page_window_recovery'].includes(l.event)));
    if(ok) check('403 diagnostic retained while delayed enabled control proceeds',r.lines.some(l=>l.event==='page_resource_warning' && l.required_control_ready && !l.reloaded && l.resources.some(x=>x.status===403)) && counts.tunnel_opens===1,r.last);
    else check(mode+' observes the existing budget then stops without Create',Date.now()-failureStarted>=4800 && Date.now()-failureStarted<10000 && r.last.next_action==='SAME_AI_RECOVERY' && r.last.recovery?.owner==='current_ai' && r.last.recovery?.do?.length>=2 && counts.tunnel_opens===0,r.last);
  }
  if(['blank-denied','frozen-entry'].includes(mode)) check(mode+' stops automatic actions and gives scoped AI recovery',Date.now()-failureStarted<8000 && r.last.next_action==='SAME_AI_RECOVERY' && r.last.recovery?.owner==='current_ai' && r.last.recovery?.do?.length>=2,r.last);
  if(mode.startsWith('frozen-')) check(mode+' has exactly one entry-only window fallback',r.lines.filter(l=>l.event==='page_window_recovery').length===1 && !!state(sh).browser.window_recovery_at,r.last);
  if(mode==='frozen-entry') {
    const beforeWindowRetry=await api('counts');r=cli(sh,'run','--only','tunnel');
    const afterWindowRetry=await api('counts');
    check('saved frozen tab is preserved, not reloaded/replaced on resume',r.code===10 && !r.lines.some(l=>l.event==='page_window_recovery') && beforeWindowRetry.tunnel_visits===afterWindowRetry.tunnel_visits);
  }
  cli(sh,'relay','stop');
}
await api('reset',{fail:['login-required']});
const SL=path.join(WORK,'login-required','state.json');
r=cli(SL,'run','--only','tunnel');
check('real login prerequisite still asks the owner, not an access bypass',r.code===11 && r.last.needs_user==='login' && r.last.next_action==='NEEDS_USER' && !r.last.recovery,r.last);
check('login prerequisite creates no objects',(await api('counts')).tunnels===0);
cli(SL,'relay','stop');
await api('reset',{fail:['key-expiry-label']});
const SK=path.join(WORK,'key-resume','state.json');
r=cli(SK,'run');
check('key form failure is unsubmitted and owned',r.code===10 && !!state(SK).steps.key.form?.target_id,r.last);
const kb=await connect(`http://127.0.0.1:${CDP}`);
const kp=await kb.attach(state(SK).steps.key.form.target_id);
// Repair the fixture label in place, not by closing/recreating the form.
await kp.eval(()=>window.fxExpiryOptions.splice(0,window.fxExpiryOptions.length,'7 天','30 天','永不过期'));
await api('config/clear-failure',{name:'key-expiry-label'});
kb.close();
r=cli(SK,'run','--only','key');
n=await api('counts');
check('key resumes its existing form without clicking background Create',r.code===0 && n.key_opens===1 && n.keys===1,r.last);
check('recovery timing keeps the first attempt, not just the fast final reread',state(SK).steps.key.wall_elapsed_ms>state(SK).steps.key.elapsed_ms && !!state(SK).steps.key.first_started_at && r.last.summary.workflow_wall_ms>=state(SK).steps.key.wall_elapsed_ms);
cli(SK,'relay','stop');

console.log('I. project readiness and commit gate expiry/permissions');
for (const [mode,failures,error] of [
  ['project-delays',['project-delayed-field','project-delayed-commit','expiry-delayed-unlock'],null],
  ['project-missing',['project-missing-field'],/project field not available/],
  ['project-ignored',['project-ignored'],/project selection did not take effect/],
  ['expiry-locked',['expiry-never-unlocks'],/expiration field not available after confirmed project/],
]) {
  await api('reset',{fail:failures});
  const sf=path.join(WORK,mode,'state.json');
  // Only this target's tunnel prerequisite and key step, no host/services/chat.
  r=cli(sf,'run','--only','tunnel');
  check(mode+' tunnel prerequisite',r.code===0,r.last);
  r=cli(sf,'run','--only','key');
  const counts=await api('counts');
  check(mode+' precise result',error ? r.code===10 && error.test(r.last.error) : r.code===0,r.last);
  check(mode+' no duplicate Key/form',counts.key_opens===1 && counts.keys===(error?0:1),counts);
  if (error) {
    const inspect=await connect(`http://127.0.0.1:${CDP}`);
    const form=await inspect.attach(state(sf).steps.key.form.target_id);
    const result=await form.eval(()=>({projectClicks:window.fxProjectClicks||0,restricted:[...document.querySelectorAll('[role=radio]')].some(e=>e.textContent==='Restricted' && e.getAttribute('aria-checked')==='true')}));
    check(mode+' fails before permission setup, without blind repeat clicks',!result.restricted && result.projectClicks===(mode==='project-missing'?0:1),result);
    inspect.close();
  } else check('delayed project committed and expiry unlocked before submission',counts.last_key.project==='Default project' && counts.last_key.expiry==='30 days' && counts.last_key.perms.Tunnels==='Read + Use',counts.last_key);
  cli(sf,'relay','stop');
}

check('no key value in any CLI output', !/sk-proj-[0-9a-f]{10}/.test(ALL_OUT));
console.log(`\nresult: ${pass} passed, ${fail} failed   (work dir ${WORK})`);
cleanup();
await sleep(500);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
