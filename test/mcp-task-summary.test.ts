import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { createLeafMem, InMemoryStore } from "../src/core/index.js";
import { InMemoryInspectEventStore } from "../src/inspect/store.js";
import { runMemoryMcpStdioServer } from "../src/mcp/index.js";

// 2026-08-11 regression: tasks created purely via task_append showed
// "Rolling Summary 暂无" in the console even though they had transcript
// entries. task_append now accepts an optional rollingSummary and persists it.
async function callTool(memory: ReturnType<typeof createLeafMem>, args: Record<string, unknown>): Promise<any> {
  const stdin = new PassThrough();
  let stdoutData = "";
  const stdout = new Writable({
    write(chunk, _e, cb) {
      stdoutData += chunk.toString();
      cb();
    },
  });
  const stderr = new Writable({ write(_c, _e, cb) { cb(); } });
  const server = runMemoryMcpStdioServer({ memory, stdin, stdout, stderr, events: new InMemoryInspectEventStore() });

  stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }) + "\n",
  );
  stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_write", arguments: args } }) + "\n",
  );
  stdin.end();
  await server;

  const messages = stdoutData
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const result = messages.find((m) => m.id === 2);
  assert.ok(result, "tool result present");
  return result;
}

test("task_append with rollingSummary persists the summary", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });
  await callTool(memory, {
    action: "task_append",
    taskId: "t1",
    role: "assistant",
    content: "fixed the scope bug; pending push",
    rollingSummary: "Stop-drive task: implemented + deployed; push pending.",
    scopeType: "agent",
    scopeId: "workbuddy",
  });
  const state = await memory.task.getRollingSummary("t1");
  assert.ok(state, "rolling summary state exists");
  assert.match(state!.rollingSummary, /Stop-drive task/);
  const entries = await memory.task.listEntries("t1");
  assert.equal(entries.length, 1);
});

test("task_append without rollingSummary leaves summary empty (back-compat)", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });
  await callTool(memory, {
    action: "task_append",
    taskId: "t2",
    role: "assistant",
    content: "entry only",
    scopeType: "agent",
    scopeId: "workbuddy",
  });
  const state = await memory.task.getRollingSummary("t2");
  assert.equal(state, null);
});

// 2026-08-11 regression (real incident): tasks created via task_append had no
// close path — the status enum existed but nothing transitioned a task out of
// "active", so the console showed permanently-active tasks. task_append now
// accepts an optional status.
test("task_append with status=completed closes the task", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });
  await callTool(memory, {
    action: "task_append",
    taskId: "t3",
    role: "assistant",
    content: "work finished, closing",
    rollingSummary: "done.",
    status: "completed",
    scopeType: "agent",
    scopeId: "workbuddy",
  });
  const task = await memory.task.get("t3");
  assert.equal(task?.status, "completed");
});

test("task_append can transition an existing active task to completed", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });
  await callTool(memory, {
    action: "task_append",
    taskId: "t4",
    role: "assistant",
    content: "started",
    scopeType: "agent",
    scopeId: "workbuddy",
  });
  let task = await memory.task.get("t4");
  assert.equal(task?.status, "active");
  await callTool(memory, {
    action: "task_append",
    taskId: "t4",
    role: "assistant",
    content: "finished, close it",
    status: "completed",
    scopeType: "agent",
    scopeId: "workbuddy",
  });
  task = await memory.task.get("t4");
  assert.equal(task?.status, "completed");
});

test("task_append without status keeps existing task active (back-compat)", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });
  await callTool(memory, {
    action: "task_append",
    taskId: "t5",
    role: "assistant",
    content: "progress",
    scopeType: "agent",
    scopeId: "workbuddy",
  });
  const task = await memory.task.get("t5");
  assert.equal(task?.status, "active");
});
