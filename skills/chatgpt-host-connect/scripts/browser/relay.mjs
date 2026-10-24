// Holds ONE CDP connection to Chrome and shares it over a local Unix socket.
//
// The everyday Chrome (chrome://inspect/#remote-debugging) asks the user to
// click Allow for every new DevTools connection. `run` and every fallback tool
// (snapshot, click, ...) are separate processes, so without this relay each of
// them would trigger another prompt. With it the user clicks Allow once.
//
//   node relay.mjs <endpoint> <socket-path>
//
// Protocol: newline-delimited CDP JSON. Request ids are remapped per client;
// events for a session go to the client that attached it, others to everyone.
// {"relay":"shutdown"} stops it. Exits after IDLE ms without clients, or when
// Chrome closes the connection. Socket is 0600 inside a 0700 directory.
import fs from 'node:fs';
import net from 'node:net';
import { resolveWsUrl } from './cdp.mjs';

const [endpoint, sockPath] = process.argv.slice(2);
const IDLE = Number(process.env.HOST_SETUP_RELAY_IDLE_MS || 10 * 60 * 1000);
const statusFile = `${sockPath}.status`;
const status = (o) => { try { fs.writeFileSync(statusFile, JSON.stringify({ pid: process.pid, ...o }), { mode: 0o600 }); } catch { /* ignore */ } };

let server = null;
function shutdown(code = 0) {
  try { server?.close(); } catch { /* ignore */ }
  try { ws?.close(); } catch { /* ignore */ }
  for (const f of [sockPath, statusFile]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  process.exit(code);
}

status({ state: 'resolving' });
const url = await resolveWsUrl(endpoint);
if (!url) { status({ state: 'error', error: `cannot find a Chrome DevTools endpoint (${endpoint})` }); process.exit(1); }

status({ state: 'waiting_for_allow' });
const ws = new WebSocket(url);
let opened = false;
ws.addEventListener('error', () => {
  if (!opened) { status({ state: 'error', error: 'Chrome refused the connection (Allow not clicked, or remote debugging is off)' }); process.exit(1); }
});
ws.addEventListener('close', () => shutdown(0));
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
opened = true;

let nextId = 0;
const pending = new Map();      // relay id -> { client, id, method }
const owner = new Map();        // sessionId -> client
const clients = new Set();
let idleTimer = null;
const armIdle = () => { clearTimeout(idleTimer); if (!clients.size) idleTimer = setTimeout(() => shutdown(0), IDLE); };
const write = (client, msg) => { if (!client.destroyed) client.write(JSON.stringify(msg) + '\n'); };

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
  if (m.id) {
    const p = pending.get(m.id);
    if (!p) return;              // e.g. our own detach calls
    pending.delete(m.id);
    if (p.method === 'Target.attachToTarget' && m.result?.sessionId) owner.set(m.result.sessionId, p.client);
    write(p.client, { ...m, id: p.id });
  } else if (m.method) {
    const to = m.sessionId && owner.get(m.sessionId);
    if (to) write(to, m);
    else for (const c of clients) write(c, m);
  }
});

server = net.createServer((client) => {
  clients.add(client);
  armIdle();
  let buf = '';
  client.setEncoding('utf8');
  client.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.relay === 'shutdown') return shutdown(0);
      const id = ++nextId;
      pending.set(id, { client, id: msg.id, method: msg.method });
      ws.send(JSON.stringify({ ...msg, id }));
    }
  });
  const gone = () => {
    if (!clients.delete(client)) return;
    for (const [sid, c] of owner) {
      if (c !== client) continue;
      owner.delete(sid);
      ws.send(JSON.stringify({ id: ++nextId, method: 'Target.detachFromTarget', params: { sessionId: sid } }));
    }
    for (const [id, p] of pending) if (p.client === client) pending.delete(id);
    armIdle();
  };
  client.on('close', gone);
  client.on('error', gone);
});

try { fs.unlinkSync(sockPath); } catch { /* stale */ }
const oldMask = process.umask(0o177);
server.listen(sockPath, () => {
  process.umask(oldMask);
  try { fs.chmodSync(sockPath, 0o600); } catch { /* ignore */ }
  status({ state: 'ready' });
  armIdle();
});
server.on('error', (e) => { status({ state: 'error', error: `relay socket: ${e.message}` }); shutdown(1); });
