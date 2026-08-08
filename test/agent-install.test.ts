import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("agent installer writes global Codex MCP config and instruction block", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafmem-agent-codex-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "leafmem-mcp.js");

  try {
    await runInstaller("codex", root, storagePath, mcpPath, "--skip-import");
    await runInstaller("codex", root, storagePath, mcpPath, "--skip-import");

    const config = await readFile(join(root, ".codex", "config.toml"), "utf8");
    assert.equal(config.match(/\[mcp_servers\.leafmem\]/g)?.length, 1);
    assert.match(config, new RegExp(escapeRegExp(`args = ["${mcpPath}"]`)));
    assert.match(config, /LEAFMEM_STORAGE_PATH/);
    assert.doesNotMatch(config, /LEAFMEM_SCOPE_ID/);

    const instructions = await readFile(join(root, ".codex", "AGENTS.md"), "utf8");
    assert.equal(instructions.match(/leafmem-agent-instructions:start/g)?.length, 1);
    assert.match(instructions, /omit scope first/);
    assert.match(instructions, /agent:codex/);
    assert.match(instructions, /memory_session/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent installer writes Cursor, Copilot, Antigravity, and Trae MCP configs and instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafmem-agent-json-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "leafmem-mcp.js");

  try {
    await runInstaller("cursor", root, storagePath, mcpPath, "--skip-import");
    await runInstaller("copilot", root, storagePath, mcpPath, "--skip-import");
    await runInstaller("antigravity", root, storagePath, mcpPath, "--skip-import");
    await runInstaller("trae", root, storagePath, mcpPath, "--skip-import");

    const cursor = JSON.parse(await readFile(join(root, ".cursor", "mcp.json"), "utf8"));
    assert.equal(cursor.mcpServers.leafmem.command, "node");
    assert.deepEqual(cursor.mcpServers.leafmem.args, [mcpPath]);
    assert.equal(cursor.mcpServers.leafmem.env.LEAFMEM_STORAGE_PATH, storagePath);

    const copilot = JSON.parse(await readFile(join(root, ".copilot", "mcp-config.json"), "utf8"));
    assert.equal(copilot.mcpServers.leafmem.type, "local");
    assert.deepEqual(copilot.mcpServers.leafmem.tools, ["*"]);

    const antigravity = JSON.parse(await readFile(join(root, ".gemini", "antigravity", "mcp_config.json"), "utf8"));
    assert.equal(antigravity.mcpServers.leafmem.command, "node");
    assert.deepEqual(antigravity.mcpServers.leafmem.args, [mcpPath]);
    assert.equal(antigravity.mcpServers.leafmem.env.LEAFMEM_STORAGE_PATH, storagePath);

    const trae = JSON.parse(await readFile(join(root, "Library", "Application Support", "TRAE SOLO CN", "User", "mcp.json"), "utf8"));
    assert.equal(trae.mcpServers.leafmem.command, "node");
    assert.deepEqual(trae.mcpServers.leafmem.args, [mcpPath]);
    assert.equal(trae.mcpServers.leafmem.env.LEAFMEM_STORAGE_PATH, storagePath);
    assert.equal(trae.mcpServers.leafmem.disabled, false);

    const instructions = await readFile(join(root, ".copilot", "copilot-instructions.md"), "utf8");
    assert.match(instructions, /agent:copilot/);

    const cursorRule = await readFile(join(root, ".cursor", "rules", "leafmem.mdc"), "utf8");
    assert.match(cursorRule, /alwaysApply: true/);
    assert.match(cursorRule, /agent:cursor/);
    assert.match(cursorRule, /memory_session/);

    const antigravityRules = await readFile(join(root, ".gemini", "GEMINI.md"), "utf8");
    assert.match(antigravityRules, /agent:antigravity/);
    assert.match(antigravityRules, /memory_session/);
    const antigravityMcpInstructions = await readFile(
      join(root, ".gemini", "antigravity", "mcp", "leafmem", "instructions.md"),
      "utf8",
    );
    assert.match(antigravityMcpInstructions, /memory_context/);
    assert.match(antigravityMcpInstructions, /memory_session/);

    const traeSkill = await readFile(join(root, ".trae", "skills", "leafmem-memory", "SKILL.md"), "utf8");
    assert.match(traeSkill, /name: leafmem-memory/);
    assert.match(traeSkill, /agent:trae/);
    assert.match(traeSkill, /memory_session/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    assert.match(memoryProjection, /memory_context/);
    assert.match(memoryProjection, /Internal recall requirement/);
    assert.match(memoryProjection, /Do this silently/);
    assert.doesNotMatch(memoryProjection, /Trigger words include/);
    assert.match(memoryProjection, /memory_session/);
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
    const output = await runInstaller("codex", root, storagePath, mcpPath, "--skip-mcp", "--skip-instructions");
    const parsed = JSON.parse(output);
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
    assert.match(output, /Codex/);
    assert.match(output, /Antigravity/);
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

    const plist = await readFile(join(root, "Library", "LaunchAgents", "com.leafmem.agent.plist"), "utf8");
    assert.match(plist, /<string>serve<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>/);
    assert.match(plist, new RegExp(escapeRegExp(join(root, ".leafmem", "agent-service.json"))));
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
    assert.equal(parsed.results.length, 8);
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
