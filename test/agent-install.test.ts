import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLeafMem } from "../src/core/memory.js";

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
    assert.equal(parsed.results[0].instructions, "updated");
    assert.equal(parsed.results[0].hooks, "installed");
    // 2026-08-11 import redesign: install no longer mechanically shards the
    // six files — it records a pending distillation state for the host agent
    // to distill with its own LLM (see INSTALL-*.md step 7.5).
    assert.equal(parsed.results[0].importSummary.imported, 0);
    assert.equal(parsed.results[0].importSummary.pendingDistillation, true);
    const state = JSON.parse(await readFile(join(root, "import-state.json"), "utf8"));
    assert.equal(state.workbuddy.pending, true);
    assert.ok(state.workbuddy.fingerprint, "fingerprint recorded");

    // 2026-08-11 hook architecture: lifecycle hooks registered in the host
    // settings.json, bridge script copied to ~/.leafmem/hooks/.
    const settings = JSON.parse(await readFile(join(root, ".workbuddy", "settings.json"), "utf8"));
    assert.ok(settings.hooks, "settings.json should contain a hooks block");
    assert.ok(settings.hooks.UserPromptSubmit, "UserPromptSubmit hook registered");
    assert.ok(settings.hooks.Stop, "Stop hook registered");
    const hookJson = JSON.stringify(settings.hooks);
    assert.match(hookJson, /leafmem-hooks\.mjs/);
    assert.match(hookJson, /--agent workbuddy/);

    const config = JSON.parse(await readFile(join(root, ".workbuddy", "mcp.json"), "utf8"));
    assert.equal(config.mcpServers.leafmem.command, "node");
    assert.deepEqual(config.mcpServers.leafmem.args, [mcpPath]);
    assert.equal(config.mcpServers.leafmem.env.LEAFMEM_STORAGE_PATH, storagePath);
    assert.equal(config.mcpServers.leafmem.env.LEAFMEM_SCOPE_TYPE, "agent");
    assert.equal(config.mcpServers.leafmem.env.LEAFMEM_SCOPE_ID, "workbuddy");
    assert.equal(config.mcpServers.leafmem.env.LEAFMEM_WORKBUDDY_HOME, join(root, ".workbuddy"));

    // 2026-08-11: the discipline block is pinned to the TOP of SOUL.md (the
    // host's primary behavioral file), not MEMORY.md. MEMORY.md stays a pure
    // memory store.
    const soulProjection = await readFile(join(root, ".workbuddy", "SOUL.md"), "utf8");
    assert.match(soulProjection, /leafmem-agent-instructions:start/);
    assert.equal(soulProjection.match(/leafmem-agent-instructions:start/g)?.length, 1);
    assert.match(soulProjection, /memory_recall/);
    assert.match(soulProjection, /Lifecycle hooks are the primary path/);
    assert.match(soulProjection, /Do this silently/);
    assert.doesNotMatch(soulProjection, /Trigger words include/);
    assert.match(soulProjection, /memory_write/);
    assert.match(soulProjection, /agent:workbuddy/);
    assert.match(soulProjection, /update workbuddy/);

    const memoryProjection = await readFile(join(root, ".workbuddy", "MEMORY.md"), "utf8");
    assert.match(memoryProjection, /Existing WorkBuddy memory/);
    // The instruction block must NOT be in MEMORY.md anymore.
    assert.doesNotMatch(memoryProjection, /leafmem-agent-instructions:start/);
    // syncProjection is disabled on the install path: SOUL.md/USER.md/MEMORY.md are
    // user-authoritative files. Import reads them into the DB, but never projects DB
    // contents back onto them. The native memory profile must NOT be written back.
    assert.doesNotMatch(memoryProjection, /WorkBuddy native memory profile/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared-topology second host resolves the primary scope (no mechanical import)", async () => {
  // Regression (2026-08-11, real incident): a shared kunlunxiaozhi install ran
  // its six-file import against the host's OWN scope while the MCP connector
  // wrote to the shared primary scope — producing 167 dead duplicate records
  // in agent:kunlunxiaozhi. Since the 08-11 import redesign the install path
  // does not write records at all (host-LLM distillation instead), so the
  // invariant becomes: under shared topology BOTH hosts' MCP env and import
  // state point at the primary scope, and no records land in the DB.
  const root = await mkdtemp(join(tmpdir(), "leafmem-agent-shared-import-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "leafmem-mcp.js");

  try {
    // First host (workbuddy) establishes the shared primary pool.
    await mkdir(join(root, ".workbuddy"), { recursive: true });
    await writeFile(join(root, ".workbuddy", "SOUL.md"), "- Shared soul rule.\n", "utf8");
    await runInstaller("workbuddy", root, storagePath, mcpPath, "--skip-hooks", "--memory", "shared");

    // Second host (kunlunxiaozhi) joins the SAME shared topology.
    await mkdir(join(root, ".kunlunxiaozhi"), { recursive: true });
    await writeFile(join(root, ".kunlunxiaozhi", "SOUL.md"), "- Shared soul rule.\n- Kunlun-only rule.\n", "utf8");
    await runInstaller("kunlunxiaozhi", root, storagePath, mcpPath, "--skip-hooks", "--memory", "shared");

    // MCP env for both hosts must resolve to the primary scope.
    for (const host of ["workbuddy", "kunlunxiaozhi"]) {
      const config = JSON.parse(await readFile(join(root, `.${host}`, "mcp.json"), "utf8"));
      assert.equal(config.mcpServers.leafmem.env.LEAFMEM_SCOPE_ID, "workbuddy", `${host} env scope`);
    }
    // Import state marks both hosts pending (host LLM distills, not installer).
    const state = JSON.parse(await readFile(join(root, "import-state.json"), "utf8"));
    assert.equal(state.workbuddy.pending, true);
    assert.equal(state.kunlunxiaozhi.pending, true);

    // No mechanical records in any scope.
    const memory = createLeafMem({ storagePath });
    const ownScope = await memory.list({ scopes: [{ type: "agent", id: "kunlunxiaozhi" }] });
    assert.equal(ownScope.length, 0, "no records may land in the second host's own scope under shared topology");
    const primary = await memory.list({ scopes: [{ type: "agent", id: "workbuddy" }] });
    assert.equal(primary.length, 0, "installer no longer mechanically imports");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent installer accepts the --memory flag (release install path)", async () => {
  // Regression (2026-08-11, found via simulated-install walkthrough):
  // parseSharedAgentOptions rejected `--memory isolated` with
  // "Unknown argument: --memory" even though parseInstallArgs documents it,
  // so the documented `install workbuddy --memory isolated` command crashed.
  const root = await mkdtemp(join(tmpdir(), "leafmem-agent-memory-flag-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "leafmem-mcp.js");

  try {
    const output = await runInstaller("workbuddy", root, storagePath, mcpPath, "--memory", "isolated");
    const parsed = JSON.parse(output);
    assert.equal(parsed.results[0].agent, "workbuddy");
    assert.equal(parsed.results[0].mcp, "installed");
    const config = JSON.parse(await readFile(join(root, ".workbuddy", "mcp.json"), "utf8"));
    assert.equal(config.mcpServers.leafmem.env.LEAFMEM_SCOPE_ID, "workbuddy");
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
