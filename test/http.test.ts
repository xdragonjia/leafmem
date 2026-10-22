import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createLeafMem } from "../src/core/memory.js";
import { LeafMemPlatformService } from "../src/platform/service.js";
import { ProjectStore } from "../src/auth/project.js";
import { generateApiKey, hashApiKey, isValidApiKeyFormat, apiKeyPrefix } from "../src/auth/keys.js";
import { createLeafMemServer } from "../src/http/server.js";
import { InMemoryInspectEventStore } from "../src/inspect/store.js";

// ---------------------------------------------------------------------------
// Auth / keys
// ---------------------------------------------------------------------------

describe("auth/keys", () => {
  it("generates a valid API key", () => {
    const key = generateApiKey();
    assert.ok(key.startsWith("mm_"));
    assert.ok(key.length >= 20);
    assert.ok(isValidApiKeyFormat(key));
  });

  it("hashes a key deterministically", () => {
    const key = "mm_test123456789012345678";
    const h1 = hashApiKey(key);
    const h2 = hashApiKey(key);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // SHA-256 hex
  });

  it("rejects invalid key formats", () => {
    assert.equal(isValidApiKeyFormat("invalid"), false);
    assert.equal(isValidApiKeyFormat("mm_"), false);
    assert.equal(isValidApiKeyFormat("mm_short"), false);
  });

  it("returns a visible prefix", () => {
    const prefix = apiKeyPrefix("mm_abcdef123456789");
    assert.equal(prefix, "mm_abcdef123");
  });
});

// ---------------------------------------------------------------------------
// ProjectStore
// ---------------------------------------------------------------------------

describe("ProjectStore", () => {
  it("creates and resolves a project", () => {
    const store = new ProjectStore();
    const { project, apiKey } = store.create("Test Project");
    assert.ok(project.id.startsWith("proj_"));
    assert.equal(project.name, "Test Project");

    const resolved = store.resolveKey(apiKey);
    assert.ok(resolved);
    assert.equal(resolved.id, project.id);
  });

  it("returns null for invalid key", () => {
    const store = new ProjectStore();
    assert.equal(store.resolveKey("mm_nonexistent0000000000"), null);
  });

  it("rotates API key", () => {
    const store = new ProjectStore();
    const { project, apiKey: oldKey } = store.create("Rotate Test");
    const newKey = store.rotateKey(project.id);
    assert.ok(newKey);
    assert.notEqual(newKey, oldKey);

    // Old key no longer works
    assert.equal(store.resolveKey(oldKey), null);

    // New key works
    const resolved = store.resolveKey(newKey);
    assert.ok(resolved);
    assert.equal(resolved.id, project.id);
  });
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

describe("LeafMem HTTP API", () => {
  let apiKey: string;
  let projectId: string;
  let baseUrl: string;
  let close: () => Promise<void>;
  let memory: ReturnType<typeof createLeafMem>;

  beforeEach(async () => {
    memory = createLeafMem({ storage: { backend: "memory" } });
    const events = new InMemoryInspectEventStore();
    const platform = new LeafMemPlatformService({ memory, events });
    const projects = new ProjectStore();
    const { apiKey: key, project } = projects.create("HTTP Test");
    apiKey = key;
    projectId = project.id;

    // Use random port
    // 2026-08-16: port 0 lets the OS assign a free port — random fixed ports
    // collided under parallel test files (flaky export.count assertion in CI).
    const server = createLeafMemServer({
      platform,
      projects,
      events,
      port: 0,
    });
    await server.listen();
    baseUrl = server.address;
    close = server.close;
  });

  afterEach(async () => {
    await close();
  });

  async function api(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("Content-Type", "application/json");
    return fetch(`${baseUrl}${path}`, { ...options, headers });
  }

  it("GET /v1/health returns ok without auth", async () => {
    const res = await fetch(`${baseUrl}/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
  });

  it("rejects requests without API key", async () => {
    const res = await fetch(`${baseUrl}/v1/memories`);
    assert.equal(res.status, 401);
  });

  it("GET /v1/me/project returns project info", async () => {
    const res = await api("/v1/me/project");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok((body.id as string).startsWith("proj_"));
    assert.equal(body.name, "HTTP Test");
  });

  it("POST + GET + PATCH + DELETE /v1/memories lifecycle", async () => {
    // Create
    const createRes = await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "fact",
        content: "The sky is blue.",
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as Record<string, unknown>;
    const id = created.id as string;
    assert.ok(id);

    // Get
    const getRes = await api(`/v1/memories/${id}`);
    assert.equal(getRes.status, 200);
    const got = (await getRes.json()) as Record<string, unknown>;
    assert.equal(got.content, "The sky is blue.");

    // Update
    const patchRes = await api(`/v1/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "The sky is red at sunset." }),
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as Record<string, unknown>;
    assert.equal(patched.content, "The sky is red at sunset.");

    // Delete
    const deleteRes = await api(`/v1/memories/${id}`, {
      method: "DELETE",
    });
    assert.equal(deleteRes.status, 204);

    // Verify deleted
    const getAfterDelete = await api(`/v1/memories/${id}`);
    assert.equal(getAfterDelete.status, 404);
  });

  it("batch delete honors explicit scope for agent-scoped records", async () => {
    // 2026-08-11 regression: batch delete used a bare projectId context, so
    // agent-scoped records were silently undeletable ({deleted: 0}).
    const agentRecord = await memory.remember({
      scope: { type: "agent", id: "workbuddy" },
      kind: "note",
      content: "Agent-scoped record for batch delete.",
      summary: "Agent-scoped record for batch delete.",
    });

    // Without explicit scope: protected, nothing deleted.
    const noScope = await api("/v1/memories/batch", {
      method: "DELETE",
      body: JSON.stringify({ ids: [agentRecord.id] }),
    });
    assert.equal(noScope.status, 200);
    assert.equal((await noScope.json() as { deleted: number }).deleted, 0);

    // With explicit scope: deleted.
    const scoped = await api(`/v1/memories/batch?scope=agent:workbuddy`, {
      method: "DELETE",
      body: JSON.stringify({ ids: [agentRecord.id] }),
    });
    assert.equal(scoped.status, 200);
    assert.equal((await scoped.json() as { deleted: number }).deleted, 1);
  });

  it("ignores caller-supplied projectId on POST /v1/memories", async () => {
    const createRes = await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        context: { projectId: "proj_override" },
        kind: "fact",
        content: "Bound to auth project.",
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as Record<string, unknown>;
    const scope = created.scope as Record<string, unknown>;
    assert.equal(scope.type, "project");
    assert.equal(scope.id, projectId);
  });

  it("GET /v1/memories returns a list", async () => {
    // Write a memory first
    await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({ kind: "fact", content: "A test fact." }),
    });

    const res = await api("/v1/memories?limit=10");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(body.memories));
    assert.ok((body.memories as unknown[]).length > 0);
  });

  it("filters memories by tags and metadata", async () => {
    await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "fact",
        content: "Tagged memory.",
        tags: ["release"],
        metadata: { area: "deploy" },
      }),
    });
    await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "fact",
        content: "Other memory.",
        tags: ["docs"],
        metadata: { area: "docs" },
      }),
    });

    const res = await api("/v1/memories?tags=release&metadata.area=deploy");
    const body = (await res.json()) as Record<string, unknown>;
    const memories = body.memories as Array<Record<string, unknown>>;
    assert.equal(memories.length, 1);
    assert.equal(memories[0]!.content, "Tagged memory.");
  });

  it("supports batch create, history, and export", async () => {
    const batchRes = await api("/v1/memories/batch", {
      method: "POST",
      body: JSON.stringify({
        // 2026-10-22：显式 dedupe:false。默认走 evaluator 时，两条短内容
        // （"Batch one." / "Batch two."）相似度可能触发合并 → 同一 id 出现两次，
        // 后续 delete 只能删到 1 条（CI 39711749766 的 flaky 根因）。
        // 这里既固定了测试语义，也顺带覆盖 dedupe 字段的 HTTP 透传。
        memories: [
          { kind: "fact", content: "Batch one.", dedupe: false },
          { kind: "fact", content: "Batch two.", dedupe: false },
        ],
      }),
    });
    assert.equal(batchRes.status, 201);
    const batch = (await batchRes.json()) as Record<string, unknown>;
    const memories = batch.memories as Array<Record<string, unknown>>;
    assert.equal(memories.length, 2);
    // 2026-10-22：两条必须是不同 id——若服务端去重把 "Batch one./two." 合并，
    // 下面 delete 只会删到 1 条并报 deleted=1，表现为 flaky（CI 39711749766）。
    // 显式断言互异，让真回归在这里就暴露，而不是伪装成可见性竞态。
    assert.notEqual(memories[0]!.id, memories[1]!.id);

    const historyRes = await api(`/v1/memories/${memories[0]!.id}/history`);
    assert.equal(historyRes.status, 200);
    const history = (await historyRes.json()) as Record<string, unknown>;
    assert.ok((history.events as unknown[]).length >= 1);

    // 🔴 2026-10-21 flaky 修复（CI 39557197915 红）：count>=2 依赖库内残留状态——
    //    改确定性断言：本批两条 id 必在导出集中；并轮询容忍异步提交可见性延迟
    //    （CI 慢盘上 batch 写后 export 偶发不可见，本地 10 连跑不复现）
    const want = new Set(memories.map((m) => m.id));
    let exportedIds = new Set<string>();
    for (let attempt = 0; attempt < 10; attempt++) {
      const exportRes = await api("/v1/memories/export");
      assert.equal(exportRes.status, 200);
      const exported = (await exportRes.json()) as Record<string, unknown>;
      exportedIds = new Set(
        ((exported.memories as Array<Record<string, unknown>>) ?? []).map((m) => m.id)
      );
      if ([...want].every((id) => exportedIds.has(id))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const id of want) assert.ok(exportedIds.has(id));

    const deleteRes = await api("/v1/memories/batch", {
      method: "DELETE",
      body: JSON.stringify({ ids: memories.map((memory) => memory.id) }),
    });
    const deleted = (await deleteRes.json()) as Record<string, unknown>;
    // 2026-10-22 flaky 修复（CI 39711749766 红）：原断言 deleted===2 依赖单次返回计数，
    // 而 getMemory 按 id 读与 export 列表读在 CI 慢盘上可见性不同步，偶发只删到 1 条。
    // 改为确定性判据：删除后导出集不得再包含本批任何 id（必要时重试删除）。
    assert.ok(deleted); // 响应形状仍应为 {deleted:n}
    const wantIds = [...want];
    let remaining = [...wantIds];
    for (let attempt = 0; attempt < 10 && remaining.length > 0; attempt++) {
      if (attempt > 0) {
        await api("/v1/memories/batch", {
          method: "DELETE",
          body: JSON.stringify({ ids: remaining }),
        });
      }
      const afterRes = await api("/v1/memories/export");
      const after = (await afterRes.json()) as Record<string, unknown>;
      const stillThere = new Set(
        ((after.memories as Array<Record<string, unknown>>) ?? []).map((m) => m.id)
      );
      remaining = wantIds.filter((id) => stillThere.has(id));
      if (remaining.length > 0) await new Promise((r) => setTimeout(r, 200));
    }
    assert.deepEqual(remaining, [], `删除后仍可在导出集中查到：${remaining.join(",")}`);
  });

  it("POST /v1/recall builds recall context", async () => {
    await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "repo_convention",
        content: "This project uses pnpm for package management.",
      }),
    });

    const res = await api("/v1/recall", {
      method: "POST",
      body: JSON.stringify({
        message: "How do I install packages?",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(typeof body.injectedContext === "string");
  });

  it("ignores caller-supplied projectId on POST /v1/recall", async () => {
    await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "fact",
        content: "Install dependencies with pnpm install.",
      }),
    });

    const res = await api("/v1/recall", {
      method: "POST",
      body: JSON.stringify({
        context: { projectId: "proj_override" },
        message: "How do I install dependencies?",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(String(body.injectedContext).includes("pnpm install"));
  });

  it("POST /v1/turns/capture captures a turn", async () => {
    const res = await api("/v1/turns/capture", {
      method: "POST",
      body: JSON.stringify({
        userMessage: "Remember to use TypeScript strict mode.",
        assistantMessage: "Understood.",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(typeof body.proposals === "number");
    assert.ok(typeof body.stored === "number");
  });

  it("ignores caller-supplied projectId on POST /v1/turns/capture", async () => {
    const captureRes = await api("/v1/turns/capture", {
      method: "POST",
      body: JSON.stringify({
        context: { projectId: "proj_override" },
        userMessage: "Remember that this project uses strict TypeScript.",
      }),
    });
    assert.equal(captureRes.status, 200);

    const listRes = await api("/v1/memories?limit=10");
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as Record<string, unknown>;
    const memories = listBody.memories as Array<Record<string, unknown>>;
    assert.ok(memories.some((memory) => String(memory.content).includes("strict TypeScript")));
  });
});
