// LeafMem mirror sync (2026-08-10): export all memory_items to the local
// mirror directory so agents have a read-only fallback when the MCP server
// is unreachable (see SOUL.md "降级路径").
//
// 🔴 Historical bug fixed here: the legacy pre-rebrand mirror sync script
// still imported the old repo and read the old brand's frozen database
// (730 records) — the mirror silently diverged from the live ~/.leafmem
// store. This script is the single source of truth and always reads the
// live LeafMem database.
//
// Usage: node ops/mirror-sync.js [--mirror-dir <path>]
// Called by ops/consolidation.js after every run.

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 基于脚本自身位置解析仓库根，避免硬编码绝对路径（0.2.0 审查 M4）
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createLeafMem } = await import(join(REPO_ROOT, "dist", "core", "index.js"));

const scope = { type: "agent", id: "workbuddy" };
// Phase 9.3: no personal paths — default to the current user's home so the
// script ships usable to any machine (npm tarball / other users).
const HOME = homedir();
const DB_PATH = (() => {
  const i = process.argv.indexOf("--db");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : join(HOME, ".leafmem", "memory.sqlite");
})();
const MIRROR_DIR = (() => {
  const i = process.argv.indexOf("--mirror-dir");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : join(HOME, ".leafmem", "mirror");
})();

const memory = createLeafMem({ storage: { backend: "sqlite", path: DB_PATH } });

async function main() {
  const allRecords = await memory.list({ scopes: [scope] });
  // 🔴 先清空 records/ 再重写（0.2.0 审查 M3）：此前只覆盖写 index.json，
  // 已删除记忆的 records/*.json 残留为孤儿文件，agent 仍能从镜像读到被删内容。
  // 删除后重建，保证镜像与活库完全一致。
  rmSync(join(MIRROR_DIR, "records"), { recursive: true, force: true });
  mkdirSync(join(MIRROR_DIR, "records"), { recursive: true });

  // Lightweight index for quick lookups (id + summary + kind)
  const index = allRecords.map((r) => ({
    id: r.id,
    kind: r.kind,
    summary: (r.summary || r.content.slice(0, 120)).trim(),
    updatedAt: r.updatedAt,
  }));
  writeFileSync(join(MIRROR_DIR, "index.json"), JSON.stringify(index, null, 1));

  // Per-record files for exact recall
  for (const r of allRecords) {
    writeFileSync(join(MIRROR_DIR, "records", `${r.id}.json`), JSON.stringify(r, null, 1));
  }

  // Human-readable full dump (grep-able)
  const lines = [];
  for (const r of allRecords) {
    lines.push(`## [${r.kind}] ${r.id}`);
    lines.push(`updated: ${r.updatedAt} | importance: ${r.importance} | source: ${r.source}`);
    lines.push(r.content);
    lines.push("");
  }
  writeFileSync(join(MIRROR_DIR, "full-dump.md"), lines.join("\n"));
  writeFileSync(join(MIRROR_DIR, ".last-sync"), new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));

  console.log(`Mirror: ${allRecords.length} records → ${MIRROR_DIR}/`);
  console.log(`  index.json (${index.length} entries)`);
  console.log(`  records/*.json (${allRecords.length} files)`);
  console.log(`  full-dump.md (${lines.join("\n").length} chars, grep 可用)`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
