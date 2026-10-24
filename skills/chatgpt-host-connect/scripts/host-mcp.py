#!/usr/bin/env python3
"""Dependency-free local host control MCP. Same privileges as its login user.

Loopback only. OpenAI Tunnel is the authenticated remote entry, not this HTTP
listener. Shell/file access is intentionally NOT sandboxed. Do not expose the
listener publicly or grant the connector to untrusted users.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
from host_runtime import bounded_process, shell_argv
import sys
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAME = 'chatgpt-host-control'
VERSION = '2.0.0'
PROTOCOLS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')
HOST = '127.0.0.1'
PORT = int(os.environ.get('MCP_PORT', '8801'))
HOST_ID = os.environ.get('MCP_HOST_ID') or uuid.uuid4().hex
CONTROL = os.environ.get('MCP_ALLOW_CONTROL') == '1'
LIMIT = 128 * 1024


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def redact(text):
    text = re.sub(r'\bsk-[A-Za-z0-9_-]{16,}', '[REDACTED]', str(text))
    text = re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----', '[REDACTED PRIVATE KEY]', text)
    return re.sub(r'(?i)((?:[\w-]*(?:api[_-]?key|token|secret|password)[\w-]*)\s*[=:]\s*)[^\s,;]+', r'\1[REDACTED]', text)


def log(text):
    print(now(), text, file=sys.stderr, flush=True)


def schema(name, description, properties, required=(), write=False):
    return {'name': name, 'description': description,
            'inputSchema': {'type': 'object', 'properties': properties, 'required': list(required), 'additionalProperties': False},
            'annotations': {'readOnlyHint': not write, 'destructiveHint': write, 'openWorldHint': write}}


TEXT = {'type': 'string'}
TOOLS = [
    schema('host_ping', 'Return live UTC time and the installation identity.', {}),
    schema('host_probe', 'Return hostname, host_id, UTC and an echoed token; record its hash in the host log.',
           {'echo_token': {'type': 'string', 'maxLength': 256}}, ['echo_token']),
]
if CONTROL:
    TOOLS += [
        schema('execute_terminal', 'Execute PowerShell on Windows or bash on macOS/Linux as the service login user. Not sandboxed. Commands and their children time out; use the OS service manager for persistent programs.',
               {'command': TEXT, 'directory': TEXT, 'timeout': {'type': 'integer', 'minimum': 1, 'maximum': 300}}, ['command'], True),
        schema('read_file', 'Read a UTF-8 file (bounded, credential-looking output redacted). Paths may be absolute.',
               {'filename': TEXT, 'offset': {'type': 'integer', 'minimum': 0}}, ['filename']),
        schema('write_file', 'Write a UTF-8 file. Existing files require overwrite=true. No path sandbox.',
               {'filename': TEXT, 'content': TEXT, 'overwrite': {'type': 'boolean'}}, ['filename', 'content'], True),
        schema('list_directory', 'List up to 1000 entries in an absolute path or login-home-relative directory.', {'directory': TEXT}),
    ]


def resolve(p):
    p = Path(p or '.').expanduser()
    return (p if p.is_absolute() else Path.home() / p).resolve()


def execute(args):
    command = args.get('command')
    if not isinstance(command, str) or not command or len(command) > 65536:
        raise ValueError('command must be a string of 1..65536 characters')
    timeout = args.get('timeout', 60)
    if type(timeout) is not int or not 1 <= timeout <= 300:
        raise ValueError('timeout must be 1..300 seconds')
    result = bounded_process(shell_argv(command), resolve(args.get('directory', '.')), timeout, LIMIT,
                             env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
    return {**result, 'stdout': redact(result['stdout']), 'stderr': redact(result['stderr'])}


def call_tool(name, args):
    try:
        if not isinstance(args, dict):
            raise ValueError('arguments must be an object')
        spec = next((t for t in TOOLS if t['name'] == name), None)
        if spec is None:
            raise ValueError('Unknown or disabled tool')
        shape = spec['inputSchema']
        if set(args) - set(shape['properties']) or set(shape['required']) - set(args):
            raise ValueError('Missing or unknown arguments')
        if name in ('host_probe', 'host_ping'):
            result = {'hostname': platform.node(), 'host_id': HOST_ID, 'utc': now(), 'pong': True}
            if name == 'host_probe':
                tok = args['echo_token']
                if not isinstance(tok, str) or len(tok) > 256:
                    raise ValueError('echo_token must be a string <=256 characters')
                result['echo_token'] = tok
                log('probe_result host_id=%s token_sha256=%s' % (HOST_ID, hashlib.sha256(tok.encode()).hexdigest()))
        elif name == 'execute_terminal':
            result = execute(args)
            log('shell_result host_id=%s command_sha256=%s exit_code=%s timed_out=%s' % (
                HOST_ID, hashlib.sha256(args['command'].encode()).hexdigest(),
                result['exit_code'], int(result['timed_out'])))
        elif name == 'read_file':
            p = resolve(args['filename'])
            offset = args.get('offset', 0)
            if type(offset) is not int or offset < 0:
                raise ValueError('offset must be nonnegative')
            with p.open('rb') as f:
                f.seek(offset); data = f.read(LIMIT); end = f.tell()
            result = {'path': str(p), 'text': redact(data.decode(errors='replace')), 'next_offset': end, 'eof': end >= p.stat().st_size}
        elif name == 'write_file':
            p = resolve(args['filename'])
            content = args['content']
            if not isinstance(content, str) or len(content.encode()) > LIMIT:
                raise ValueError('content must be a UTF-8 string <=128 KiB')
            if type(args.get('overwrite', False)) is not bool:
                raise ValueError('overwrite must be boolean')
            with p.open('w' if args.get('overwrite') else 'x', encoding='utf-8') as f:
                f.write(content)
            result = {'path': str(p), 'bytes': len(content.encode())}
        else:
            p = resolve(args.get('directory', '.'))
            result = [{'name': x.name, 'directory': x.is_dir()} for x in sorted(p.iterdir())[:1000]]
        return {'content': [{'type': 'text', 'text': json.dumps(result)}], 'isError': False}
    except Exception as e:
        return {'content': [{'type': 'text', 'text': redact(str(e))}], 'isError': True}


def handle_rpc(body):
    if not isinstance(body, dict):
        return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid Request'}}
    method, rid = body.get('method'), body.get('id')
    params = body.get('params') or {}
    if not isinstance(params, dict):
        return {'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32602, 'message': 'Invalid params'}}
    if str(method).startswith('notifications/'):
        return None
    if method == 'initialize':
        version = params.get('protocolVersion')
        result = {'protocolVersion': version if version in PROTOCOLS else PROTOCOLS[0],
                  'capabilities': {'tools': {'listChanged': False}}, 'serverInfo': {'name': NAME, 'version': VERSION}}
    elif method == 'ping':
        result = {}
    elif method == 'tools/list':
        result = {'tools': TOOLS}
    elif method == 'tools/call':
        name = params.get('name')
        log('rpc method=tools/call tool=' + (name if name in {t['name'] for t in TOOLS} else 'unknown'))
        result = call_tool(name, params.get('arguments', {}))
    else:
        return {'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32601, 'message': 'Method not found'}}
    return {'jsonrpc': '2.0', 'id': rid, 'result': result}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def send(self, code, payload=None):
        raw = b'' if payload is None else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        if code == 405:
            self.send_header('Allow', 'POST')
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    def allowed(self):
        # Block browser-origin and DNS-rebinding requests to this local controller.
        host = self.headers.get('Host', '').split(':')[0]
        if self.headers.get('Origin') or host not in ('localhost', '127.0.0.1'):
            self.send(403, {'error': 'Local MCP access only'})
            return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        if self.path == '/healthz':
            self.send(200, {'status': 'ok', 'host_id': HOST_ID, 'control': CONTROL, 'server': NAME})
        else:
            self.send(405 if self.path == '/mcp' else 404)

    def do_DELETE(self):
        self.send(405)

    def do_POST(self):
        if not self.allowed():
            return
        if self.path != '/mcp':
            self.send(404); return
        try:
            n = int(self.headers.get('Content-Length', '0'))
            if not 0 < n <= 1024 * 1024:
                self.send(413); self.close_connection = True; return
            body = json.loads(self.rfile.read(n))
        except (ValueError, UnicodeError):
            self.send(400); return
        if isinstance(body, list):
            result = [r for b in body if (r := handle_rpc(b)) is not None]
        else:
            result = handle_rpc(body)
        self.send(200 if result is not None else 202, result)

    def log_message(self, *args):
        pass  # Never log caller paths, commands, credentials or file contents.


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    log('%s listening on loopback port %s control=%s' % (NAME, PORT, CONTROL))
    server.serve_forever()


if __name__ == '__main__':
    main()
