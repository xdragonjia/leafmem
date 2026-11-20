// 2026-11-20 metadata 合并默认语义回归。
// 事故背景：宿主两次 `update --metadata` 裸写整包替换，冲掉 supports /
// eventTime / recallCount（35 条 principle 证据链清零，靠备份恢复）。
// 修法：安全默认下沉到 memory.update() 汇聚点——默认浅合并；键值 null=删除；
// 显式 metadataMode:"replace" 才整包替换。本文件是该判据的负例/正例锚。
import test from "node:test";
import assert from "node:assert/strict";
import { createLeafMem, InMemoryStore } from "../src/core/index.js";
import { createMemoryMcpHandler } from "../src/mcp/index.js";

function makeMemory() {
  return createLeafMem({ store: new InMemoryStore(), inferencer: async () => ({ ok: false, text: "" }) });
}

const scope = { type: "agent" as const, id: "workbuddy" };

async function seed(memory: ReturnType<typeof makeMemory>) {
  return memory.remember({
    scope,
    kind: "principle",
    content: "判据形态族：判据假定的数据形态必须与真实形态一致，否则假阳性。",
    source: "manual",
    tags: ["principle"],
    metadata: {
      supports: ["ev-1", "ev-2"],
      eventTime: "2026-11-19",
      recallCount: 7,
    },
  });
}

test("update() merges metadata by default — bare patch no longer wipes supports/eventTime", async () => {
  const memory = makeMemory();
  const record = await seed(memory);
  const after = await memory.update(record.id, {
    metadata: { pattern: "判据形态", trigger_context: "写门禁判据时" },
  });
  const meta = after?.metadata as Record<string, unknown>;
  assert.deepEqual(meta.supports, ["ev-1", "ev-2"]); // 既有键保留
  assert.equal(meta.eventTime, "2026-11-19");
  assert.equal(meta.recallCount, 7);
  assert.equal(meta.pattern, "判据形态"); // 新键写入
  assert.equal(meta.trigger_context, "写门禁判据时");
});

test("update() merge overwrites same key but keeps siblings", async () => {
  const memory = makeMemory();
  const record = await seed(memory);
  const after = await memory.update(record.id, { metadata: { eventTime: "2026-11-20" } });
  const meta = after?.metadata as Record<string, unknown>;
  assert.equal(meta.eventTime, "2026-11-20");
  assert.deepEqual(meta.supports, ["ev-1", "ev-2"]);
  assert.equal(meta.recallCount, 7);
});

test("null value deletes exactly that key, siblings survive", async () => {
  const memory = makeMemory();
  const record = await seed(memory);
  const after = await memory.update(record.id, { metadata: { recallCount: null } });
  const meta = after?.metadata as Record<string, unknown>;
  assert.equal(meta.recallCount, undefined);
  assert.deepEqual(meta.supports, ["ev-1", "ev-2"]);
  assert.equal(meta.eventTime, "2026-11-19");
});

test("explicit metadataMode:replace performs full replacement (opt-in escape hatch)", async () => {
  const memory = makeMemory();
  const record = await seed(memory);
  const after = await memory.update(record.id, {
    metadata: { fresh: true },
    metadataMode: "replace",
  });
  assert.deepEqual(after?.metadata, { fresh: true });
});

test("replace with empty object clears all keys (legacy replace semantics kept verbatim)", async () => {
  const memory = makeMemory();
  const record = await seed(memory);
  const after = await memory.update(record.id, { metadata: {}, metadataMode: "replace" });
  assert.deepEqual(after?.metadata, {}); // 旧键全清；replace 路径与改造前逐字一致
});

test("merge with empty object is a no-op on existing keys", async () => {
  const memory = makeMemory();
  const record = await seed(memory);
  const after = await memory.update(record.id, { metadata: {} });
  const meta = after?.metadata as Record<string, unknown>;
  assert.deepEqual(meta.supports, ["ev-1", "ev-2"]);
  assert.equal(meta.eventTime, "2026-11-19");
});

test("record without metadata gains keys via merge update", async () => {
  const memory = makeMemory();
  const record = await memory.remember({ scope, kind: "lesson", content: "无元数据条目", source: "manual" });
  const after = await memory.update(record.id, { metadata: { pattern: "测试模式" } });
  assert.deepEqual(after?.metadata, { pattern: "测试模式" });
});

test("MCP memory_govern update: bare metadata patch preserves existing keys end-to-end", async () => {
  const memory = makeMemory();
  const handler = createMemoryMcpHandler({ memory });
  const record = await seed(memory);
  const res = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_govern",
      arguments: {
        action: "update",
        id: record.id,
        scopeType: "agent",
        scopeId: "workbuddy",
        metadata: { pattern: "判据形态" },
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const payload = JSON.parse(res.result?.content?.[0]?.text ?? "{}") as {
    record?: { metadata?: Record<string, unknown> };
  };
  const meta = payload.record?.metadata ?? {};
  assert.deepEqual(meta.supports, ["ev-1", "ev-2"]);
  assert.equal(meta.eventTime, "2026-11-19");
  assert.equal(meta.pattern, "判据形态");
});

test("MCP memory_govern update: metadataMode:replace still reaches full replacement", async () => {
  const memory = makeMemory();
  const handler = createMemoryMcpHandler({ memory });
  const record = await seed(memory);
  const res = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_govern",
      arguments: {
        action: "update",
        id: record.id,
        scopeType: "agent",
        scopeId: "workbuddy",
        metadata: { only: 1 },
        metadataMode: "replace",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const payload = JSON.parse(res.result?.content?.[0]?.text ?? "{}") as {
    record?: { metadata?: Record<string, unknown> };
  };
  assert.deepEqual(payload.record?.metadata, { only: 1 });
});

test("MCP memory_govern update: null key value deletes key through the tool surface", async () => {
  const memory = makeMemory();
  const handler = createMemoryMcpHandler({ memory });
  const record = await seed(memory);
  const res = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_govern",
      arguments: {
        action: "update",
        id: record.id,
        scopeType: "agent",
        scopeId: "workbuddy",
        metadata: { eventTime: null },
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const payload = JSON.parse(res.result?.content?.[0]?.text ?? "{}") as {
    record?: { metadata?: Record<string, unknown> };
  };
  const meta = payload.record?.metadata ?? {};
  assert.equal(meta.eventTime, undefined);
  assert.deepEqual(meta.supports, ["ev-1", "ev-2"]);
});
