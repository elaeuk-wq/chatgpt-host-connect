#!/usr/bin/env python3
"""Minimal, dependency-free MCP server (Streamable HTTP) for tunnel smoke tests.

Tools
  muse_ping      -> {"pong": true, "utc": <ISO8601 Z>}
  muse_vm_exec   -> runs ONE whitelisted command with a fixed argv (no shell)

Design notes
  * stdlib only: works on a bare Linux box with python3 >= 3.8
  * never executes caller-supplied text: the only accepted command name is
    an enum, mapped to a hardcoded argv list
  * tool descriptions state facts only - no "this is harmless" arguments,
    which chat clients correctly treat as an attempt to game risk scoring
  * every log line carries a UTC ISO8601 timestamp so it can be correlated
    with the tunnel client's log
"""
import json
import os
import platform
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAME = "muse-native-mcp"
VERSION = "1.0.0"
PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
HOST = os.environ.get("MCP_HOST", "127.0.0.1")
PORT = int(os.environ.get("MCP_PORT", "8801"))
MAX_OUTPUT = 4096
TIMEOUT = 5

# The only executable action this server exposes.
WHITELIST = {
    "status_echo": ["/bin/sh", "-c", "hostname; date -u +%Y-%m-%dT%H:%M:%SZ"],
}

TOOLS = [
    {
        "name": "muse_ping",
        "description": "Returns a UTC timestamp. Used to check that the MCP link is alive.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "muse_vm_exec",
        "description": (
            "Runs the whitelisted command 'status_echo' on this VM with a fixed argument vector "
            "(no shell interpolation of caller data) and returns the hostname, a UTC timestamp and "
            "the caller-supplied echo_token verbatim. Command name is an enum; no arbitrary command text is accepted."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "enum": list(WHITELIST), "description": "Command name."},
                "echo_token": {"type": "string", "maxLength": 256, "description": "Echoed back verbatim."},
            },
            "required": ["command"],
            "additionalProperties": False,
        },
    },
]


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def log(msg):
    sys.stderr.write("%s %s\n" % (now(), msg))
    sys.stderr.flush()


def rpc_result(rid, result):
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def rpc_error(rid, code, message):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def call_tool(name, args):
    if name == "muse_ping":
        return {"content": [{"type": "text", "text": json.dumps({"pong": True, "utc": now()})}], "isError": False}

    if name == "muse_vm_exec":
        cmd = (args or {}).get("command")
        if cmd not in WHITELIST:
            return {"content": [{"type": "text",
                                 "text": "refused: %r is not whitelisted; allowed: %s" % (cmd, list(WHITELIST))}],
                    "isError": True}
        token = (args or {}).get("echo_token")
        if token is not None and (not isinstance(token, str) or len(token) > 256):
            return {"content": [{"type": "text", "text": "refused: echo_token must be a string <= 256 chars"}],
                    "isError": True}
        try:
            proc = subprocess.run(WHITELIST[cmd], capture_output=True, text=True,
                                  timeout=TIMEOUT, shell=False)
            lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
            payload = {
                "hostname": lines[0] if lines else platform.node(),
                "utc": lines[1] if len(lines) > 1 else now(),
                "echo_token": token,
                "exit_code": proc.returncode,
            }
            if proc.returncode != 0:
                payload["stderr"] = proc.stderr[-MAX_OUTPUT:]
            text = json.dumps(payload)[:MAX_OUTPUT]
            return {"content": [{"type": "text", "text": text}], "isError": proc.returncode != 0}
        except subprocess.TimeoutExpired:
            return {"content": [{"type": "text", "text": "timeout after %ss" % TIMEOUT}], "isError": True}
        except Exception as exc:  # noqa: BLE001 - report, never crash the server
            return {"content": [{"type": "text", "text": "error: %s" % exc}], "isError": True}

    return {"content": [{"type": "text", "text": "unknown tool: %s" % name}], "isError": True}


def handle_rpc(body, session_id):
    method = body.get("method")
    rid = body.get("id")

    if method == "initialize":
        requested = (body.get("params") or {}).get("protocolVersion")
        version = requested if requested in PROTOCOLS else PROTOCOLS[0]
        log("rpc method=initialize proto=%s" % version)
        return rpc_result(rid, {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": NAME, "version": VERSION},
        }), None, 200

    if method == "ping":
        return rpc_result(rid, {}), None, 200

    if method == "tools/list":
        log("rpc method=tools/list")
        return rpc_result(rid, {"tools": TOOLS}), None, 200

    if method == "tools/call":
        params = body.get("params") or {}
        log("rpc method=tools/call tool=%s" % params.get("name"))
        return rpc_result(rid, call_tool(params.get("name"), params.get("arguments") or {})), None, 200

    if method and str(method).startswith("notifications/"):
        log("rpc notification=%s" % method)
        return None, None, 202

    if rid is None:
        return None, None, 202

    log("rpc unsupported method=%s" % method)
    return rpc_error(rid, -32601, "method not found: %s" % method), None, 200


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload=None, extra_headers=None):
        raw = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("MCP-Session-Id", self.server.session_id)
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    def do_GET(self):  # health / liveness
        path = self.path.split("?", 1)[0].rstrip("/")
        if path == "/mcp":
            # Streamable HTTP: this server offers no server-initiated SSE stream.
            # 405 (not 404) tells clients the session is fine, just no GET stream.
            self._send(405, {"error": "method not allowed"}, {"Allow": "POST"})
        elif path in ("", "/healthz", "/readyz"):
            self._send(200, {"status": "ok", "server": NAME, "version": VERSION, "utc": now()})
        else:
            self._send(404, {"error": "not found"})

    def do_DELETE(self):  # no session teardown to do
        if self.path.split("?", 1)[0].rstrip("/") == "/mcp":
            self._send(405, {"error": "method not allowed"}, {"Allow": "POST"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?", 1)[0].rstrip("/") != "/mcp":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send(400, {"error": "invalid json"})
            return

        if isinstance(body, list):  # batched
            out = []
            for item in body:
                res, _, code = handle_rpc(item, self.server.session_id)
                if res is not None:
                    out.append(res)
            if out:
                self._send(200, out)
            else:
                self._send(202)
            return

        res, _, code = handle_rpc(body, self.server.session_id)
        self._send(code, res)

    def log_message(self, fmt, *args):  # one structured line per request
        log("%s %s" % (self.address_string(), fmt % args))


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.session_id = uuid.uuid4().hex
    pid_file = os.environ.get("MCP_PID_FILE")
    if pid_file:
        with open(pid_file, "w") as f:
            f.write(str(os.getpid()))
    log("%s %s listening on http://%s:%d/mcp" % (NAME, VERSION, HOST, PORT))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutdown")


if __name__ == "__main__":
    main()
