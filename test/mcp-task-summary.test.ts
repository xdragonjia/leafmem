import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { createLeafMem, InMemoryStore } from "../src/core/index.js";
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
  const server = runMemoryMcpStdioServer({ memory, stdin, stdout, stderr });

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
