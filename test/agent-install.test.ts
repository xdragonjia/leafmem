import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("agent installer writes WorkBuddy MCP config with a default scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafmem-agent-workbuddy-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "leafmem-mcp.js");

  try {
    await mkdir(join(root, ".workbuddy", "memory"), { recursive: true });
    await writeFile(join(root, ".workbuddy", "SOUL.md"), "- WorkBuddy speaks calmly.\n", "utf8");
    await writeFile(join(root, ".workbuddy", "USER.md"), "- Prefers direct answers.\n", "utf8");
    await writeFile(join(root, ".workbuddy", "MEMORY.md"), "- Existing WorkBuddy memory.\n", "utf8");
    await writeFile(
      join(root, ".workbuddy", "memory", "user-1_memory.md"),
      `# User Memory Profile

<!-- RAW_JSON_START
{
  "uid": "user-1",
  "memoryBlock": "Existing native WorkBuddy session memory.",
  "version": 2,
  "updatedAt": "2026-06-19T00:00:00+08:00"
}
RAW_JSON_END -->
`,
      "utf8",
    );

    const output = await runInstaller("workbuddy", root, storagePath, mcpPath);
    const parsed = JSON.parse(output);
    assert.equal(parsed.results[0].agent, "workbuddy");
    assert.equal(parsed.results[0].mcp, "installed");
    assert.equal(parsed.results[0].import, "imported");
    assert.equal(parsed.results[0].instructions, "updated");
    assert.equal(parsed.results[0].importSummary.imported, 4);
    assert.equal(parsed.results[0].importSummary.nativeMemoryEntries, 1);

    const config = JSON.parse(await readFile(join(root, ".workbuddy", "mcp.json"), "utf8"));
    assert.equal(config.mcpServers.leafmem.command, "node");
    assert.deepEqual(config.mcpServers.leafmem.args, [mcpPath]);
    assert.equal(config.mcpServers.leafmem.env.LEAFMEM_STORAGE_PATH, storagePath);
    assert.equal(config.mcpServers.leafmem.env.LEAFMEM_SCOPE_TYPE, "agent");
    assert.equal(config.mcpServers.leafmem.env.LEAFMEM_SCOPE_ID, "workbuddy");
    assert.equal(config.mcpServers.leafmem.env.LEAFMEM_WORKBUDDY_HOME, join(root, ".workbuddy"));

    const memoryProjection = await readFile(join(root, ".workbuddy", "MEMORY.md"), "utf8");
    assert.match(memoryProjection, /Existing WorkBuddy memory/);
    assert.equal(memoryProjection.match(/leafmem-agent-instructions:start/g)?.length, 1);
    assert.match(memoryProjection, /memory_recall/);
    assert.match(memoryProjection, /Internal recall requirement/);
    assert.match(memoryProjection, /Do this silently/);
    assert.doesNotMatch(memoryProjection, /Trigger words include/);
    assert.match(memoryProjection, /memory_write/);
    assert.match(memoryProjection, /agent:workbuddy/);
    assert.match(memoryProjection, /update workbuddy/);
    // syncProjection is disabled on the install path: SOUL.md/USER.md/MEMORY.md are
    // user-authoritative files. Import reads them into the DB, but never projects DB
    // contents back onto them. The native memory profile must NOT be written back.
    assert.doesNotMatch(memoryProjection, /WorkBuddy native memory profile/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent installer import step tolerates missing session roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafmem-agent-import-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "leafmem-mcp.js");

  try {
    const output = await runInstaller("workbuddy", root, storagePath, mcpPath, "--skip-mcp", "--skip-instructions");
    const parsed = JSON.parse(output);
    assert.equal(parsed.results[0].agent, "workbuddy");
    assert.equal(parsed.results[0].import, "imported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent TUI once mode prints setup status", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafmem-agent-tui-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "leafmem-mcp.js");

  try {
    const output = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/leafmem-agent.ts"),
      "tui",
      "--once",
      "--home",
      root,
      "--storage-path",
      storagePath,
      "--mcp-path",
      mcpPath,
    ]);

    assert.match(output, /LeafMem Agent TUI/);
    assert.match(output, /Storage:/);
    assert.match(output, /WorkBuddy/);
    assert.match(output, /昆仑小智/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent service install writes stable config and LaunchAgent plist without starting", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafmem-agent-service-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "leafmem-mcp.js");

  try {
    const output = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/leafmem-agent.ts"),
      "service",
      "install",
      "--home",
      root,
      "--storage-path",
      storagePath,
      "--mcp-path",
      mcpPath,
      "--port",
      "3391",
      "--no-start",
    ]);
    const parsed = JSON.parse(output);
    assert.match(parsed.url, /^http:\/\/127\.0\.0\.1:3391\/console\?apiKey=mm_/);
    assert.equal(parsed.started, false);

    const config = JSON.parse(await readFile(join(root, ".leafmem", "agent-service.json"), "utf8"));
    assert.equal(config.storagePath, storagePath);
    assert.equal(config.mcpPath, mcpPath);
    assert.equal(config.port, 3391);
    assert.match(config.apiKey, /^mm_/);

    // Autostart artifact is platform-specific: macOS plist, Linux systemd
    // user unit, Windows Task Scheduler entry (no on-disk file).
    if (process.platform === "darwin") {
      const plist = await readFile(join(root, "Library", "LaunchAgents", "com.leafmem.agent.plist"), "utf8");
      assert.match(plist, /<string>serve<\/string>/);
      assert.match(plist, /<key>RunAtLoad<\/key>/);
      assert.match(plist, new RegExp(escapeRegExp(join(root, ".leafmem", "agent-service.json"))));
    } else if (process.platform === "linux") {
      const unit = await readFile(join(root, ".config", "systemd", "user", "leafmem-agent.service"), "utf8");
      assert.match(unit, /ExecStart=/);
      assert.match(unit, /Restart=always/);
      assert.match(unit, new RegExp(escapeRegExp(join(root, ".leafmem", "agent-service.json"))));
    }
    // Windows: schtasks registers a Task Scheduler entry (no file); verified
    // only on real Windows via isServiceInstalled, not asserted here.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install all can create the local service without invoking launchctl", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafmem-agent-install-all-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "leafmem-mcp.js");

  try {
    const output = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/leafmem-agent.ts"),
      "install",
      "all",
      "--home",
      root,
      "--storage-path",
      storagePath,
      "--mcp-path",
      mcpPath,
      "--skip-mcp",
      "--skip-import",
      "--skip-instructions",
      "--no-service-start",
      "--service-port",
      "3392",
    ]);
    const parsed = JSON.parse(output);
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.service.started, false);
    assert.match(parsed.service.url, /^http:\/\/127\.0\.0\.1:3392\/console\?apiKey=mm_/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runInstaller(
  agent: string,
  home: string,
  storagePath: string,
  mcpPath: string,
  ...extra: string[]
): Promise<string> {
  return await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    join(process.cwd(), "src/bin/leafmem-agent.ts"),
    "install",
    agent,
    "--home",
    home,
    "--storage-path",
    storagePath,
    "--mcp-path",
    mcpPath,
    ...extra,
  ]);
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
