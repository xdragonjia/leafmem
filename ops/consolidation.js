// LeafMem 记忆整理引擎 v8.1
// v8: 底线代码化 + 上限 LLM — 受保护记录不暴露给 LLM，合并建议仅用于未保护记录
// v8.1: 删除记忆后级联清理 principle.supports 悬挂引用（2026-08-10 观测告警修复）
// 模式自动判断 + 内置 API key 读取 + 自动备份 + 容错降级

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 基于脚本自身位置解析仓库根，避免硬编码绝对路径（0.2.0 审查 M4）
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createLeafMem } = await import(join(REPO_ROOT, "dist", "core", "index.js"));
const { createOpenClawInferencer } = await import(join(REPO_ROOT, "dist", "adapters", "openclaw.js"));

const scope = { type: "agent", id: "workbuddy" };
const FULL_SCAN_MAX = 25000;
const DB_PATH = "/Users/dragon/.leafmem/memory.sqlite";
const BACKUP_DIR = "/Users/dragon/.leafmem/backups";

// ===== 自动获取 API key =====
function getApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const mcp = JSON.parse(readFileSync(join(process.env.HOME, ".workbuddy/mcp.json"), "utf-8"));
    return mcp?.mcpServers?.leafmem?.env?.DEEPSEEK_API_KEY || "";
  } catch (_) { return ""; }
}

const API_KEY = getApiKey();
if (!API_KEY) { console.error("FATAL: No DEEPSEEK_API_KEY"); process.exit(1); }

// ===== 自动判断模式 =====
function autoDetectMode() {
  const now = new Date();
  const day = now.getDate();
  const weekday = now.getDay();
  // 🔴 archive 必须先于 monthly 判断：January 首个周一同时满足两者，
  // 若先判 monthly 会提前 return，archive 分支永不可达（0.2.0 审查 M1）。
  if (now.getMonth() === 0 && weekday === 1 && day <= 7) return "archive";
  if (weekday === 1 && day <= 7) return "monthly";
  return "weekly";
}

const MODE = autoDetectMode();

const inferencer = createOpenClawInferencer({
  api: "openai-completions", model: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com", apiKey: API_KEY,
});
const memory = createLeafMem({ storage: { backend: "sqlite", path: DB_PATH }, inferencer });
function now() { return new Date().toISOString(); }

// ===== 自动备份 =====
function backup() {
  try {
    execSync(`mkdir -p "${BACKUP_DIR}"`);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    execSync(`cp "${DB_PATH}" "${BACKUP_DIR}/memory-${ts}.sqlite"`);
    const files = execSync(`ls -t "${BACKUP_DIR}"/memory-*.sqlite 2>/dev/null`, { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean);
    for (const f of files.slice(10)) {
      try { execSync(`rm "${f}"`); } catch (_) {}
    }
  } catch (_) {}
}

async function main() {
  const allRecords = await memory.list({ scopes: [scope] });
  console.error(`Palace: ${allRecords.length} records | Mode: ${MODE} (auto-detected: day=${new Date().getDate()}, weekday=${new Date().getDay()})`);

  let lastMeta = {};
  try {
    const doc = await memory.active.read("experience", scope);
    if (doc?.metadata) lastMeta = doc.metadata;
  } catch (_) {}

  // ===== archive =====
  if (MODE === "archive") {
    const yearAgo = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
    const old = allRecords.filter(r => r.createdAt < yearAgo && r.importance < 0.5);
    console.error(`Archive: ${old.length} candidates`);
    if (old.length > 0) {
      let n = 0;
      for (const r of old) { try { await memory.update(r.id, { importance: 0.05 }); n++; } catch (_) {} }
      console.error(`Archived: ${n}`);
    }
    console.log(`Archive done: ${old.length} downgraded`);
    return;
  }

  // ===== 选择处理范围 =====
  let records;
  let existingExp = "";
  if (MODE === "weekly") {
    const weekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    records = allRecords.filter(r => r.createdAt >= weekAgo);
    try { const d = await memory.active.read("experience", scope); if (d?.content) existingExp = d.content; } catch (_) {}
    if (records.length < 5) { console.log("Weekly: <5 new records, skip"); return; }
  } else {
    records = allRecords.length > FULL_SCAN_MAX
      ? allRecords.filter(r => r.createdAt >= new Date(Date.now() - 30 * 86400 * 1000).toISOString())
      : allRecords;
    if (allRecords.length > FULL_SCAN_MAX) {
      console.error(`Palace ${allRecords.length} > ${FULL_SCAN_MAX} → fallback to 30-day window`);
    }
  }

  console.error(`Processing: ${records.length} records`);

  // ===== 🔴 代码层底线：标记受保护记录（不交给 LLM）=====
  const PROTECTED = new Map();
  const PROTECTED_KINDS = new Set(["preference", "principle"]);

  for (const r of records) {
    if (PROTECTED_KINDS.has(r.kind)) {
      PROTECTED.set(r.id, `kind=${r.kind}`);
    } else if ((r.importance || 0) >= 0.9) {
      PROTECTED.set(r.id, `importance=${r.importance}`);
    }
  }
  console.error(`Protected: ${PROTECTED.size} / ${records.length} (preference/principle | importance≥0.9)`);

  const unprotectedRecords = records.filter(r => !PROTECTED.has(r.id));
  console.error(`Unprotected (sent to LLM): ${unprotectedRecords.length}`);

  // 构建编号 prompt（仅未保护记录）
  const N = {}; const R = {};
  unprotectedRecords.forEach((r, i) => { N[i + 1] = r.id; R[r.id] = i + 1; });
  let prompt = "";
  for (const [kind, recs] of Object.entries(
    unprotectedRecords.reduce((a, r) => { (a[r.kind] ||= []).push(r); return a; }, {})
  )) {
    prompt += `\n## ${kind.toUpperCase()} (${recs.length})\n`;
    for (const r of recs) {
      const t = ((r.summary || "").trim().length > 20 ? r.summary : r.content.slice(0, 150)).trim();
      if (t) prompt += `[#${R[r.id]}] ${t}\n`;
    }
  }
  console.error(`Prompt: ${prompt.length} chars (~${Math.round(prompt.length / 3.5)} tokens)`);

  // ===== Phase 1: LLM 仅建议未保护记录的合并 =====
  const isAggressive = MODE === "monthly";
  const maxGroupSize = isAggressive ? 8 : 5;
  const sysDedup = `Find EXACT duplicate records and suggest merges. Only near-identical content — same facts, same conclusion. Skip "similar" records. Max ${maxGroupSize} per group. Safety first. Output ONLY JSON array, max 15 groups. [[1,2],[3,4,5]] No markdown.`;

  console.error(`[P1] ${isAggressive ? "Aggressive" : "Conservative"} dedup...`);
  const t0 = Date.now();
  let r1;
  try {
    r1 = await inferencer({ system: sysDedup, prompt: `Find exact duplicates:\n${prompt}`, maxChars: isAggressive ? 8000 : 4000 });
  } catch (e) {
    console.error("P1 LLM error:", e.message);
    process.exit(1);
  }
  if (!r1.ok) { console.error("P1 failed:", r1.error); process.exit(1); }
  console.error(`P1: ${Date.now() - t0}ms, ${r1.text.length} chars`);

  let groups = [];
  const text = r1.text.trim().replace(/```json|```/g, "");
  const m = text.match(/\[[\s\S]*\]/);
  if (m) {
    let jsonText = m[0];
    let depth = 0, inStr = false, esc = false;
    for (const c of jsonText) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = !inStr;
      if (!inStr) { if (c === "[" || c === "{") depth++; if (c === "]" || c === "}") depth--; }
    }
    while (depth > 0) { jsonText += "]"; depth--; }
    try { groups = JSON.parse(jsonText); } catch (e) {
      console.error("JSON parse failed, skipping dedup");
    }
  }

  // ===== Phase 1.5: 先升标，后合并（让新升级的记录纳入保护）=====
  let autoUpgraded = 0;
  for (const r of records) {
    if (PROTECTED.has(r.id)) continue;
    const imp = r.importance || 0;
    if (imp >= 0.9) continue;
    
    const content = r.content || "";
    let newImp = imp;
    
    // 降秩测试：高操作信息密度（命令/路径引用 + 具体数值 + 教训标记）
    const cmdCount = (content.match(/`[^`]+`/g) || []).length;
    const numCount = (content.match(/\d{4,}/g) || []).length;
    const lessonMarkers = (content.match(/教训|根因|修复|解法|正确.*做法|错误.*做法|原因.*是/g) || []).length;
    if (cmdCount + numCount + lessonMarkers >= 3 && imp >= 0.6) {
      newImp = Math.max(newImp, numCount >= 3 ? 0.85 : 0.8);
    }
    
    // 芒格错误清单：复发信号
    if (/重复.*踩坑|再犯|≥\s*2|多次.*同样|又.*出现.*问题/g.test(content)) {
      newImp = Math.max(newImp, 0.9);
    }
    
    // 塔勒布尾部风险：灾难性后果信号
    if (/误删|丢失.*数据|崩溃|不可逆|回滚.*恢复|全部.*删除/g.test(content)) {
      newImp = Math.max(newImp, 0.9);
    }
    
    // 张一鸣验证驱动：验证佐证
    if (/✅|已验证|验证通过|确认.*生效|实测.*通过/g.test(content)) {
      newImp = Math.min(newImp + 0.1, 0.9);
    }
    
    if (newImp > imp) {
      try {
        await memory.update(r.id, { importance: Math.round(newImp * 100) / 100 });
        if (newImp >= 0.9) PROTECTED.set(r.id, `auto:${newImp}`);
        autoUpgraded++;
      } catch (_) {}
    }
  }
  console.error(`Auto-importance: upgraded ${autoUpgraded} records → protected now ${PROTECTED.size}`);

  // ===== Phase 2: 执行合并（三重安全校验，保护集已包含新升级记录）=====
  const merges = []; const delIds = new Set();
  for (const g of groups) {
    if (!Array.isArray(g) || g.length < 2) continue;
    // 🔴 一重：大小限制
    if (g.length > maxGroupSize + 1) {
      console.error(`WARNING: group ${g.length} > ${maxGroupSize + 1} → truncating`);
      g.length = maxGroupSize + 1;
    }
    if (g[0] === -1) {
      for (const n of g.slice(1).slice(0, maxGroupSize)) if (N[n]) delIds.add(N[n]);
    } else {
      const keep = N[g[0]]; if (!keep) continue;
      const from = g.slice(1).map(n => N[n]).filter(Boolean);
      // 🔴 二重：过滤保护记录
      const safeFrom = from.filter(id => !PROTECTED.has(id));
      if (safeFrom.length !== from.length) console.error(`Blocked ${from.length - safeFrom.length} protected from merge`);
      if (safeFrom.length > 0) merges.push({ keep, from: safeFrom });
    }
  }
  // 🔴 三重：硬上限防灾难
  const MAX_TOTAL_DELETIONS = isAggressive ? 60 : 20;
  const plannedDel = merges.reduce((s, m) => s + m.from.length, 0) + delIds.size;
  if (plannedDel > MAX_TOTAL_DELETIONS) {
    console.error(`FATAL: planned ${plannedDel} > max ${MAX_TOTAL_DELETIONS}. Aborting all merges.`);
    merges.length = 0; delIds.clear();
  }
  console.error(`Plan: ${merges.length} merges, ${delIds.size} deletes (limit: ${MAX_TOTAL_DELETIONS}, protected: ${PROTECTED.size})`);

  let upd = 0, del = 0;
  if (merges.length + delIds.size > 0) {
    backup();
    for (const m of merges) {
      try {
        const rec = unprotectedRecords.find(r => r.id === m.keep);
        const txt = (rec?.summary || rec?.content || "").slice(0, 300);
        await memory.update(m.keep, { content: txt, summary: txt.slice(0, 200) });
        upd++; for (const id of m.from) delIds.add(id);
      } catch (_) {}
    }
    const keepIds = new Set(merges.map(m => m.keep));
    for (const id of [...delIds]) { if (!keepIds.has(id)) try { await memory.forget(id); del++; } catch (_) {} }
    console.error(`Done: ${upd} updated, ${del} deleted`);

    // 🔴 v8.1 级联清理：删除记忆后，剔除 principle.supports 中指向已删记录的悬挂引用
    const prunedSupports = await pruneDanglingSupports(delIds);
    if (prunedSupports > 0) console.error(`Pruned dangling supports in ${prunedSupports} principles`);
  }

  // 🔴 后置验证：保护记录完整性
  const finalRecords = await memory.list({ scopes: [scope] });
  let protectedLost = 0;
  for (const [id, reason] of PROTECTED) {
    if (!finalRecords.find(r => r.id === id)) {
      console.error(`LOST: protected ${id} (${reason})`);
      protectedLost++;
    }
  }
  if (protectedLost > 0) {
    console.error(`FATAL: ${protectedLost} protected records lost! RESTORE FROM BACKUP!`);
  } else {
    console.error(`Verified: all ${PROTECTED.size} protected records intact`);
  }
  console.error(`Remaining: ${finalRecords.length} (was ${records.length})`);

  // ===== Phase 3: Experience =====
  let ep = "";
  const target = isAggressive ? finalRecords : finalRecords.filter(r => r.createdAt >= new Date(Date.now() - 30 * 86400 * 1000).toISOString());
  for (const [k, rs] of Object.entries(target.reduce((a, r) => { (a[r.kind] ||= []).push(r); return a; }, {}))) {
    ep += `\n## ${k} (${rs.length})\n`;
    for (const r of rs) {
      const s = ((r.summary || "").trim() || r.content.slice(0, 150)).trim();
      if (s) ep += `[${r.createdAt.slice(0, 10)}] ${s}\n`;
    }
  }

  console.error("[P2] Experience...");
  const t2 = Date.now();
  let exp = "";
  try {
    const r2 = await inferencer({
      system: `Consolidate into 核心规则/模式与教训/领域知识/待观察. Chinese, under 3000 chars, dense. Use [N records] for merged items.${existingExp ? `\nBaseline:\n${existingExp.slice(0, 1500)}` : ""}`,
      prompt: `Consolidate${existingExp ? " (merge with baseline)" : ""}:\n${ep}`,
      maxChars: 3200,
    });
    if (r2.ok) exp = r2.text;
  } catch (e) { console.error("P2 LLM error:", e.message); }
  console.error(`P2: ${Date.now() - t2}ms, ${exp.length} chars`);

  if (exp) {
    await memory.active.write({
      scope, kind: "experience", content: exp,
      metadata: {
        source: "leafmem-auto", mode: MODE,
        before: allRecords.length, after: finalRecords.length,
        del, upd, ts: now(),
        nextMonthlyDue: nextMonthlyDue(),
      },
    });
  }

  // 同步 mirror 备份（用当前运行的 node，不再硬编码版本路径；0.2.0 审查 M4）
  try {
    execSync(`NODE_PATH=/Users/dragon/.workbuddy/binaries/node/workspace/node_modules ${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, "ops", "mirror-sync.js"))}`, { encoding: "utf-8", timeout: 30000 });
    console.error("Mirror synced: backups/leafmem-mirror/");
  } catch (e) {
    console.error("Mirror sync failed (non-fatal):", e.message);
  }

  // ===== Report =====
  console.log(`\n===== REPORT [${MODE}] =====`);
  console.log(`${records.length} → ${finalRecords.length} (${records.length - finalRecords.length} removed)`);
  console.log(`Merges: ${upd} groups, Deletes: ${del}`);
  console.log(`Protected: ${PROTECTED.size} (${protectedLost > 0 ? `LOST:${protectedLost}` : "all safe"})`);
  console.log(`Scale: ${finalRecords.length}/${FULL_SCAN_MAX} (${(finalRecords.length / FULL_SCAN_MAX * 100).toFixed(1)}%)`);
  console.log(`Next monthly: ${nextMonthlyDue()}`);
  if (exp) console.log(`\nExperience (${exp.length} chars):\n${exp}`);
}

function nextMonthlyDue() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// 🔴 v8.1 级联清理：consolidation 删除记忆后，principle.metadata.supports 会留下
// 悬挂引用（2026-08-10 观测告警根因）。此函数遍历所有 principle，剔除指向已删
// 记录的 supports 条目，并记录 supportsPrunedAt/Reason。走 memory API，不直写 SQLite。
//
// ⚠️ 保留理由（0.2.0 独立审查 m4，勿删）：核心 forget() 的 supports 级联清理只在
// 单进程 mutationQueue 内生效；而 MCP server 与本 consolidation.js 是两个进程、
// 各自持有独立 mutationQueue——跨进程并发删除存在 lost-update 窗口（一侧清理时
// 读到的还是另一侧删除前的快照）。本函数作为 consolidation 每次运行的全量兜底
// 清扫，恰好弥补该窗口，不可移除。
async function pruneDanglingSupports(removedIds) {
  if (!removedIds || removedIds.size === 0) return 0;
  const all = await memory.list({ scopes: [scope] });
  const existing = new Set(all.map(r => r.id));
  let pruned = 0;
  for (const r of all) {
    if (r.kind !== "principle") continue;
    const supports = r.metadata?.supports;
    if (!Array.isArray(supports) || supports.length === 0) continue;
    const kept = supports.filter(id => typeof id === "string" && existing.has(id));
    if (kept.length !== supports.length) {
      const removedCount = supports.length - kept.length;
      try {
        await memory.update(r.id, {
          metadata: {
            ...r.metadata,
            supports: kept,
            supportsPrunedAt: now(),
            supportsPruneReason: `consolidation removed ${removedCount} support record(s)`,
          },
        });
        pruned++;
      } catch (_) {}
    }
  }
  return pruned;
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
