import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMemoryTopology, setMemoryTopology } from "../src/agents/manager.js";

async function writeHostMcp(home: string, hostDir: string, scopeId: string): Promise<void> {
  const dir = join(home, hostDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        leafmem: { command: "node", args: [], env: { LEAFMEM_SCOPE_TYPE: "agent", LEAFMEM_SCOPE_ID: scopeId } },
      },
    }),
  );
}

test("topology: kunlunxiaozhi-only install has primary scope kunlunxiaozhi (2026-08-10)", async () => {
  const home = await mkdtemp(join(tmpdir(), "leafmem-topo-klxz-"));
  try {
    await writeHostMcp(home, ".kunlunxiaozhi", "kunlunxiaozhi");
    const topo = await getMemoryTopology({ home });
    assert.equal(topo.configuredCount, 1);
    assert.equal(topo.primaryScopeId, "kunlunxiaozhi");
    assert.equal(topo.shared, true, "single-host is trivially shared");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("topology: workbuddy-first dual-host shared uses workbuddy as primary", async () => {
  const home = await mkdtemp(join(tmpdir(), "leafmem-topo-dual-"));
  try {
    await writeHostMcp(home, ".workbuddy", "workbuddy");
    await writeHostMcp(home, ".kunlunxiaozhi", "workbuddy");
    const topo = await getMemoryTopology({ home });
    assert.equal(topo.configuredCount, 2);
    assert.equal(topo.primaryScopeId, "workbuddy");
    assert.equal(topo.shared, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("topology: split dual-host is not shared; setMemoryTopology(shared) lands on primary", async () => {
  const home = await mkdtemp(join(tmpdir(), "leafmem-topo-split-"));
  try {
    await writeHostMcp(home, ".kunlunxiaozhi", "kunlunxiaozhi");
    await writeHostMcp(home, ".workbuddy", "workbuddy");
    const split = await getMemoryTopology({ home });
    assert.equal(split.shared, false);
    // AGENT_IDS order puts workbuddy first → primary is workbuddy.
    assert.equal(split.primaryScopeId, "workbuddy");
    const merged = await setMemoryTopology(true, { home });
    assert.equal(merged.shared, true);
    assert.equal(merged.scopes.kunlunxiaozhi, "workbuddy");
    assert.equal(merged.scopes.workbuddy, "workbuddy");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
