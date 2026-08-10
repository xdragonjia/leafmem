// LeafMem mirror sync (2026-08-10): export all memory_items to the local
// mirror directory so agents have a read-only fallback when the MCP server
// is unreachable (see SOUL.md "降级路径").
//
// 🔴 Historical bug fixed here: the legacy marvmem-mirror/sync.js still
// imported /Users/dragon/projects/marvmem and read ~/.marvmem/memory.sqlite
// (frozen at 730 records) — the mirror silently diverged from the live
// ~/.leafmem store. This script is the single source of truth and always
// reads the live LeafMem database.
//
// Usage: node ops/mirror-sync.js [--mirror-dir <path>]
// Called by ops/consolidation.js after every run.

import { createLeafMem } from "/Users/dragon/projects/leafmem/dist/core/index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const scope = { type: "agent", id: "workbuddy" };
const DB_PATH = "/Users/dragon/.leafmem/memory.sqlite";
const MIRROR_DIR = (() => {
  const i = process.argv.indexOf("--mirror-dir");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "/Users/dragon/WorkBuddy/backups/leafmem-mirror";
})();

const memory = createLeafMem({ storage: { backend: "sqlite", path: DB_PATH } });

async function main() {
  const allRecords = await memory.list({ scopes: [scope] });
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
