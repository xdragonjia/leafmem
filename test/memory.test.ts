import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLeafMem, InMemoryStore } from "../src/core/index.js";
import { InMemoryVectorStore } from "../src/retrieval/vector-memory.js";
import { InMemoryEntityStore } from "../src/entity/store-memory.js";

test("remembers and searches scoped memories", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });

  await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "Alice prefers concise Chinese replies.",
    importance: 0.9,
  });
  await memory.remember({
    scope: { type: "user", id: "bob" },
    kind: "preference",
    content: "Bob prefers detailed English replies.",
  });

  const hits = await memory.search("What reply style does Alice prefer?", {
    scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  });

  assert.equal(hits.length, 1);
  assert.match(hits[0]!.record.content, /Alice prefers concise Chinese replies/);
});

test("search hits expose evidence refs for exact follow-up reads", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });

  const record = await memory.remember({
    scope: { type: "task", id: "release" },
    kind: "decision",
    content: "Use a short release checklist with direct verification steps.",
    source: "codex_session_commit",
    tags: ["release"],
    metadata: { taskId: "codex:release-1", sessionId: "s1" },
  });

  const hits = await memory.search("release checklist", {
    scopes: [{ type: "task", id: "release" }],
  });

  assert.equal(hits[0]?.evidence.recordId, record.id);
  assert.deepEqual(hits[0]?.evidence.tools[0], {
    name: "memory_recall",
    arguments: { action: "get", id: record.id },
  });
  assert.deepEqual(hits[0]?.evidence.tools[1], {
    name: "memory_recall",
    arguments: { action: "task_window", taskId: "codex:release-1", message: "<current query>" },
  });
});

test("builds memory navigation from existing records", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });

  const record = await memory.remember({
    scope: { type: "repo", id: "leafmem" },
    kind: "lesson",
    content: "Keep recall navigation lightweight and point back to exact records.",
    importance: 0.9,
  });

  const navigation = await memory.buildNavigation({
    scopes: [{ type: "repo", id: "leafmem" }],
  });

  assert.match(navigation, /Memory navigation/);
  assert.match(navigation, new RegExp(`memory_recall\\(action=get, id=${record.id}\\)`));
  assert.match(navigation, /lightweight and point back to exact records/);
});

test("builds prompt-ready recall context", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });

  await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "User prefers concise replies in Chinese.",
  });

  const recall = await memory.recall({
    query: "How should I answer this user?",
    scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  });

  assert.equal(recall.hits.length, 1);
  assert.match(recall.injectedContext, /Relevant long-term memory/);
  assert.match(recall.injectedContext, /prefers concise replies in Chinese/);
});

test("deduplicates similar memories instead of creating duplicates", async () => {
  const memory = createLeafMem({ store: new InMemoryStore(), dedupeThreshold: 0.85 });

  const first = await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "Alice prefers concise Chinese replies.",
    importance: 0.5,
    source: "codex",
    tags: ["codex"],
    metadata: { sessionId: "c1" },
  });
  const second = await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "Alice prefers concise Chinese replies.",
    importance: 0.9,
    source: "claude",
    tags: ["claude"],
    metadata: { sessionId: "c2", projectPath: "/repo" },
  });

  // Should have merged: same id, updated importance
  assert.equal(first.id, second.id);
  assert.equal(second.importance, 0.9);
  assert.deepEqual(second.tags, ["codex", "claude"]);
  assert.deepEqual(second.metadata, {
    sessionId: "c1",
    projectPath: "/repo",
    sourceHistory: ["codex", "claude"],
    markerHistory: [
      {
        source: "claude",
        tags: ["claude"],
        metadata: { sessionId: "c2", projectPath: "/repo" },
      },
    ],
  });
  const all = await memory.list({ scopes: [{ type: "user", id: "alice" }] });
  assert.equal(all.length, 1);
});

test("sqlite stores concurrent writes from separate instances without clobbering", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafmem-sqlite-concurrent-"));
  const path = join(root, "memory.sqlite");
  const first = createLeafMem({ storage: { backend: "sqlite", path } });
  const second = createLeafMem({ storage: { backend: "sqlite", path } });

  await Promise.all([
    first.remember({
      scope: { type: "agent", id: "codex" },
      kind: "note",
      content: "Codex wrote the release note.",
      source: "codex",
    }),
    second.remember({
      scope: { type: "agent", id: "claude" },
      kind: "note",
      content: "Claude wrote the migration note.",
      source: "claude",
    }),
  ]);

  const reader = createLeafMem({ storage: { backend: "sqlite", path } });
  const all = await reader.list();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((record) => record.source).sort(), ["claude", "codex"]);
});

test("sqlite write waits for another process instead of failing while locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafmem-sqlite-locked-"));
  const path = join(root, "memory.sqlite");
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(path)}, { timeout: 10000 });
    db.exec("PRAGMA busy_timeout = 10000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY);");
    db.exec("BEGIN IMMEDIATE;");
    db.prepare("INSERT INTO lock_probe DEFAULT VALUES").run();
    console.log("locked");
    setTimeout(() => {
      db.exec("COMMIT");
      db.close();
      console.log("released");
    }, 250);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 2_000;
  while (!stdout.includes("locked")) {
    const exit = child.exitCode;
    if (exit !== null) {
      assert.fail(`lock holder exited early (${exit}): ${stderr}`);
    }
    if (Date.now() > deadline) {
      child.kill();
      assert.fail(`lock holder did not acquire lock: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const memory = createLeafMem({ storage: { backend: "sqlite", path } });
  await memory.remember({
    scope: { type: "agent", id: "workbuddy" },
    kind: "note",
    content: "WorkBuddy write waited for the database lock.",
    source: "workbuddy",
  });

  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  const all = await memory.list();
  assert.equal(all.length, 1);
  assert.match(all[0]!.content, /waited for the database lock/);
});

test("sqlite task appends from separate instances keep a single sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafmem-task-concurrent-"));
  const path = join(root, "memory.sqlite");
  const first = createLeafMem({ storage: { backend: "sqlite", path } });
  const second = createLeafMem({ storage: { backend: "sqlite", path } });
  const taskId = "shared-session";

  await first.task.create({
    taskId,
    scope: { type: "agent", id: "codex" },
    title: "Shared session",
  });

  const entries = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      (index % 2 === 0 ? first : second).task.appendEntry({
        taskId,
        role: "assistant",
        content: `entry ${index}`,
      }),
    ),
  );

  assert.equal(entries.filter(Boolean).length, 12);
  const reader = createLeafMem({ storage: { backend: "sqlite", path } });
  const stored = await reader.task.listEntries(taskId);
  assert.deepEqual(
    stored.map((entry) => entry.sequence),
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
});

test("update modifies an existing record", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });

  const record = await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "Alice prefers English.",
  });

  const updated = await memory.update(record.id, { content: "Alice prefers Chinese." });
  assert.ok(updated);
  assert.match(updated!.content, /Chinese/);

  const fetched = await memory.get(record.id);
  assert.match(fetched!.content, /Chinese/);
});

test("forget deletes a record", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });

  const record = await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "fact",
    content: "Temporary fact.",
  });

  const deleted = await memory.forget(record.id);
  assert.equal(deleted, true);

  const fetched = await memory.get(record.id);
  assert.equal(fetched, null);

  const deletedAgain = await memory.forget(record.id);
  assert.equal(deletedAgain, false);
});

test("search returns hash-based reasons (not semantic)", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });

  await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "fact",
    content: "Alice's favorite color is blue.",
  });

  const hits = await memory.search("blue color", {
    scopes: [{ type: "user", id: "alice", weight: 1 }],
  });
  assert.ok(hits.length > 0);
  assert.ok("hash" in hits[0]!.reasons);
  assert.equal("semantic" in hits[0]!.reasons, false);
});

test("search filters unrelated memories by default", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });

  await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "fact",
    content: "Alice likes strawberries.",
  });

  const hits = await memory.search("server deployment rollback plan", {
    scopes: [{ type: "user", id: "alice", weight: 1 }],
  });

  assert.equal(hits.length, 0);
});

test("remember and forget keep the vector index in sync", async () => {
  const vectorStore = new InMemoryVectorStore();
  const memory = createLeafMem({
    store: new InMemoryStore(),
    retrieval: { vectorStore },
  });

  const record = await memory.remember({
    scope: { type: "repo", id: "leafmem" },
    kind: "fact",
    content: "This repo uses ESM modules.",
  });

  assert.equal(await vectorStore.count(), 1);

  await memory.forget(record.id);
  assert.equal(await vectorStore.count(), 0);
});

test("entity links can surface alias-based searches", async () => {
  const entityStore = new InMemoryEntityStore();
  const memory = createLeafMem({
    store: new InMemoryStore(),
    entityStore,
    entityExtractor: {
      async extract(text: string) {
        if (text.toLowerCase().includes("typescript")) {
          return [{ name: "TypeScript", kind: "tech", aliases: ["TS"] }];
        }
        return [];
      },
    },
  });

  await memory.remember({
    scope: { type: "repo", id: "leafmem" },
    kind: "fact",
    content: "This project uses TypeScript for the backend.",
  });

  const hits = await memory.search("TS", {
    scopes: [{ type: "repo", id: "leafmem", weight: 1 }],
  });

  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.record.content, "This project uses TypeScript for the backend.");
  // P0-3: entity boost is now IDF-weighted (graded multiplier, not a fixed 1).
  // A record linked via a single rare entity gets 1/(1+1/40) ≈ 0.976.
  assert.ok(hits[0]!.reasons.entity! > 0.9, `entity boost should be strong, got ${hits[0]!.reasons.entity}`);
});

test("recall includes related entity graph context", async () => {
  const entityStore = new InMemoryEntityStore();
  const memory = createLeafMem({
    store: new InMemoryStore(),
    entityStore,
    entityExtractor: {
      async extract(text: string) {
        const entities = [];
        if (text.toLowerCase().includes("react")) {
          entities.push({ name: "React", kind: "tech" as const });
        }
        if (text.toLowerCase().includes("next.js")) {
          entities.push({ name: "Next.js", kind: "tech" as const });
        }
        return entities;
      },
    },
  });

  await memory.remember({
    scope: { type: "repo", id: "leafmem" },
    kind: "fact",
    content: "This project uses React with Next.js.",
  });

  const recall = await memory.recall({
    query: "React",
    scopes: [{ type: "repo", id: "leafmem" }],
  });

  assert.ok(recall.injectedContext.includes("Related entity graph"));
  assert.ok(recall.injectedContext.includes("co_occurs"));
});

test("forget prunes dangling principle.supports references (2026-08-10)", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });
  const scope = { type: "agent" as const, id: "workbuddy" };
  // 两条内容必须足够不同，否则 remember() 去重会把第二条合并进第一条（同 id），
  // supports 就退化成单元素，测不出"只剔除被删的那条"的语义。
  const source1 = await memory.remember({ scope, content: "PostgreSQL 连接池在高并发下偶发超时，根因是默认 max_connections 过小，需要调大到 200。", kind: "lesson" });
  const source2 = await memory.remember({ scope, content: "飞书机器人 webhook 在周五 18 点推送失败，是租户限流策略触发，错峰到 17:30 即恢复。", kind: "lesson" });
  assert.notEqual(source1.id, source2.id);
  const principle = await memory.remember({
    scope,
    content: "蒸馏原则：数据库容量与消息推送时段都需要压测验证后再上线。",
    kind: "principle",
    metadata: { supports: [source1.id, source2.id], otherField: "must-survive" },
  });
  await memory.forget(source1.id);
  const after = await memory.get(principle.id);
  assert.deepEqual((after?.metadata as Record<string, unknown>).supports, [source2.id]);
  assert.equal((after?.metadata as Record<string, unknown>).otherField, "must-survive");
});

test("mergeProfile merges at section level, preserving unmentioned sections (2026-08-10)", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });
  const scope = { type: "agent" as const, id: "workbuddy" };
  await memory.active.write({
    kind: "profile",
    scope,
    content: "## 工作偏好\n- 白天工作为主。\n\n## 技术环境\n- 旧机用 MacPorts。\n\n## 写作风格\n- 克制、具体。\n",
  });
  // Host supplies only ONE updated section; others must survive.
  const res = await memory.mergeProfile({ scope, content: "## 技术环境\n- M5 Max，brew 非标路径。\n" });
  assert.equal(res.merged, 1);
  assert.equal(res.sectionsAfter, 3);
  const doc = await memory.active.read("profile", scope);
  assert.ok(doc!.content.includes("M5 Max"), "updated section applied");
  assert.ok(doc!.content.includes("白天工作为主"), "unmentioned section 1 preserved");
  assert.ok(doc!.content.includes("克制、具体"), "unmentioned section 2 preserved");
  assert.ok(!doc!.content.includes("MacPorts"), "stale content replaced");
});
