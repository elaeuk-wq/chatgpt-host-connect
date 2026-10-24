// Host transport: POSIX bash or native Windows PowerShell, local or explicit SSH.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { privateFileOk, powershellPath, psArgs, psQuote } from './platform.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

export function acceptanceCommand(outputs, token) {
  const windows = outputs.os === 'Windows' || outputs.shell === 'powershell';
  if (!/^hcs-[a-f0-9]{16}$/.test(token) || !outputs.host_id ||
      !(windows ? path.win32.isAbsolute(outputs.root || '') : outputs.root?.startsWith('/'))) throw new Error('Missing verified target identity');
  const file = outputs.root + '/acceptance/' + token + '.txt';
  const code = [
    'import os, pathlib, platform, json',
    `assert os.environ.get('MCP_HOST_ID') == ${JSON.stringify(outputs.host_id)}, 'Wrong host identity'`,
    `p = pathlib.Path(${JSON.stringify(file)})`,
    "assert not p.parent.is_symlink(), 'Unsafe acceptance directory'",
    'p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)',
    `marker = ${JSON.stringify(token + '\n')}`,
    windows ? "with p.open('xb') as f: f.write(marker.encode('utf-8'))" : "with p.open('x', encoding='utf-8') as f: f.write(marker)",
    "assert p.read_text(encoding='utf-8') == marker, 'Readback mismatch'",
    `print(json.dumps({'host_id': os.environ['MCP_HOST_ID'], 'hostname': platform.node(), 'marker': ${JSON.stringify(token)}, 'readback_ok': True}))`,
  ].join('\n');
  if (windows) {
    if (!outputs.python_path) throw new Error('Missing Windows Python path');
    const program = `exec(__import__('base64').b64decode('${Buffer.from(code).toString('base64')}'))`;
    return '& ' + psQuote(outputs.python_path) + ' -c ' + psQuote(program) + '; exit $LASTEXITCODE';
  }
  return quote(outputs.python_path || 'python3') + ' -c ' + quote(code);
}

export function bindTarget(state, opts) {
  if (state.steps?.['muse-install'] || state.steps?.['muse-wait']) throw new Error('Legacy Muse state cannot be reused; choose a new --state file');
  const old = state.target;
  const target = { alias: opts.target || old?.alias, name: opts['host-name'] || old?.name,
    manager: opts.manager || old?.manager || 'auto' };
  if (!target.alias || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(target.alias)) throw new Error('Specify --target local or a trusted SSH alias');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(target.name || '')) throw new Error('Specify --host-name (lowercase slug, <=40 characters)');
  if (old && ['alias','name','manager'].some(k => old[k] !== target[k])) throw new Error('State is bound to another target; use a different --state file');
  target.os = opts['target-os'] || old?.os || (target.alias === 'local' && process.platform === 'win32' ? 'windows' : 'posix');
  if (!['windows','posix'].includes(target.os)) throw new Error('--target-os must be posix or windows (explicit for Windows SSH targets)');
  if (old?.os && old.os !== target.os) throw new Error('State is bound to another target OS');
  if (target.alias === 'local' && (target.os === 'windows') !== (process.platform === 'win32')) throw new Error('Local target OS does not match this controller');
  state.target = target;
  return target;
}

// Sources and the private request travel together on stdin, never in argv or a
// remote temporary credential file. This loader also works without a checkout.
const LOADER = `import json,sys,types
q=json.load(sys.stdin)
m=types.ModuleType('host_runtime'); exec(q['runtime_source'],m.__dict__); sys.modules['host_runtime']=m
scope={'__name__':'host_loader','__file__':'host.py'}; exec(q['host_source'],scope)
sys.exit(scope['main'](q))`;

export function transport(target, request, outputs, action) {
  const windows = target.os === 'windows';
  if (windows) {
    // Keep the Windows SSH command below cmd.exe's 8191-character boundary.
    // Bundled bootstrap code, like credentials, travels in stdin JSON, not argv.
    request.windows_bootstrap_source = fs.readFileSync(path.join(ROOT,'bootstrap.ps1'),'utf8');
    const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $env:PYTHONUTF8='1';\n" +
      "$privateRequest=[Console]::In.ReadToEnd();\ntry {\n" +
      "$bootstrap=($privateRequest | ConvertFrom-Json).windows_bootstrap_source; . ([ScriptBlock]::Create($bootstrap));\n" +
      '$python=Prepare-HostPython ' + (action==='install'?'$true':'$false') + '\n' +
      '$privateRequest | & $python -c ' + psQuote(LOADER) + '\nexit $LASTEXITCODE\n} catch {\n' +
      "$reason='Windows Python/bootstrap transport failed; check Python, winget policy and target permissions'; " +
      "if ($_.Exception.Message -match '^(Python 3\\.9|Python installation failed|Installed Python was not found)') { $reason=$_.Exception.Message }; " +
      "@{ok=$false;error=$reason} | ConvertTo-Json -Compress; exit 1\n}";
    const args = psArgs(script);
    if (target.alias === 'local') return [powershellPath(),args];
    return ['ssh',['-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes',target.alias,
      'powershell.exe ' + args.join(' ')]];
  }
  const python = outputs.python_path || 'python3';
  const bootstrap = action==='install' ? request.bootstrap_source + '\nprepare_python\nexec "$HOST_SETUP_PYTHON"' : 'exec ' + quote(python);
  if (target.alias==='local') return ['/bin/bash',['-c',bootstrap+' '+quote(path.join(ROOT,'host.py'))+' --request']];
  return ['ssh',['-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes',target.alias,
    '/bin/bash -c '+quote(bootstrap+' -c '+quote(LOADER))]];
}

export function hostRequest(state, opts, action, outputs = {}) {
  const target = bindTarget(state, opts);
  const request = { action, name: target.name, manager: target.manager,
    host_source: fs.readFileSync(path.join(ROOT,'host.py'),'utf8'),
    runtime_source: fs.readFileSync(path.join(ROOT,'host_runtime.py'),'utf8') };
  if (action === 'install') {
    if (!opts['allow-control']) throw new Error('Installation needs --allow-control: this exposes login-user shell/file permissions');
    if (!privateFileOk(state.key_file)) throw new Error('Key file must be private (0600 or current-user Windows ACL)');
    request.key = fs.readFileSync(state.key_file, 'utf8');
    request.tunnel_id = outputs.tunnel_id;
    request.probe_source = fs.readFileSync(path.join(ROOT, 'host-mcp.py'), 'utf8');
    request.allow_control = true;
    request.enable_linger = !!opts['enable-linger'];
    request.bootstrap_source = fs.readFileSync(path.join(ROOT, 'bootstrap.sh'), 'utf8');
    if (opts['client-bin']) request.client_bin = String(opts['client-bin']);
    if (opts['control-plane-proxy'] !== undefined) request.control_plane_proxy = String(opts['control-plane-proxy']);
  }
  if (action === 'logs') request.tokens = [outputs.token1, outputs.token2];
  if (action === 'verify') Object.assign(request,{token:outputs.token,command_hash:outputs.command_hash});
  let command, args;
  if (process.env.HOST_SETUP_TEST_TRANSPORT) {
    const endpoints = [opts['platform-url'], opts['chatgpt-url']];
    if (!endpoints.every(u => u && new URL(u).hostname === '127.0.0.1')) throw new Error('Test transport is limited to loopback fixture sites');
    command = process.execPath; args = [process.env.HOST_SETUP_TEST_TRANSPORT];
  } else [command,args] = transport(target,request,outputs,action);
  const started = Date.now();
  const r = spawnSync(command, args, { input: JSON.stringify(request), encoding: 'utf8', windowsHide:true,
    timeout: ['verify', 'status'].includes(action) ? Math.max(1, Math.min(10000, opts._hostTimeoutMs || 10000)) : action === 'install' ? 1200000 : 180000, maxBuffer: 1024 * 1024 });
  let result;
  try { result = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch {
    throw new Error(r.error?.code === 'ETIMEDOUT' ? 'Host operation timed out; inspect host status before retrying install' : 'Host transport failed; check SSH, Python and target permissions');
  }
  const pending = action === 'status' && r.status === 2 && result.ok && result.control_plane === 'PENDING';
  if ((r.status !== 0 && !pending) || !result.ok) throw new Error(String(result.error || 'Host is not ready').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]'));
  if (action !== 'preflight' && action !== 'logs' && outputs.tunnel_id && result.tunnel_id !== outputs.tunnel_id) throw new Error('Target installation uses a different tunnel');
  return { ...result, elapsed_ms: Date.now() - started };
}
