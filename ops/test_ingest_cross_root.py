#!/usr/bin/env python3
"""test_ingest_cross_root.py — ingest-daily-logs.py 跨源根记账回归测试

为什么需要它（2026-10-26）：`ops/ingest-daily-logs.py` 是纯 ops 脚本，不在
`npm test`（test/*.test.ts）覆盖范围内。跨源根静默丢内容与 state 键迁移这两类
缺陷**都不会报错**，只能靠参数化复现捕捉，故单列成脚本常驻。

跑法：
  python3 ops/test_ingest_cross_root.py            # 全绿 exit 0
  python3 ops/test_ingest_cross_root.py -v         # 打印每步细节

四个用例（对应 2026-10-26 实测缺陷）：
  T1 source_root_tag：目录与文件名两种入参必须返回同一标签（--rebuild-state 同构前提）
  T2 跨源根不丢内容：两源根同名文件同节标题、内容不同 → 两段都要入库（修前丢一段）
  T3 幂等：同源重跑 0 新增
  T4 旧 state 键迁移：单源下无前缀旧键补前缀后 offset 保留、且落盘
"""
from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "ingest-daily-logs.py"
PY = sys.executable
VERBOSE = "-v" in sys.argv
TMP = Path("/tmp/leafmem_ingest_regress")

fails: list[str] = []


def ok(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'✅' if cond else '❌'} {name}{(' :: ' + detail) if detail and not cond else ''}")
    if not cond:
        fails.append(name)


# --------------------------------------------------------------- 假 API
class _Sink:
    def __init__(self) -> None:
        self.items: list[dict] = []
        self.lock = threading.Lock()


def start_fake_api(sink: _Sink):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            mems = body.get("memories") or []
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


def run_ingest(sources: list[tuple[str, Path]], state: Path, port: int,
               extra: list[str] | None = None) -> subprocess.CompletedProcess:
    cmd = [PY, str(SCRIPT)]
    for tag, p in sources:
        cmd += ["--source", f"{tag}={p}"]
    cmd += ["--api", f"http://127.0.0.1:{port}", "--state", str(state)]
    cmd += extra or []
    return subprocess.run(cmd, capture_output=True, text=True)


def main() -> int:
    if TMP.exists():
        shutil.rmtree(TMP)
    TMP.mkdir(parents=True)

    # ---- T1 根标签推导（目录 vs 文件同标签）
    print("T1 source_root_tag 目录/文件同标签")
    sys.path.insert(0, str(HERE))
    import importlib.util
    spec = importlib.util.spec_from_file_location("ing", SCRIPT)
    ing = importlib.util.module_from_spec(spec)
    sys.modules["ing"] = ing
    spec.loader.exec_module(ing)
    for dirp, filep, exp in [
        (Path.home() / ".workbuddy/memory", Path.home() / ".workbuddy/memory/2026-10-21.md", "home"),
        (Path.home() / "WorkBuddy/mission/.workbuddy/memory",
         Path.home() / "WorkBuddy/mission/.workbuddy/memory/2026-10-21.md", "mission"),
    ]:
        if not dirp.exists():
            print(f"  ⏭  跳过（目录不存在）：{dirp}")
            continue
        a, b = ing.source_root_tag(dirp), ing.source_root_tag(filep)
        ok(f"dir==file=={exp}", a == b == exp, f"dir={a!r} file={b!r}")
    ta, tb = TMP / "rootA", TMP / "rootA/2026-10-20.md"
    ok("tmp 目录/文件同标签", ing.source_root_tag(ta) == ing.source_root_tag(tb) == "roota")

    # ---- 夹具
    ra, rb = TMP / "rootA", TMP / "rootB"
    ra.mkdir(); rb.mkdir()
    body_a = "甲根记录：本批消化1,092件，组187，剩余626件待处理，来源为集团调阅第九批材料，含四套会议纪要与两处复核结论。"
    body_b = "乙根记录：本批消化7399件，组379，全量完成，覆盖四套会议材料与两批台账，另有11处待复核项已登记在册。"
    (ra / "2026-10-20.md").write_text("## 收口补正\n" + body_a + "\n", encoding="utf-8")
    (rb / "2026-10-20.md").write_text("## 收口补正\n" + body_b + "\n", encoding="utf-8")

    sink = _Sink()
    srv, port = start_fake_api(sink)

    # ---- T2 同 run 双源：两块都要入库（旧实现两块都发 = 重复风险）
    print("T2 同 run 双源同名节内容不同 → 两段都入库")
    state = TMP / "state.json"
    r = run_ingest([("rootA", ra), ("rootB", rb)], state, port, ["--force-fresh"])
    if VERBOSE:
        print(r.stdout, r.stderr)
    got = "".join(m.get("content") or "" for m in sink.items)
    ok("入库 2 块", len(sink.items) == 2, f"实得 {len(sink.items)}")
    ok("甲根内容在库", "甲根记录" in got)
    ok("乙根内容在库", "乙根记录" in got)
    ok("state 键均带源根前缀", all("|" in k for k in json.loads(state.read_text())["secs"]))

    # ---- T2b 跨 run 新增源：这是旧实现真正「静默丢内容」的场景
    # 旧实现同 key 共用 offset：先入 rootA（offset 推到 A 的长度），下一轮才加 rootB，
    # 则 len(body_b) - offset <= 0 被判「已入」→ rootB 整节丢弃且无报错。
    print("T2b 跨 run 追加密源 → 新增源内容不得被丢弃")
    sink2 = _Sink()
    srv2, port2 = start_fake_api(sink2)
    st2 = TMP / "state_2run.json"
    # 第一轮：只有 rootA
    run_ingest([("rootA", ra)], st2, port2, ["--force-fresh"])
    first = len(sink2.items)
    # 第二轮：加入 rootB（内容与 A 不同、长度更短）
    run_ingest([("rootA", ra), ("rootB", rb)], st2, port2)
    got2 = "".join(m.get("content") or "" for m in sink2.items)
    ok("首轮入库 1 块", first == 1, f"实得 {first}")
    ok("追加源内容已入库（修前静默丢弃）", "乙根记录" in got2,
       f"第二轮仅新增 {len(sink2.items) - first} 块")
    srv2.shutdown()

    # ---- T3 幂等
    print("T3 同源重跑幂等")
    before = len(sink.items)
    r = run_ingest([("rootA", ra), ("rootB", rb)], state, port)
    ok("重跑 0 新增", len(sink.items) == before, f"{before} → {len(sink.items)}")
    ok("输出无新增", "无新增" in (r.stdout or ""))

    # ---- T4 旧 state 键迁移落盘
    print("T4 旧格式 state 键迁移（单源）")
    s2 = TMP / "state_old.json"
    import hashlib
    k_old = f"2026-10-20.md:{hashlib.md5('收口补正'.encode()).hexdigest()[:10]}"
    s2.write_text(json.dumps({"version": 3, "secs": {k_old: {"offset": len(body_a), "n": 1}},
                              "seen": {}}, ensure_ascii=False), encoding="utf-8")
    before = len(sink.items)
    r = run_ingest([("rootA", ra)], s2, port)
    d = json.loads(s2.read_text())
    ok("迁移后全部带前缀", all("|" in k for k in d["secs"]), str(list(d["secs"])))
    ok("offset 保留", any(v.get("offset") == len(body_a) for v in d["secs"].values()))
    ok("未重复入库", len(sink.items) == before, f"{before} → {len(sink.items)}")
    ok("落盘提示存在", "落盘" in (r.stdout or "") or "已迁移" in (r.stdout or ""))

    # ---- T5 rebuild-state 与写入键同构
    print("T5 --rebuild-state 与写入键同构")
    db = TMP / "fake.sqlite"
    con = sqlite3.connect(db)
    # 列名必须与真实 memory_items 一致（rebuild_state 会读 content 做正文定位）
    con.execute("CREATE TABLE memory_items (id TEXT, metadata_json TEXT, content TEXT)")
    for i, m in enumerate(sink.items):
        meta = m.get("metadata") or {}
        con.execute("INSERT INTO memory_items VALUES (?,?,?)",
                    (f"x{i}", json.dumps(meta, ensure_ascii=False),
                     m.get("content") or ""))
    con.commit()
    con.close()
    reb = TMP / "rebuilt.json"
    subprocess.run([PY, str(SCRIPT), "--rebuild-state", "--db", str(db), "--state", str(reb)],
                   capture_output=True, text=True)
    a = set(json.loads(state.read_text())["secs"])
    b = set(json.loads(reb.read_text())["secs"])
    ok("写入键 ⊆ 重建键", a <= b, f"a={sorted(a)} b={sorted(b)}")
    ok("重建键均带前缀", all("|" in k for k in b))

    # ---- T6 跨源根同文内容级幂等（2026-10-26 实测 103 组重复的根因）
    print("T6 跨源根【同文】只入一次")
    sink3 = _Sink()
    srv3, port3 = start_fake_api(sink3)
    ra2, rb2 = TMP / "sameA", TMP / "sameB"
    ra2.mkdir(); rb2.mkdir()
    same = "这是两个源根中完全相同的正文内容，用于验证内容级幂等是否生效，必须只入库一次而不是两次。" * 3
    (ra2 / "2026-10-20.md").write_text("## 相同节\n" + same + "\n", encoding="utf-8")
    (rb2 / "2026-10-20.md").write_text("## 相同节\n" + same + "\n", encoding="utf-8")
    st3 = TMP / "state_same.json"
    run_ingest([("sameA", ra2), ("sameB", rb2)], st3, port3, ["--force-fresh"])
    ok("同文跨根仅 1 块", len(sink3.items) == 1, f"实得 {len(sink3.items)}")
    srv3.shutdown()

    # ---- T7 同文件同名节必须各自记账（2026-10-26 实测 15 条 offset 虚高）
    # 🔴 必须用【跨轮】场景：同一轮内 offset 只在发送成功后才记账，同名节不会互吞；
    # 真实缺陷在第 2 轮 —— 首轮把第 1 个同名节的 offset 写满，第 2 轮其余同名节
    # 算出 len(body)-offset<=0 被判「已入」而整节丢弃。
    print("T7 同文件多个同名节（跨轮）→ 内容不得互相吞掉")
    sink4 = _Sink()
    srv4, port4 = start_fake_api(sink4)
    rd = TMP / "duptitle"
    rd.mkdir()
    sec = ("这是同名节的正文，内容必须独立入库，不能被前一个同名节吞掉，否则就是静默丢内容。"
           "填充长度以越过 GROW_THRESHOLD 阈值。" * 3)
    (rd / "2026-06-30.md").write_text("## 关键教训\n" + sec + "\n", encoding="utf-8")
    st4 = TMP / "state_dup.json"
    # 第 1 轮：只有一个同名节
    run_ingest([("dup", rd)], st4, port4, ["--force-fresh"])
    first7 = len(sink4.items)
    # 第 2 轮：文件里变成 3 个同名节，后两个是新增内容
    (rd / "2026-06-30.md").write_text(
        "## 关键教训\n" + sec + "\n"
        + "## 关键教训\n" + sec.replace("这是同名节", "这是第 2 个同名节") + "\n"
        + "## 关键教训\n" + sec.replace("这是同名节", "这是第 3 个同名节") + "\n",
        encoding="utf-8")
    run_ingest([("dup", rd)], st4, port4)
    got4 = "".join(m.get("content") or "" for m in sink4.items)
    ok("首轮入库 1 块", first7 == 1, f"实得 {first7}")
    ok("第 2 个同名节在库（修前被吞）", "第 2 个同名节" in got4)
    ok("第 3 个同名节在库（修前被吞）", "第 3 个同名节" in got4)
    srv4.shutdown()

    srv.shutdown()

    print()
    if fails:
        print(f"❌ FAIL {len(fails)} 项：{fails}")
        return 1
    print("✅ ALL PASS（T1-T7）")
    return 0


if __name__ == "__main__":
    sys.exit(main())