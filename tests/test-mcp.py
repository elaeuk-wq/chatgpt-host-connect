#!/usr/bin/env python3
"""Exercise real HTTP MCP in a temporary directory, no real credentials."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/chatgpt-host-connect/scripts/host-mcp.py'
checks = []
WINDOWS = os.name == 'nt'

def check(name, condition, detail=None):
    checks.append(bool(condition))
    print(('PASS ' if condition else 'FAIL ') + name)
    if not condition and detail is not None: print('  diagnostic:', detail)


def test(control):
    with tempfile.TemporaryDirectory(prefix='host-mcp-test-') as d:
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
        log = Path(d) / 'mcp.log'
        env = dict(os.environ, MCP_PORT=str(port), MCP_HOST_ID='test-host', MCP_ALLOW_CONTROL=str(int(control)))
        with log.open('wb') as out:
            p = subprocess.Popen([sys.executable, str(SCRIPT)], env=env, stderr=out)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def request(method='POST', data=None, suffix='/mcp', headers=None):
            req = urllib.request.Request('http://127.0.0.1:%d%s' % (port, suffix), method=method,
                    data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json', **(headers or {})})
            try:
                with opener.open(req, timeout=70) as r:
                    raw = r.read(); return r.status, json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                raw = e.read(); return e.code, json.loads(raw) if raw else None
        def rpc(method, params=None):
            return request(data={'jsonrpc':'2.0','id':1,'method':method,'params':params or {}})[1]
        def call(name, **args):
            return rpc('tools/call', {'name':name,'arguments':args})['result']
        def payload(r):
            return json.loads(r['content'][0]['text'])
        try:
            for _ in range(60):
                try:
                    _, h = request('GET', suffix='/healthz'); break
                except OSError:
                    time.sleep(0.05)
            check('health identity/control %s' % control, h['host_id']=='test-host' and h['control']==control)
            r=rpc('initialize',{'protocolVersion':'2025-03-26'})
            check('initialize negotiated protocol',r['result']['protocolVersion']=='2025-03-26')
            names={t['name'] for t in rpc('tools/list')['result']['tools']}
            check('tool surface %s' % control, names==({'host_ping','host_probe','execute_terminal','read_file','write_file','list_directory'} if control else {'host_ping','host_probe'}))
            check('stateless ping',rpc('ping')['result']=={})
            check('notification 202',request(data={'jsonrpc':'2.0','method':'notifications/initialized'})[0]==202)
            check('invalid JSON-RPC value rejected',request(data='bad')[1]['error']['code']==-32600)
            check('unknown method',rpc('not/a/method')['error']['code']==-32601)
            check('GET MCP is POST-only',request('GET')[0]==405)
            check('browser origin refused',request('GET',suffix='/healthz',headers={'Origin':'https://evil.example'})[0]==403)
            check('DNS rebinding host refused',request('GET',suffix='/healthz',headers={'Host':'evil.example'})[0]==403)
            tokens=['hcs-0123456789abcdef','hcs-fedcba9876543210']
            replies=[payload(call('host_probe',echo_token=t)) for t in tokens]
            check('two live results same host',all(r['host_id']=='test-host' and r['echo_token']==t for r,t in zip(replies,tokens)) and replies[0]['utc']!=replies[1]['utc'])
            check('token hashes in host log',all(hashlib.sha256(t.encode()).hexdigest() in log.read_text() for t in tokens))
            check('raw tokens not logged',all(t not in log.read_text() for t in tokens))
            check('bad probe args rejected',call('host_probe',echo_token='x'*257)['isError'])
            if not control:
                check('shell disabled without authorization',call('execute_terminal',command='true')['isError']); return
            file=str(Path(d)/'note.txt')
            check('file write',not call('write_file',filename=file,content='hello\n')['isError'])
            check('overwrite requires explicit flag',call('write_file',filename=file,content='wrong')['isError'])
            check('file read',payload(call('read_file',filename=file))['text']=='hello\n')
            check('read_file has no nested content envelope', 'content' not in payload(call('read_file',filename=file)))
            check('directory listing',any(x['name']=='note.txt' for x in payload(call('list_directory',directory=d))))
            fake='sk-'+'x'*30
            call('write_file',filename=file,content='OPENAI_API_KEY='+fake,overwrite=True)
            check('file credentials redacted',fake not in payload(call('read_file',filename=file))['text'])
            r=payload(call('execute_terminal',command="Write-Output shell-ok; (Get-Location).Path" if WINDOWS else 'printf shell-ok; pwd',directory=d))
            check('real shell executed',r['exit_code']==0 and 'shell-ok' in r['stdout'] and (any(Path(line).is_dir() and Path(line).samefile(d) for line in r['stdout'].splitlines() if line.strip()) if WINDOWS else d in r['stdout']),r)
            check('shell exit status',payload(call('execute_terminal',command='exit 7'))['exit_code']==7)
            r=payload(call('execute_terminal',command='Start-Sleep -Seconds 10' if WINDOWS else 'sleep 10',timeout=1))
            check('shell timeout',r['timed_out'])
            if not WINDOWS:
                r=payload(call('execute_terminal',command='exec 1>&- 2>&-; sleep 10',timeout=1))
                check('timeout even after pipes close',r['timed_out'])
            r=payload(call('execute_terminal',command="[Console]::Write('x' * 300000)" if WINDOWS else 'yes x | head -c 300000'))
            check('output bounded',r['truncated'] and len(r['stdout'])<=131072)
            check('negative offset rejected',call('read_file',filename=file,offset=-1)['isError'])
        finally:
            p.terminate(); p.wait(timeout=5)


test(False)
test(True)
print('result: %d passed, %d failed' % (sum(checks),len(checks)-sum(checks)))
sys.exit(0 if all(checks) else 1)
