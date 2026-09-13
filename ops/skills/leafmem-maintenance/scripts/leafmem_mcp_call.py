# -*- coding: utf-8 -*-
"""通用：经 MCP stdio 通道调用 leafmem 工具（HTTP 面未暴露的 organize 类动作）。"""
import json, os, subprocess, sys

CFG = json.load(open(os.path.expanduser('~/.workbuddy/mcp.json'), encoding='utf-8'))['mcpServers']['leafmem']
env = dict(os.environ); env.update(CFG.get('env') or {})
tool = sys.argv[1]
args = json.loads(sys.argv[2])

proc = subprocess.Popen([CFG['command']] + CFG['args'], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=env)
def send(o):
    proc.stdin.write(json.dumps(o, ensure_ascii=False) + "\n"); proc.stdin.flush()
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"leafmem-call","version":"1.0"}}})
send({"jsonrpc":"2.0","method":"notifications/initialized"})
proc.stdout.readline()
send({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":args}})
resp = proc.stdout.readline()
try:
    d = json.loads(resp)
    if "error" in d:
        print("RPC_ERROR:", json.dumps(d["error"], ensure_ascii=False)[:600])
    else:
        for b in (d.get("result",{}).get("content") or []):
            print(b.get("text","")[:1500])
except Exception as e:
    print("PARSE_ERR", e, resp[:400])
proc.terminate()
try: proc.wait(timeout=10)
except Exception: proc.kill()
e = proc.stderr.read()
if e.strip(): print("STDERR:", e[:400])
