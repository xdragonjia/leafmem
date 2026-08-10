---
name: leafmem-maintenance
version: "1.0.0"
agent_created: true
description: >
  LeafMem 记忆运维技能——宿主内执行的每周记忆维护 SOP。健康检查（MCP/存储/召回）、
  宿主模型驱动的质量整理（真重复合并、碎片整合、原则蒸馏）、画像刷新、镜像同步。
  触发词：leafmem 维护、记忆整理、每周健康检查、leafmem maintenance、记忆治理、
  consolidation、深度整理。由自动化任务「LeafMem 每周健康检查+深度整理」调用，
  也可手动触发。不依赖外部付费 inferencer——LLM 整理工作由宿主模型通过 MCP 完成。
---

# LeafMem 运维技能 v1.0.0

> 定位：LeafMem 的周期性维护 SOP，由宿主 Agent（WorkBuddy/昆仑小智）在自己的会话内执行。
> **关键设计**：LLM 相关的整理工作（去重判断、碎片整合、原则蒸馏）由宿主模型通过
> `memory_recall` / `memory_write` / `memory_govern` / `memory_organize` 完成，
> 不需要额外配置付费 inferencer API Key——这是与 ops/consolidation.js（内嵌 inferencer
> 走独立 API）的本质区别。两者互补：consolidation.js 做机械去重合并，本技能做语义级精修。

## 执行节奏

**每周一次**（推荐周一 04:00 自动化触发）。理由：
- 记忆增量每周约 20-50 条，每日整理无料可整
- 语义整理是 LLM 重活，每周一次成本可控
- 每日异常告警由「每日观测采集」自动化负责（只读哨兵），不需要每日整理

## 前置纪律（🔴 必守）

1. **先 recall**：`memory_recall(action=recall, message="leafmem 维护 整理 教训")` 召回历史维护教训
2. **删除前必须存档**：全量导出 memory_items 到 JSON 存档（步骤 2.0）
3. **三不碰**：preference 条目、含路径的条目、触发词类条目——不删不改核心内容
4. **有疑虑一律保留**：宁可保守不可误删
5. **走 MCP 接口**：禁止直写 SQLite（id/created_at 会写坏）
6. **scope 铁律**：默认 agent:workbuddy，write 不传 scopeType/scopeId

## 步骤

### 1. 健康检查（只读，2 分钟）

```bash
# MCP 服务状态
pgrep -f leafmem-mcp > /dev/null && echo "✅ MCP running" || echo "❌ MCP NOT RUNNING"
# 存储容量
ls -lh ~/.leafmem/memory.sqlite | awk '{print $5}'
```

```python
# 记忆规模 + FTS 一致性
import sqlite3
conn = sqlite3.connect(os.path.expanduser('~/.leafmem/memory.sqlite'))
total = conn.execute("SELECT COUNT(*) FROM memory_items WHERE scope_type='agent' AND scope_id='workbuddy'").fetchone()[0]
fts = conn.execute("SELECT COUNT(*) FROM memory_items_fts").fetchone()[0]
print(f"memories={total} fts={fts}")
```

canary 验证：`memory_recall(action=recall, message="leafmem scope 纪律")` 应命中已知纪律条目。

### 2. 质量深度整理（宿主模型驱动）

**2.0 全量存档（强制）**

```python
import sqlite3, json, os
from datetime import date
conn = sqlite3.connect(os.path.expanduser('~/.leafmem/memory.sqlite'))
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id,scope_type,scope_id,kind,content,summary,confidence,importance,source,tags_json,metadata_json,created_at,updated_at FROM memory_items ORDER BY updated_at DESC").fetchall()
recs = []
for r in rows:
    d = dict(r); d['tags'] = json.loads(r['tags_json'] or '[]')
    try: d['metadata'] = json.loads(r['metadata_json'] or '{}')
    except: d['metadata'] = {}
    del d['tags_json'], d['metadata_json']; recs.append(d)
out = os.path.expanduser(f'~/WorkBuddy/backups/leafmem-archive-{date.today():%Y%m%d}.json')
json.dump(recs, open(out,'w'), ensure_ascii=False, indent=1)
print(f"存档 {len(recs)} 条 → {out}")
```

**2.1 真重复检测（内容哈希，🔴 禁止前缀聚类）**

前缀 60 字聚类会误判（同一 YAML 头部的不同内容被当成重复）。必须用全文规范化 SHA256：

```python
import hashlib, re
from collections import defaultdict
by_hash = defaultdict(list)
for r in agent_recs:  # scope=agent:workbuddy
    h = hashlib.sha256(re.sub(r'\s+', '', r['content']).encode()).hexdigest()[:16]
    by_hash[h].append(r)
exact_dupes = {h: v for h, v in by_hash.items() if len(v) >= 2}
```

每组保留 importance 最高 + updated_at 最新的一条，其余用 `memory_govern(action=delete, id=..., scopeType=agent, scopeId=workbuddy)` 删除。

**2.2 碎片簇检测与整合**

检测同日期+同 context 的 ≥3 条碎片簇，对每簇：
1. 读取全部条目内容
2. 按**整合九规则**整合为 1-2 条高质量记忆（见下方）
3. `memory_write(action=remember, kind=lesson, importance=0.7, tags=[主题标签], content=整合结果)` 写入
4. 写入成功后逐条 `memory_govern(action=delete)` 删除原碎片
5. 验证：用主题查询 recall，新记忆 score ≥ 0.6

**整合九规则**（全程遵守）：
1. UPDATE 优先于 CREATE——同主题合并进已有条目，不新建近重复
2. 一条只跟踪一个侧面——不混装无关主题
3. 按实体/侧面匹配，不按话题匹配
4. 状态变更简洁更新并带日期
5. CASCADE 级联——状态变更同步所有受影响记忆
6. 解析模糊指代为实体全称
7. PRESERVE HISTORY——重要历史事件永不删除
8. **NO COMPUTATION（铁律）**——禁止 LLM 做算术/推导，只忠实转录
9. 不同主题保持分离

**写入模板**：
```
# {一句话结论，主谓宾完整，含实体全称}
- 场景：{什么任务/什么情况下}
- 内容：{结论/规律/决策}
- 动作：{下次怎么做}
- 来源：{日期 + 确认程度}
```

### 3. 宿主模型蒸馏（替代 inferencer 的 reflect/profile）

MCP 的 `memory_organize(action=reflect/profile)` 需要 inferencer（付费 key）。
宿主内执行时**由宿主模型自己完成蒸馏**：

**3.1 原则蒸馏（reflect 的宿主版）**
1. `memory_recall(action=search, query="", kind=lesson)` 拉取近 30 天 lesson（limit 50）
2. 按 tags 聚类，找 ≥3 条同主题的簇
3. 对每簇：宿主模型阅读全部条目，蒸馏为一条 principle（归纳共性规律，保留各条证据 id 到 metadata.supports）
4. `memory_write(action=remember, kind=principle, importance=0.85, tags=[主题,principle,reflected], metadata={supports:[证据id...]})`
5. 节流：同主题 6 天内已蒸馏过则跳过（查已有 principle 的 reflectedAt）

**3.2 画像刷新（profile 的宿主版）**
1. `memory_recall(action=search, kind=preference)` 拉取全部 preference
2. `memory_recall(action=active_get, kind=profile)` 读当前画像
3. 宿主模型比对：新增/变更的偏好 → 更新对应 section
4. `memory_write(action=active_distill, kind=profile, content=更新后全文)`

**3.3 衰减（纯规则，无需 LLM）**
`memory_organize(action=decay, dryRun=false)` —— 直接调 MCP 即可（不需要 inferencer）。

### 4. 镜像同步

```bash
NODE_PATH=/Users/dragon/.workbuddy/binaries/node/workspace/node_modules \
  /Users/dragon/.workbuddy/binaries/node/versions/22.22.2/bin/node \
  ~/projects/leafmem/ops/mirror-sync.js
```

### 5. 报告

飞书小虾群（chat_id: oc_f2bf98565ce2f849b64335d58f0d09e8）：

```bash
env -u NODE_OPTIONS /Users/dragon/bin/lark-cli im +messages-send \
  --chat-id "oc_f2bf98565ce2f849b64335d58f0d09e8" \
  --text "🦐 leafmem 每周维护\n- 记忆规模: N 条（+/-X）\n- 真重复删除: X 条\n- 碎片整合: X 簇→Y 条\n- 原则蒸馏: X 条新 principle\n- 画像更新: X 个 section\n- decay 降权: X 条"
```

**全部正常且无整理动作 → 静默通过，仅日志留痕，不推送。**

## 与其他组件的分工

| 组件 | 节奏 | 职责 | LLM 依赖 |
|------|------|------|---------|
| 每日观测采集（自动化） | 每日 10:00 | 只读指标 + 异常告警 | 无 |
| 周度观察+飞书提醒（自动化） | 周日 09:00 | 趋势判断 + 行动号召 | 无 |
| **本技能** | 每周（自动化调用） | 语义级质量整理 + 蒸馏 + 画像 | **宿主模型** |
| ops/consolidation.js | 可选手动 | 机械去重合并（大批量时） | 独立 inferencer key |
| memory_organize MCP | 随时 | decay/attribute 等规则操作 | 无（decay 不需要） |

## 更新记录

### v1.0.0（2026-08-10）
- 首版：Phase 9 产品化收尾，把每周健康检查自动化的整理职责收编为技能
- 核心设计：宿主模型驱动蒸馏，替代付费 inferencer 依赖
- 与 ops/consolidation.js 明确分工（机械 vs 语义）
