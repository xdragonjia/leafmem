import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "hooks", "leafmem-hooks.mjs");

// v0.3.6: the gate signal is "did the agent write this session" (GET
// /v1/memories?scope=agent:<id>, non-capture sources), not "did the heuristic
// store something". The mock therefore serves both endpoints.
async function runStop(
  payload: Record<string, unknown>,
  opts: { stored?: number; agentMemories?: Array<{ source?: string; createdAt?: string }>; serveList?: boolean; home?: string } = {},
): Promise<{ out: any; home: string }> {
  const home = opts.home ?? (await mkdtemp(join(tmpdir(), "leafmem-hook-drive-")));
  await mkdir(join(home, ".leafmem"), { recursive: true });

  const storedCount = opts.stored ?? 0;
  const memories = opts.agentMemories ?? [];
  const serveList = opts.serveList !== false;

  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/v1/turns/capture") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stored: storedCount, proposals: storedCount, taskEntries: 0 }));
      });
      return;
    }
    if (req.method === "GET" && url.startsWith("/v1/memories?")) {
      if (!serveList) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ memories, count: memories.length }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  await writeFile(join(home, ".leafmem", "agent-service.json"), JSON.stringify({ host: "127.0.0.1", port, apiKey: "test-key" }), "utf8");

  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH, "Stop", "--agent", "workbuddy"], {
      env: { ...process.env, HOME: home, LEAFMEM_HOOK_RECALL_TIMEOUT_MS: "2000", LEAFMEM_HOOK_CAPTURE_TIMEOUT_MS: "2000" },
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.on("close", () => resolve(stdout));
    child.on("error", reject);
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
  server.close();
  return { out: JSON.parse(out || "{}"), home };
}

const now = new Date().toISOString();

test("no agent writes + substantive work -> block", async () => {
  const { out, home } = await runStop(
    { session_id: "s1", prompt: "修复了一个复杂的双 scope bug 并更新了文档", stop_hook_active: false },
    { stored: 0, agentMemories: [] },
  );
  assert.equal(out.decision, "block");
  assert.match(out.reason, /memory_write/);
  await rm(home, { recursive: true, force: true });
});

test("agent already wrote this session -> allow (even if heuristic stored nothing)", async () => {
  const { out, home } = await runStop(
    { session_id: "s2", prompt: "继续收尾，刚才已写过记忆", stop_hook_active: false },
    { stored: 0, agentMemories: [{ source: "skill", createdAt: now }] },
  );
  assert.equal(out.decision, undefined);
  await rm(home, { recursive: true, force: true });
});

test("THE INCIDENT: misfired capture only (turn_inference) -> still block", async () => {
  // Heuristic stored 1 garbage record; the agent never summarized. The old
  // gate saw stored>0 and let it through. The new gate must block.
  const { out, home } = await runStop(
    { session_id: "s3", prompt: "我是通过代理访问 github 的，你把那三行删掉", stop_hook_active: false },
    { stored: 1, agentMemories: [{ source: "turn_inference", createdAt: now }] },
  );
  assert.equal(out.decision, "block");
  await rm(home, { recursive: true, force: true });
});

test("stop_hook_active=true never blocks", async () => {
  const { out, home } = await runStop(
    { session_id: "s4", prompt: "实质性工作内容但不允许二次 block", stop_hook_active: true },
    { stored: 0, agentMemories: [] },
  );
  assert.equal(out.decision, undefined);
  await rm(home, { recursive: true, force: true });
});

test("trivial session under MIN_WORK_CHARS -> allow", async () => {
  const { out, home } = await runStop({ session_id: "s5", prompt: "好的", stop_hook_active: false }, { stored: 0, agentMemories: [] });
  assert.equal(out.decision, undefined);
  await rm(home, { recursive: true, force: true });
});

test("same session driven at most once", async () => {
  const first = await runStop(
    { session_id: "s6", prompt: "做了很多实质性的开发和调试工作", stop_hook_active: false },
    { stored: 0, agentMemories: [] },
  );
  assert.equal(first.out.decision, "block");
  const second = await runStop(
    { session_id: "s6", prompt: "继续收尾", stop_hook_active: false },
    { stored: 0, agentMemories: [], home: first.home },
  );
  assert.equal(second.out.decision, undefined, "second Stop must not block");
  await rm(first.home, { recursive: true, force: true });
});

test("list endpoint unavailable -> fail open (allow), never block on broken signal", async () => {
  const { out, home } = await runStop(
    { session_id: "s7", prompt: "实质性工作但服务查询接口坏了", stop_hook_active: false },
    { stored: 0, serveList: false },
  );
  assert.equal(out.decision, undefined);
  await rm(home, { recursive: true, force: true });
});

test("agent write from a PREVIOUS session (no sessionStartAt in state) counts as wrote -> allow", async () => {
  // No UPS ever ran in this home: sessionStartAt missing, so any agent write
  // counts (conservative against over-blocking when the ledger is incomplete).
  const { out, home } = await runStop(
    { session_id: "s8", prompt: "另一段实质工作", stop_hook_active: false },
    { stored: 0, agentMemories: [{ source: "workbuddy_session_commit", createdAt: "2026-01-01T00:00:00Z" }] },
  );
  assert.equal(out.decision, undefined);
  await rm(home, { recursive: true, force: true });
});
