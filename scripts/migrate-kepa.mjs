#!/usr/bin/env node
/**
 * leafmem KEPA 数据迁移脚本 (ESM)
 */
import { createLeafMem } from "../dist/core/memory.js";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), ".leafmem", "memory.sqlite");
const BRAIN_EVENTS = join(homedir(), "WorkBuddy", "brain", "events");
const BRAIN_MEMORIES = join(homedir(), "WorkBuddy", "brain", "memories");
const PLAYBOOK_LESSONS = join(homedir(), ".workbuddy", "Playbook", "Lessons");

const SEVERITY_MAP = { critical: 0.95, major: 0.7, minor: 0.4 };

const TYPE_KIND_MAP = {
  lesson: "lesson", error: "experience", insight: "note",
  decision: "decision", milestone: "note", workflow: "note",
  fix: "experience", brain_enhancement: "note", "incident-lesson": "lesson",
  batch_task: "note", governance: "note", event: "note", maintenance: "note",
};

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const fm = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      try { value = JSON.parse(value.replace(/'/g, '"')); } catch {}
    }
    fm[key] = value;
  }
  return { frontmatter: fm, body: match[2].trim() };
}

async function migrate() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const sampleOnly = args.includes("--sample");
  const sampleCount = parseInt(args.find(a => a.startsWith("--count="))?.split("=")[1] || "5");

  console.log(`DB: ${DB_PATH}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : sampleOnly ? `SAMPLE (${sampleCount})` : "FULL"}`);

  const memory = createLeafMem({
    storage: { backend: "sqlite", path: DB_PATH },
    idFactory: () => crypto.randomUUID(),
    retrieval: {
      embeddings: {
        provider: "openai",
        model: "BAAI/bge-m3",
        remote: {
          apiKey: process.env.OPENAI_API_KEY,
          baseUrl: "https://api.siliconflow.cn",
        },
      },
    },
  });

  let stats = { events: 0, memories: 0, lessons: 0, total: 0, skipped: 0, errors: 0 };

  const existing = new Set();
  const allExisting = await memory.list();
  for (const r of allExisting) existing.add(r.content?.trim() || "");

  // === EVENTS ===
  if (existsSync(BRAIN_EVENTS)) {
    const files = readdirSync(BRAIN_EVENTS).filter(f => extname(f) === ".md" && f !== "_TEMPLATE.md").sort();
    for (const file of files) {
      const content = readFileSync(join(BRAIN_EVENTS, file), "utf8");
      if (existing.has(content.trim())) { stats.skipped++; continue; }
      const { frontmatter: fm, body } = parseFrontmatter(content);
      
      // Events are plain markdown without frontmatter - extract heading as summary
      const heading = content.match(/^#\s+(.+)$/m)?.[1] || file.replace(".md", "");
      const kind = TYPE_KIND_MAP[fm.type] || "note";
      const importance = SEVERITY_MAP[fm.severity] || 0.6;
      const tags = Array.isArray(fm.tags) ? [...fm.tags, "kepa-migrated"] : ["kepa-migrated"];

      const record = {
        scope: { type: "user", id: "xiaolong" },
        kind,
        content: body || content,
        summary: (fm.summary || heading || "").slice(0, 200),
        importance,
        source: fm["source-session"] || "kepa_import",
        tags,
        metadata: {
          eventId: fm.id || file.replace(".md", ""),
          migratedFrom: "brain/events",
          solution: fm.solution || "",
          recurrence: fm.recurrence || 0,
        },
      };

      if (!dryRun) {
        try {
          const result = await memory.remember(record);
          existing.add(result.content?.trim());
          stats.events++; stats.total++;
        } catch (e) {
          console.error(`  FAIL: ${file} - ${e.message}`);
          stats.errors++;
        }
      } else { stats.events++; stats.total++; }
    }
    console.log(`  Events: ${stats.events} migrated`);
  }

  // === MEMORIES ===
  if (existsSync(BRAIN_MEMORIES)) {
    const dirs = readdirSync(BRAIN_MEMORIES).filter(d => {
      try { return statSync(join(BRAIN_MEMORIES, d)).isDirectory(); } catch { return false; }
    }).sort();
    for (const dir of dirs) {
      const path = join(BRAIN_MEMORIES, dir, "episodic.jsonl");
      if (!existsSync(path)) continue;
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      let dirCount = 0;
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (!e.content || (e.priority || 0) < 60) { stats.skipped++; continue; }
          if (existing.has(e.content.trim())) { stats.skipped++; continue; }

          const record = {
            scope: { type: "user", id: "xiaolong" },
            kind: e.type === "persona" ? "preference" : "note",
            content: e.content,
            summary: (e.content || "").slice(0, 150),
            importance: (e.priority || 50) / 100,
            source: "kepa_extract",
            tags: ["kepa", "auto-extracted", "kepa-migrated"],
            metadata: { date: e.date || dir, scene: e.scene || "", migratedFrom: "brain/memories" },
          };

          if (!dryRun) {
            await memory.remember(record);
            existing.add(record.content.trim());
            dirCount++; stats.memories++; stats.total++;
          } else { dirCount++; stats.memories++; stats.total++; }
        } catch { stats.skipped++; }
      }
      if (dirCount > 0) console.log(`  Memories: ${dir}/episodic.jsonl → ${dirCount}`);
    }
  }

  // === LESSONS ===
  if (existsSync(PLAYBOOK_LESSONS)) {
    const files = readdirSync(PLAYBOOK_LESSONS).filter(f => extname(f) === ".md").sort();
    const batch = sampleOnly ? files.slice(0, sampleCount) : files;
    for (const file of batch) {
      const content = readFileSync(join(PLAYBOOK_LESSONS, file), "utf8");
      if (existing.has(content.trim())) { stats.skipped++; continue; }
      const heading = content.match(/^#\s+(.+)$/m)?.[1] || file.replace(".md", "");
      const record = {
        scope: { type: "user", id: "xiaolong" },
        kind: "lesson",
        content: content,
        summary: heading.slice(0, 200),
        importance: 0.6,
        source: "playbook_import",
        tags: ["playbook-lesson", "kepa-migrated"],
        metadata: { originFile: `Lessons/${file}`, migratedFrom: "Playbook/Lessons" },
      };
      if (!dryRun) {
        try {
          await memory.remember(record);
          existing.add(content.trim());
          stats.lessons++; stats.total++;
        } catch (e) {
          console.error(`  FAIL: ${file} - ${e.message}`);
          stats.errors++;
        }
      } else { stats.lessons++; stats.total++; }
    }
    console.log(`  Lessons: ${stats.lessons} migrated`);
  }

  console.log(`\n=== Done ===`);
  console.log(JSON.stringify(stats, null, 2));
  
  const after = await memory.list();
  console.log(`DB records: ${after.length}`);
  process.exit(0);
}

migrate().catch(e => { console.error("FATAL:", e.message || e); process.exit(1); });
