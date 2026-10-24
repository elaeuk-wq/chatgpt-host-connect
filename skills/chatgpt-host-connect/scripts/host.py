#!/usr/bin/env python3
"""Local/SSH host installer. JSON requests on stdin; secrets never in argv.

macOS: launchd. Linux: systemd --user + linger. Windows: per-user logon tasks.
No root daemon, public listener, model API call or Muse dependency.
--allow-control explicitly authorizes the login user's shell and file tools.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit
import uuid
import zipfile
from xml.sax.saxutils import escape as xml_escape
import xml.etree.ElementTree as ET
from host_runtime import powershell, ps_quote, private_directory, private_file_ok, WindowsJob

VERSION = 'v0.0.16'
OWNER = 'chatgpt-host-setup-v2'


def run(argv, **kwargs):
    return subprocess.run(argv, capture_output=True, text=True, timeout=kwargs.pop('timeout', 30), **kwargs)


def require(result, message):
    if result.returncode:
        raise RuntimeError(message)  # subprocess output could contain secrets
    return result.stdout


def private_write(p, content, mode=0o600):
    p = Path(p)
    if p.is_symlink():
        raise ValueError('Refusing symlink destination')
    tmp = p.with_name(p.name + '.tmp')
    if tmp.exists() or tmp.is_symlink():
        raise ValueError('Unfinished write exists; inspect it before resuming')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'wb') as f:
        f.write(content.encode() if isinstance(content, str) else content)
    os.replace(tmp, p)
    p.chmod(mode)


def read_key(text):
    # A dedicated bare-key or CONTROL_PLANE_API_KEY file, not an arbitrary .env.
    text = text.strip()
    if text.startswith('CONTROL_PLANE_API_KEY='):
        text = text.split('=', 1)[1].strip().strip('\"\'')
    if not re.fullmatch(r'sk-[A-Za-z0-9_-]{20,}', text):
        raise ValueError('Use a dedicated runtime key file (sk-...)')
    return text


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def http(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=3) as r:
        return r.read().decode()


def control_plane_proxy(request, saved):
    """Discover on THIS target, never copy the controller's loopback proxy."""
    choice = request.get('control_plane_proxy')
    if choice is None and 'control_plane_proxy' in saved:
        choice = saved['control_plane_proxy'] or 'direct'
    if choice == 'direct':
        return None
    if choice in (None, 'auto'):
        proxies = urllib.request.getproxies()  # target env; macOS system settings too
        choice = proxies.get('https') or proxies.get('http')
    if not choice:
        return None
    if not isinstance(choice, str) or any(ch.isspace() for ch in choice):
        raise ValueError('Invalid proxy URL')
    if '://' not in choice:
        choice = 'http://' + choice
    parsed = urlsplit(choice)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or
            parsed.username or parsed.password or parsed.query or parsed.fragment or
            parsed.path not in ('', '/')):
        raise ValueError('Proxy must be an HTTP(S) URL without embedded credentials, query or path')
    try:
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError()
    except ValueError:
        raise ValueError('Invalid proxy port') from None
    return choice.rstrip('/')


def manager_for(request):
    manager = request.get('manager', 'auto')
    if manager == 'auto':
        manager = {'Darwin': 'launchd', 'Linux': 'systemd-user', 'Windows': 'windows-task'}.get(platform.system())
    if manager not in ('launchd', 'systemd-user', 'windows-task'):
        raise ValueError('Supported targets: macOS, Linux/systemd or native Windows 10/11')
    if manager == 'windows-task' and platform.system() != 'Windows':
        raise ValueError('windows-task requires native Windows')
    if manager == 'launchd' and platform.system() != 'Darwin':
        raise ValueError('launchd requires macOS')
    if manager == 'systemd-user' and platform.system() != 'Linux':
        raise ValueError('systemd-user requires Linux')
    return manager


def root_for(request):
    name = request.get('name', '')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', name):
        raise ValueError('name must be a lowercase slug, up to 40 characters')
    if platform.system() == 'Windows':
        return Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local')).resolve() / 'ChatGPTHost' / name
    return Path.home().resolve() / '.local/share/chatgpt-host' / name


def owned_config(root):
    p = root / 'config.json'
    if not p.is_file() or p.is_symlink():
        raise ValueError('No owned installation; refusing to modify this directory')
    c = json.loads(p.read_text())
    if c.get('owner') != OWNER or c.get('root') != str(root):
        raise ValueError('Installation ownership mismatch')
    return c


def paths(c, component):
    label = 'com.chatgpt.host.' + c['name'] + '.' + component
    if c['manager'] == 'launchd':
        return label, Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    if c['manager'] == 'windows-task':
        return 'ChatGPTHost-' + c['name'] + '-' + component, Path(c['root']) / ('task-' + component + '.xml')
    unit = 'chatgpt-host-' + c['name'] + '-' + component + '.service'
    return unit, Path.home() / '.config/systemd/user' / unit


def windows_task_xml(c, component):
    # InteractiveToken: no password, no SYSTEM/elevation, starts only at user logon.
    x = lambda value: xml_escape(str(value))
    sid = c['windows_sid']
    python = Path(c['python_path'])
    pythonw = python.with_name('pythonw.exe')
    exe = str(pythonw if pythonw.is_file() else python)
    args = subprocess.list2cmdline([str(Path(c['root']) / 'host.py'), '--serve', component])
    return ('''<?xml version="1.0"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>{owner}</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Owner"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="Owner"><Exec><Command>{exe}</Command><Arguments>{args}</Arguments><WorkingDirectory>{root}</WorkingDirectory></Exec></Actions>
</Task>'''.format(owner=x(OWNER + ' ' + c['root']), sid=x(sid), exe=x(exe), args=x(args), root=x(c['root']))).encode()


def registered_windows_task(c, component):
    name, _ = paths(c, component)
    script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + \
        "$t=Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object TaskName -eq " + ps_quote(name) + \
        "; if($t) { Export-ScheduledTask -TaskName " + ps_quote(name) + " -TaskPath '\\' }"
    return require(powershell(script), 'Cannot inspect Windows scheduled tasks').strip()


def task_owned(raw, c):
    ns = {'t': 'http://schemas.microsoft.com/windows/2004/02/mit/task'}
    try:
        doc = ET.fromstring(raw)
        return (doc.findtext('t:RegistrationInfo/t:Description', namespaces=ns) == OWNER + ' ' + c['root'] and
                doc.findtext('t:Principals/t:Principal/t:UserId', namespaces=ns) == c['windows_sid'])
    except ET.ParseError:
        return False


def service_text(c, component, executable):
    root = Path(c['root'])
    if c['manager'] == 'windows-task':
        return windows_task_xml(c, component)
    args = [str(root / ('run-' + component + '.sh'))]
    if any(ch in str(root) for ch in '\n\r\x00'):
        raise ValueError('Invalid service path')
    if c['manager'] == 'launchd':
        label, _ = paths(c, component)
        return plistlib.dumps({'Label': label, 'ProgramArguments': args,
            'WorkingDirectory': str(root), 'RunAtLoad': True, 'KeepAlive': True,
            'ThrottleInterval': 10, 'Umask': 0o077,
            'StandardOutPath': str(root / (component + '.log')),
            'StandardErrorPath': str(root / (component + '.log')),
            'EnvironmentVariables': {'PATH': os.environ.get('PATH', '/usr/bin:/bin')},
            'ChatGPTHostOwner': str(root)})
    # ExecStart path is quoted for systemd, not for a shell. '%' is a specifier.
    escaped = args[0].replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
    return ('# ' + OWNER + ' ' + str(root) + '\n[Unit]\nDescription=ChatGPT host ' + component +
            '\nAfter=network-online.target\n[Service]\nType=exec\nExecStart="' + escaped +
            '"\nRestart=on-failure\nRestartSec=10\nUMask=0077\n[Install]\nWantedBy=default.target\n').encode()


def check_service_owner(c):
    for component in ('mcp', 'tunnel'):
        if c['manager'] == 'windows-task':
            registered = registered_windows_task(c, component)
            if registered and not task_owned(registered, c):
                raise ValueError('Scheduled task belongs to another installation/user')
        _, p = paths(c, component)
        if p.exists() or p.is_symlink():
            if p.is_symlink():
                raise ValueError('Refusing symlink service file')
            raw = p.read_bytes()
            if c['manager'] == 'launchd':
                valid = plistlib.loads(raw).get('ChatGPTHostOwner') == c['root']
            elif c['manager'] == 'windows-task':
                valid = task_owned(raw, c)
            else:
                valid = raw.startswith(('# ' + OWNER + ' ' + c['root'] + '\n').encode())
            if not valid:
                raise ValueError('Service name belongs to another installation')


def manager_preflight(c, enable_linger=False):
    if c['manager'] == 'windows-task':
        sid = require(powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'), 'Cannot identify Windows user').strip()
        if not re.fullmatch(r'S-1-(?:5-21|12-1)-(?:[0-9]+-){3}[0-9]+', sid):
            raise ValueError('Run Windows setup as an ordinary local/domain login user, not a service account')
        c['windows_sid'] = sid
        require(powershell("$ErrorActionPreference='Stop'; Get-Command Register-ScheduledTask | Out-Null"),
                'Windows setup needs Task Scheduler permission; the same user must be logged in for the task to run')
        return
    if os.getuid() == 0:
        raise ValueError('Run as the intended login user, not root')
    if c['manager'] == 'launchd':
        require(run(['launchctl', 'print', 'gui/' + str(os.getuid())]), 'Log into the macOS GUI session first')
    else:
        require(run(['systemctl', '--user', 'show-environment']), 'A running systemd user manager is required')
        user = require(run(['id', '-un']), 'Cannot determine login user').strip()
        linger = run(['loginctl', 'show-user', user, '--property=Linger', '--value'])
        if linger.returncode or linger.stdout.strip() != 'yes':
            if not enable_linger:
                raise ValueError('Linux requires loginctl enable-linger for this user; authorize --enable-linger or configure it first')
            require(run(['sudo', '-n', 'loginctl', 'enable-linger', user]), 'Could not enable linger; ask the owner to run loginctl enable-linger')


def client_binary(root, requested=None, bootstrap_source=None):
    if requested:
        p = Path(requested).expanduser().resolve()
        if not p.is_file() or not os.access(p, os.X_OK):
            raise ValueError('Client binary is missing or not executable')
        require(run([str(p), '--version']), 'Client binary failed its version check')
        return str(p)
    if platform.system() == 'Darwin':
        # Never discover a previous connection's private binary via PATH.
        setup = bootstrap_source or Path(__file__).with_name('bootstrap.sh').read_text()
        result = run(['/bin/bash', '-c', setup + '\nensure_brew\nprintf "%s" "$HOST_SETUP_BREW"'], timeout=600)
        if result.returncode:
            try:
                message = json.loads(result.stdout)['error']
            except (ValueError, KeyError):
                message = 'Official Homebrew setup failed; check target permissions and network'
            raise RuntimeError(message)
        brew = result.stdout.strip()
        prefix = require(run([brew, '--prefix']), 'Cannot locate Homebrew prefix').strip()
        p = Path(prefix) / 'opt/tunnel-client/bin/tunnel-client'
        if not p.is_file():
            env = {**os.environ, 'HOMEBREW_NO_AUTO_UPDATE': '1', 'HOMEBREW_NO_INSTALL_CLEANUP': '1'}
            require(run([brew, 'install', 'openai/tools/tunnel-client'], env=env, stdin=subprocess.DEVNULL, timeout=600),
                    'Official client installation failed; check target network/Homebrew, not an old connection')
        if not p.is_file() or not os.access(p, os.X_OK):
            raise RuntimeError('Homebrew did not install the official tunnel client')
        require(run([str(p), '--version']), 'Official tunnel client failed its version check')
        return str(p)
    target = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine().lower())
    system = {'Linux': 'linux', 'Windows': 'windows'}.get(platform.system())
    if not target or not system:
        raise ValueError('Unsupported OS/architecture for the official tunnel client')
    p = root / ('tunnel-client-' + VERSION + ('.exe' if system == 'windows' else ''))
    if p.exists():
        expected = (root / 'client.sha256').read_text().strip()
        if hashlib.sha256(p.read_bytes()).hexdigest() != expected:
            raise ValueError('Installed client checksum mismatch')
        return str(p)
    asset = 'tunnel-client-runtime-' + VERSION + '-' + system + '-' + target + '.zip'
    base = 'https://github.com/openai/tunnel-client/releases/download/' + VERSION + '/'
    with urllib.request.urlopen(base + 'SHA256SUMS.txt', timeout=30) as r:
        sums = r.read().decode()
    matches = [line.split()[0] for line in sums.splitlines() if len(line.split()) == 2 and line.split()[1].lstrip('*') == asset]
    if len(matches) != 1:
        raise ValueError('Official release checksum missing')
    with urllib.request.urlopen(base + asset, timeout=60) as r:
        data = r.read()
    if hashlib.sha256(data).hexdigest() != matches[0]:
        raise ValueError('Release checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        entries = [n for n in z.namelist() if Path(n).name in ('tunnel-client', 'tunnel-client-runtime', 'tunnel-client.exe', 'tunnel-client-runtime.exe')]
        if len(entries) != 1:
            raise ValueError('Unexpected archive layout')
        binary = z.read(entries[0])
    private_write(p, binary, 0o700)
    private_write(root / 'client.sha256', hashlib.sha256(binary).hexdigest() + '\n')
    return str(p)


def stop(c):
    check_service_owner(c)
    for component in ('tunnel', 'mcp'):
        unit, p = paths(c, component)
        if not p.exists():
            continue
        if c['manager'] == 'windows-task':
            if registered_windows_task(c, component):
                require(powershell("$ErrorActionPreference='Stop'; Stop-ScheduledTask -TaskName " + ps_quote(unit) + "; Disable-ScheduledTask -TaskName " + ps_quote(unit) + " | Out-Null"), 'Could not stop owned scheduled task')
        elif c['manager'] == 'launchd':
            domain = 'gui/' + str(os.getuid())
            if run(['launchctl', 'print', domain + '/' + unit]).returncode == 0:
                require(run(['launchctl', 'bootout', domain, str(p)]), 'Could not stop owned LaunchAgent')
        else:
            require(run(['systemctl', '--user', 'disable', '--now', unit]), 'Could not stop owned user service')


def start_component(c, component):
    unit, p = paths(c, component)
    if c['manager'] == 'windows-task':
        existing = registered_windows_task(c, component)
        if existing and not task_owned(existing, c):
            raise ValueError('Refusing to replace another Windows task')
        script = "$ErrorActionPreference='Stop'; $xml=[IO.File]::ReadAllText(" + ps_quote(p) + "); Register-ScheduledTask -TaskName " + ps_quote(unit) + " -Xml $xml" + (' -Force' if existing else '') + " | Out-Null; Start-ScheduledTask -TaskName " + ps_quote(unit)
        require(powershell(script), 'Could not register/start the per-user Windows task; inspect Task Scheduler permissions')
    elif c['manager'] == 'launchd':
        domain = 'gui/' + str(os.getuid())
        require(run(['launchctl', 'enable', domain + '/' + unit]), 'Could not enable LaunchAgent')
        require(run(['launchctl', 'bootstrap', domain, str(p)]), 'Could not start LaunchAgent')
    else:
        require(run(['systemctl', '--user', 'enable', '--now', unit]), 'Could not start user service')


def wait_mcp(c):
    for delay in (0.2, 0.5, 1, 2, 3):
        time.sleep(delay)
        try:
            data = json.loads(http('http://127.0.0.1:%s/healthz' % c['mcp_port']))
            if data.get('host_id') == c['host_id']:
                return
        except Exception:
            pass
    raise RuntimeError('Owned MCP did not become healthy')


def status(c):
    result = {'root': c['root'], 'host_id': c['host_id'], 'hostname': platform.node(),
              'tunnel_id': c['tunnel_id'], 'manager': c['manager'], 'python_path': sys.executable,
              'os': platform.system(), 'shell': 'powershell' if platform.system() == 'Windows' else 'bash',
              'control_plane_proxy': c.get('control_plane_proxy'), 'control_plane': 'PENDING'}
    try:
        mcp = json.loads(http('http://127.0.0.1:%s/healthz' % c['mcp_port']))
        result['mcp_ok'] = mcp.get('host_id') == c['host_id'] and mcp.get('control') is True
        metrics = http('http://127.0.0.1:%s/metrics' % c['health_port'])
        times = [float(line.split()[-1]) for line in metrics.splitlines()
                 if re.match(r'^commands_poll_last_successful_timestamp_seconds(?:\{|\s)', line)]
        fresh = bool(times) and 0 <= time.time() - max(times) < 90
        if result['mcp_ok'] and fresh:
            result['control_plane'] = 'OK'
    except Exception:
        result.setdefault('mcp_ok', False)
    return result


def mcp_log(c):
    if c['manager'] in ('launchd', 'windows-task'):
        p = Path(c['root']) / 'mcp.log'
        with p.open('rb') as f:
            f.seek(max(0, p.stat().st_size - 131072)); text = f.read().decode(errors='replace')
    else:
        unit, _ = paths(c, 'mcp')
        text = require(run(['journalctl', '--user', '-u', unit, '-n', '300', '-o', 'cat', '--no-pager']), 'Cannot read owned MCP journal')
    return text


def verify_acceptance(c, token, command_hash):
    if not isinstance(token, str) or not re.fullmatch(r'hcs-[a-f0-9]{16}', token):
        raise ValueError('Invalid acceptance token')
    if not isinstance(command_hash, str) or not re.fullmatch(r'[a-f0-9]{64}', command_hash):
        raise ValueError('Invalid acceptance command hash')
    p = Path(c['root']) / 'acceptance' / (token + '.txt')
    file_ok = (p.is_file() and not p.is_symlink() and not p.parent.is_symlink() and
               p.stat().st_size == len(token) + 1 and p.read_text() == token + '\n')
    evidence = 'shell_result host_id=%s command_sha256=%s exit_code=0 timed_out=0' % (c['host_id'], command_hash)
    try:
        shell_ok = evidence in mcp_log(c)
    except FileNotFoundError:
        shell_ok = False
    return {'verified': bool(file_ok and shell_ok), 'file_ok': file_ok, 'shell_ok': shell_ok,
            'host_id': c['host_id'], 'hostname': platform.node(), 'tunnel_id': c['tunnel_id'],
            'token': token, 'verification_version': 2}


def logs(c, tokens):
    # Compatibility diagnostics for existing v1 states; not part of new acceptance.
    if len(tokens) != 2 or len(set(tokens)) != 2 or any(not re.fullmatch(r'hcs-[a-f0-9]{16}', t) for t in tokens):
        raise ValueError('Two fresh probe tokens required')
    text = mcp_log(c)
    hashes = [hashlib.sha256(t.encode()).hexdigest() for t in tokens]
    matched = [h for h in hashes if ('probe_result host_id=' + c['host_id'] + ' token_sha256=' + h) in text]
    return {'verified': len(matched) == 2, 'matched_calls': len(matched), 'host_id': c['host_id'], 'token_hashes': matched}


def install(q):
    if not q.get('allow_control'):
        raise ValueError('Direct host control requires explicit --allow-control authorization')
    root = root_for(q)
    tid = q.get('tunnel_id', '')
    if not re.fullmatch(r'tunnel_[a-f0-9]{32}', tid):
        raise ValueError('Invalid tunnel ID')
    key = read_key(q.get('key', ''))
    if root.is_symlink() or any(p.is_symlink() for p in root.parents):
        raise ValueError('Installation path must not contain symlinks')
    c = owned_config(root) if root.exists() else None
    if c and c['tunnel_id'] != tid:
        raise ValueError('This installation belongs to another tunnel; use a different name')
    manager = manager_for(q)
    if c and c['manager'] != manager:
        raise ValueError('Changing an existing service manager is not supported')
    if not c:
        a, b = free_port(), free_port()
        while a == b:
            b = free_port()
        c = dict(owner=OWNER, name=q['name'], root=str(root), tunnel_id=tid,
                 manager=manager, host_id=uuid.uuid4().hex, mcp_port=a, health_port=b)
    manager_preflight(c, q.get('enable_linger', False))
    check_service_owner(c)
    c['control_plane_proxy'] = control_plane_proxy(q, c)
    source = q.get('probe_source')
    if not source:
        source = Path(__file__).with_name('host-mcp.py').read_text()
    compile(source, 'host-mcp.py', 'exec')
    private_directory(root)
    # Claim an empty directory before downloads, so failed downloads can resume.
    if not (root / 'config.json').exists():
        private_write(root / 'config.json', json.dumps(c, indent=2))
    client = client_binary(root, q.get('client_bin') or c.get('client_bin'), q.get('bootstrap_source'))
    c['client_bin'] = client
    c['python_path'] = sys.executable
    private_write(root / 'config.json', json.dumps(c, indent=2))
    stop(c)
    private_write(root / 'runtime-key', key + '\n')
    private_write(root / 'host-mcp.py', source)
    private_write(root / 'host_runtime.py', q.get('runtime_source') or Path(__file__).with_name('host_runtime.py').read_text())
    if manager == 'windows-task':
        private_write(root / 'host.py', q.get('host_source') or Path(__file__).read_text())
    env = dict(MCP_HOST='127.0.0.1', MCP_PORT=str(c['mcp_port']), MCP_HOST_ID=c['host_id'], MCP_ALLOW_CONTROL='1')
    mcp = ['env'] + [k + '=' + v for k, v in env.items()] + [sys.executable, str(root / 'host-mcp.py')]
    tunnel = [client, 'run', '--control-plane.tunnel-id', tid,
              '--control-plane.api-key', 'file:' + str(root / 'runtime-key'),
              '--mcp.server-url', 'http://127.0.0.1:%s/mcp' % c['mcp_port'],
              '--health.listen-addr', '127.0.0.1:%s' % c['health_port'],
              '--mcp.startup-wait-timeout', '30s']
    if c['control_plane_proxy']:
        tunnel += ['--control-plane.http-proxy', c['control_plane_proxy']]
    # MCP always stays direct on loopback; do not apply this proxy globally.
    if manager == 'windows-task':
        c['tunnel_argv'] = tunnel
        private_write(root / 'config.json', json.dumps(c, indent=2))
    for component, argv in [('mcp', mcp), ('tunnel', tunnel)]:
        if manager != 'windows-task':
            private_write(root / ('run-' + component + '.sh'), '#!/bin/sh\nexec ' + shlex.join(argv) + '\n', 0o700)
        _, p = paths(c, component)
        p.parent.mkdir(parents=True, exist_ok=True)
        private_write(p, service_text(c, component, argv))
    if manager == 'systemd-user':
        require(run(['systemctl', '--user', 'daemon-reload']), 'Could not reload user units')
    start_component(c, 'mcp')
    wait_mcp(c)
    start_component(c, 'tunnel')
    # Installation and first successful long poll are separate milestones.
    # host-wait polls read-only; PENDING must not cause a second installation.
    return {**status(c), 'installed': True}


def dispatch(q):
    action = q.get('action', 'status')
    if action == 'install':
        return install(q)
    if action == 'preflight':
        return {'hostname': platform.node(), 'os': platform.system(), 'arch': platform.machine(),
                'manager': manager_for(q), 'root': str(root_for(q))}
    c = owned_config(root_for(q))
    if action == 'status':
        return status(c)
    if action == 'logs':
        return logs(c, q.get('tokens', []))
    if action == 'verify':
        return verify_acceptance(c, q.get('token'), q.get('command_hash'))
    if action == 'stop':
        stop(c)
        return {'stopped': True, 'root': c['root']}
    raise ValueError('Unknown action')


def serve_windows(component):
    import runpy
    root = Path(__file__).resolve().parent
    c = owned_config(root)
    if c['manager'] != 'windows-task':
        raise ValueError('This runner is only for owned Windows tasks')
    log = (root / (component + '.log')).open('a', encoding='utf-8', buffering=1)
    sys.stdout = sys.stderr = log
    os.chdir(root)
    os.environ.update(MCP_PORT=str(c['mcp_port']), MCP_HOST_ID=c['host_id'], MCP_ALLOW_CONTROL='1',
                      PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    if component == 'mcp':
        runpy.run_path(str(root / 'host-mcp.py'), run_name='__main__')
    else:
        job = WindowsJob()
        try:
            child = subprocess.Popen(c['tunnel_argv'], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                     creationflags=0x4 | 0x08000000)
            job.attach_and_resume(child)
            return child.wait()
        finally:
            job.close()
    return 0


def main(request=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'preflight', 'status', 'logs', 'verify', 'stop'], nargs='?', default='status')
    parser.add_argument('--request', action='store_true', help='read a private JSON request from stdin')
    parser.add_argument('--serve', choices=['mcp', 'tunnel'], help=argparse.SUPPRESS)
    parser.add_argument('--name', default='local')
    parser.add_argument('--manager', default='auto')
    parser.add_argument('--tunnel-id')
    parser.add_argument('--key-file')
    parser.add_argument('--client-bin')
    parser.add_argument('--control-plane-proxy', dest='control_plane_proxy', help='auto (target settings), direct, or HTTP(S) URL')
    parser.add_argument('--token')
    parser.add_argument('--command-hash')
    parser.add_argument('--enable-linger', action='store_true')
    parser.add_argument('--allow-control', action='store_true')
    args = parser.parse_args([] if request is not None else None)
    try:
        if args.serve:
            return serve_windows(args.serve)
        if request is not None:
            q = request
        elif args.request:
            q = json.load(sys.stdin)
        else:
            q = vars(args)
            if args.key_file:
                p = Path(args.key_file).expanduser()
                if not private_file_ok(p):
                    raise ValueError('Key source file must be private (POSIX 0600 or current-user Windows ACL)')
                q['key'] = p.read_text()
        result = dispatch(q)
        print(json.dumps({'ok': True, **result}))
        return 0 if result.get('installed') or result.get('control_plane', 'OK') == 'OK' else 2
    except Exception as e:
        # Never print a subprocess command, request object, key or raw HTTP body.
        message = str(e) if isinstance(e, (ValueError, RuntimeError)) else type(e).__name__
        message = re.sub(r'sk-[A-Za-z0-9_-]+', '[REDACTED]', message)
        print(json.dumps({'ok': False, 'error': message}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
