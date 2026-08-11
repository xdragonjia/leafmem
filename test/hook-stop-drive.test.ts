import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "hooks", "leafmem-hooks.mjs");

// Runs leafmem-hooks.mjs Stop against a mock LeafMem HTTP service, with HOME
// isolated to a temp dir so the real ~/.leafmem is untouched. Returns the parsed
// stdout JSON and the mock's capture request bodies.
async function runStop(payload: Record<string, unknown>, storedCount: number): Promise<{ out: any; home: string; port: number }> {
  const home = await mkdtemp(join(tmpdir(), "leafmem-hook-drive-"));
  await mkdir(join(home, ".leafmem"), { recursive: true });

  const captureBodies: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/turns/capture") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        captureBodies.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stored: storedCount, proposals: storedCount, taskEntries: 0 }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;

  await writeFile(
    join(home, ".leafmem", "agent-service.json"),
    JSON.stringify({ host: "127.0.0.1", port, apiKey: "test-key" }),
    "utf8",
  );

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
  return { out: JSON.parse(out || "{}"), home, port };
}

test("Stop drive: substantive zero-write session is blocked with instruction", async () => {
  const { out, home } = await runStop(
    { session_id: "sess-a", prompt: "修复了一个复杂的双 scope bug 并更新了文档", stop_hook_active: false },
    0,
  );
  assert.equal(out.decision, "block");
  assert.match(out.reason, /memory_write/);
  assert.match(out.reason, /task_append/);
  await rm(home, { recursive: true, force: true });
});

test("Stop drive: same session is driven at most once", async () => {
  // First Stop drives.
  const first = await runStop(
    { session_id: "sess-b", prompt: "做了很多实质性的开发和调试工作", stop_hook_active: false },
    0,
  );
  assert.equal(first.out.decision, "block");

  // Reuse the SAME home (and thus the same capture-state.json) for the 2nd Stop.
  const home = first.home;
  await mkdir(join(home, ".leafmem"), { recursive: true });
  // runStop creates a fresh server each call; re-run with the same session id but
  // a new server — the state file already records drivenAt, so it must NOT block.
  const second = await runStopWithHome(home, { session_id: "sess-b", prompt: "继续收尾工作", stop_hook_active: false }, 0);
  assert.equal(second.out.decision, undefined, "second Stop in same session must not block");
  await rm(home, { recursive: true, force: true });
});

test("Stop drive: stop_hook_active=true never blocks (host loop guard)", async () => {
  const { out, home } = await runStop(
    { session_id: "sess-c", prompt: "另一段实质性的工作内容", stop_hook_active: true },
    0,
  );
  assert.equal(out.decision, undefined);
  await rm(home, { recursive: true, force: true });
});

test("Stop drive: heuristic-captured turn (stored>0) is not driven", async () => {
  const { out, home } = await runStop(
    { session_id: "sess-d", prompt: "记住：以后所有报告都用中文", stop_hook_active: false },
    1,
  );
  assert.equal(out.decision, undefined);
  assert.equal(out.continue, true);
  await rm(home, { recursive: true, force: true });
});

test("Stop drive: trivial session under MIN_WORK_CHARS is not driven", async () => {
  const { out, home } = await runStop({ session_id: "sess-e", prompt: "好的", stop_hook_active: false }, 0);
  assert.equal(out.decision, undefined);
  await rm(home, { recursive: true, force: true });
});

// Variant that reuses an existing HOME so the drive state file persists.
async function runStopWithHome(home: string, payload: Record<string, unknown>, storedCount: number): Promise<{ out: any; home: string }> {
  const captureBodies: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/turns/capture") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        captureBodies.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stored: storedCount, proposals: storedCount, taskEntries: 0 }));
      });
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
