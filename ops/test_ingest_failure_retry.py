#!/usr/bin/env python3
"""test_ingest_failure_retry.py — ingest 发送失败后的重试语义回归测试

为什么需要它（2026-10-26）：把块指纹在「收集阶段」写入 seen，会让发送失败的块
被永久判为已入——下一轮打印「无新增」并静默丢内容，而 CLI 提示却写着
「失败项下轮自动重试」。这类缺陷只在 API 失败时暴露，正常路径完全看不见。

判据（三条，缺一不可）：
  T1 失败不污染 seen：API 500 后 state.seen 必须为空
  T2 失败可重试：API 恢复后该块必须成功入库（数到 1）
  T3 重试后幂等：第三轮必须 0 新增

跑法：python3 ops/test_ingest_failure_retry.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "ingest-daily-logs.py"
PY = sys.executable
TMP = Path("/tmp/leafmem_ingest_fail_regress")

fails: list[str] = []


def ok(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'✅' if cond else '❌'} {name}{(' :: ' + detail) if detail and not cond else ''}")
    if not cond:
        fails.append(name)


class Sink:
    def __init__(self) -> None:
        self.items: list[dict] = []
        self.mode = "ok"          # ok | fail
        self.lock = threading.Lock()


def start_api(sink: Sink):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            n = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(n) or b"{}"
            if sink.mode == "fail":
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b'{"error":"injected"}')
                return
            mems = json.loads(body).get("memories") or []
            out = []
            with sink.lock:
                for m in mems:
                    rid = f"f{len(sink.items)}"
                    sink.items.append(m)
                    out.append({"id": rid})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"memories": out}).encode())

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def run(port: int, state: Path, src: Path, fresh: bool = False) -> subprocess.CompletedProcess:
    cmd = [PY, str(SCRIPT), "--source", f"r={src}", "--api", f"http://127.0.0.1:{port}",
           "--state", str(state)]
    if fresh:
        cmd.append("--force-fresh")
    return subprocess.run(cmd, capture_output=True, text=True)


def main() -> int:
    if TMP.exists():
        shutil.rmtree(TMP)
    TMP.mkdir(parents=True)
    src = TMP / "root"
    src.mkdir()
    (src / "2026-10-20.md").write_text(
        "## 唯一节\n" + ("这是一段必须入库的正文内容，用于验证发送失败后是否会被永久跳过，绝不能丢。"
                       "GROW_THRESHOLD=40 会把过短的增量判成「无变化」，夹具必须超过它。" * 2) + "\n",
        encoding="utf-8")

    sink = Sink()
    srv, port = start_api(sink)
    state = TMP / "st.json"

    print("T1 API 500 后 seen 必须为空（不污染）")
    sink.mode = "fail"
    r = run(port, state, src, fresh=True)
    d = json.loads(state.read_text())
    ok("seen 为空", len(d["seen"]) == 0, f"seen={len(d['seen'])}")
    ok("输出报失败", "失败 1" in r.stdout or "失败 1" in r.stderr, r.stdout.strip()[-60:])

    print("T2 API 恢复后必须重试成功")
    sink.mode = "ok"
    before = len(sink.items)
    r = run(port, state, src)
    ok("重试入库 1 块", len(sink.items) - before == 1, f"新增 {len(sink.items) - before}")

    print("T3 重试后必须幂等")
    before = len(sink.items)
    r = run(port, state, src)
    ok("第三轮 0 新增", len(sink.items) == before, f"{before} → {len(sink.items)}")

    srv.shutdown()
    print()
    if fails:
        print(f"❌ FAIL {len(fails)} 项：{fails}")
        return 1
    print("✅ ALL PASS（T1-T3）")
    return 0


if __name__ == "__main__":
    sys.exit(main())