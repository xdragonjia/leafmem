#!/usr/bin/env node
// entity-relink.mjs — 实体词表更新后的存量记忆增量补链（纯增量：只加不删）
//
// 背景：strict 抽取器只从控制词表（~/.leafmem/entity-vocab.json）+ 内置词典
// + @提及建实体。词表更新后，存量记忆不会自动重抽——本脚本对每条记忆重新
// 抽取，仅对尚未链接的实体补 upsertEntity + link + relate（三接口均幂等）。
//
// 用法：
//   node ops/entity-relink.mjs --dry   # 预估（强烈建议先跑）
//   node ops/entity-relink.mjs         # 正式执行（跑前请备份 memory.sqlite）
//
// 环境变量：
//   LEAFMEM_DB — 覆盖默认数据库路径 ~/.leafmem/memory.sqlite
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const { SqliteEntityStore, RuleBasedEntityExtractor } = await import(
  join(here, "..", "dist", "entity", "index.js")
);

const DB = process.env.LEAFMEM_DB || join(homedir(), ".leafmem", "memory.sqlite");
const dry = process.argv.includes("--dry");

const store = new SqliteEntityStore(DB);
const extractor = new RuleBasedEntityExtractor({ strict: true });

const ro = new DatabaseSync(DB, { readOnly: true });
const memories = ro.prepare("SELECT id, summary, content FROM memory_items").all();
const before = {
  entities: ro.prepare("SELECT COUNT(*) c FROM entities").get().c,
  links: ro.prepare("SELECT COUNT(*) c FROM entity_links").get().c,
};
ro.close();

let newLinks = 0, relationCalls = 0, touched = 0;

for (const mem of memories) {
  const text = [mem.summary ?? "", mem.content].filter(Boolean).join("\n");
  if (!text.trim()) continue;
  const extracted = await extractor.extract(text);
  if (extracted.length === 0) continue;

  const linkedIds = new Set(
    (await store.getLinkedEntities(mem.id)).map((l) => l.entityId),
  );

  const newlyLinked = [];
  const allStored = [];
  for (const ent of extracted) {
    // dry 模式用 findByName 查真实实体（不创建），使 newLinks 预估=真实增量
    const stored = dry
      ? await store.findByName(ent.name) ?? { id: `dry:${ent.name}` }
      : await store.upsertEntity({ name: ent.name, aliases: ent.aliases, kind: ent.kind });
    allStored.push(stored);
    if (!linkedIds.has(stored.id)) {
      if (!dry) await store.link(stored.id, mem.id, "mentions");
      newLinks++;
      newlyLinked.push(stored);
    }
  }

  if (newlyLinked.length > 0) {
    touched++;
    for (let i = 0; i < allStored.length; i++) {
      for (let j = i + 1; j < allStored.length; j++) {
        const involvesNew = newlyLinked.some(
          (n) => n.id === allStored[i].id || n.id === allStored[j].id,
        );
        if (!involvesNew) continue;
        relationCalls++;
        if (!dry) {
          await store.relate({
            sourceEntityId: allStored[i].id,
            targetEntityId: allStored[j].id,
            relation: "co_occurs",
            memoryId: mem.id,
            confidence: 0.5,
          });
        }
      }
    }
  }
}

const out = { dry, memories: memories.length, touchedMemories: touched, before, newLinks, relationCalls };
if (!dry) {
  const afterDb = new DatabaseSync(DB, { readOnly: true });
  out.after = {
    entities: afterDb.prepare("SELECT COUNT(*) c FROM entities").get().c,
    links: afterDb.prepare("SELECT COUNT(*) c FROM entity_links").get().c,
  };
  afterDb.close();
}
console.log(JSON.stringify(out, null, 1));
