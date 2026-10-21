#!/usr/bin/env python3
"""Offline protocol test for scripts/muse-mcp.py. Usage: python3 tests/test-mcp.py"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "skills", "muse-chatgpt-setup", "scripts", "muse-mcp.py")

s = socket.socket(); s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]; s.close()
URL = "http://127.0.0.1:%d/mcp" % PORT
proc = subprocess.Popen([sys.executable, SERVER], env=dict(os.environ, MCP_PORT=str(PORT)),
                        stderr=subprocess.PIPE, stdout=subprocess.DEVNULL)
results = []


def check(name, cond):
    results.append(bool(cond))
    print(("  PASS " if cond else "  FAIL ") + name)


def http(method, body=None, url=URL):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json",
                                          "Accept": "application/json, text/event-stream"})
    try:
        r = urllib.request.urlopen(req, timeout=5)
        raw = r.read()
        return r.status, dict(r.headers), (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, dict(e.headers), (json.loads(raw) if raw else None)


try:
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close(); break
        except OSError:
            time.sleep(0.1)

    st, h, b = http("POST", {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                             "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                        "clientInfo": {"name": "t", "version": "0"}}})
    check("initialize -> 200 + protocolVersion echoed", st == 200 and b["result"]["protocolVersion"] == "2025-06-18")
    check("initialize -> MCP-Session-Id header", any(k.lower() == "mcp-session-id" for k in h))
    check("initialize -> tools capability", "tools" in b["result"]["capabilities"])

    st, _, b = http("POST", {"jsonrpc": "2.0", "method": "notifications/initialized"})
    check("notifications/initialized -> 202, empty body", st == 202 and b is None)

    st, _, b = http("POST", {"jsonrpc": "2.0", "id": 2, "method": "ping"})
    check("ping -> 200 + empty result", st == 200 and b == {"jsonrpc": "2.0", "id": 2, "result": {}})

    st, _, b = http("POST", {"jsonrpc": "2.0", "id": 3, "method": "tools/list"})
    names = sorted(t["name"] for t in b["result"]["tools"])
    check("tools/list -> muse_ping, muse_vm_exec", names == ["muse_ping", "muse_vm_exec"])

    st, _, b = http("POST", {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                             "params": {"name": "muse_ping", "arguments": {}}})
    check("tools/call muse_ping -> pong", json.loads(b["result"]["content"][0]["text"])["pong"] is True)

    payloads = []
    for i, tok in enumerate(("tok-a1", "tok-b2")):
        st, _, b = http("POST", {"jsonrpc": "2.0", "id": 10 + i, "method": "tools/call",
                                 "params": {"name": "muse_vm_exec",
                                            "arguments": {"command": "status_echo", "echo_token": tok}}})
        p = json.loads(b["result"]["content"][0]["text"])
        payloads.append(p)
        check("tools/call muse_vm_exec echoes %s, has hostname+utc" % tok,
              b["result"]["isError"] is False and p["echo_token"] == tok and p["hostname"] and p["utc"].endswith("Z"))
        if i == 0:
            time.sleep(1.1)
    check("two calls return different utc", payloads[0]["utc"] != payloads[1]["utc"])

    st, _, b = http("POST", {"jsonrpc": "2.0", "id": 20, "method": "tools/call",
                             "params": {"name": "muse_vm_exec", "arguments": {"command": "rm -rf /"}}})
    check("non-whitelisted command refused", b["result"]["isError"] is True and "refused" in b["result"]["content"][0]["text"])

    st, _, b = http("POST", {"jsonrpc": "2.0", "id": 21, "method": "no/such"})
    check("unknown method -> -32601", b["error"]["code"] == -32601)

    st, h, _ = http("GET")
    check("GET /mcp -> 405 with Allow: POST", st == 405 and h.get("Allow") == "POST")
    st, _, _ = http("DELETE")
    check("DELETE /mcp -> 405", st == 405)
    st, _, b = http("GET", url="http://127.0.0.1:%d/healthz" % PORT)
    check("GET /healthz -> 200", st == 200 and b["status"] == "ok")

    st, _, b = http("POST", [{"jsonrpc": "2.0", "id": 30, "method": "ping"},
                             {"jsonrpc": "2.0", "method": "notifications/initialized"}])
    check("batch -> one response for the one request", st == 200 and isinstance(b, list) and len(b) == 1)
finally:
    proc.terminate()
    err = proc.communicate(timeout=5)[1].decode()

check("log lines carry UTC timestamps", all(l[:4].isdigit() and "Z " in l[:40] for l in err.strip().splitlines()))
print("\nresult: %d passed, %d failed" % (results.count(True), results.count(False)))
sys.exit(0 if all(results) else 1)
