import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "./server.js";
import { json, readBody } from "./server.js";
import { memoryContextFromQuery, mergeBodyContext } from "./scope-context.js";
import { openSqliteDatabase } from "../system/sqlite.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Routes for the Console control plane:
 * GET  /v1/stats         — dashboard overview
 * GET  /v1/governance    — governance snapshot (profile/principles/recall/entity stats)
 * GET  /v1/events        — paginated event log
 * POST /v1/inspect/recall — full recall inspection with layers
 */
export async function handleConsoleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  path: string,
  url: URL,
): Promise<void> {
  // GET /v1/docs (2026-08-09): serve the README markdown for the console
  // "帮助文档" page. Resolved relative to this file so it works both from
  // src/http (dev) and dist/http (npm package).
  if (path === "/v1/docs" && req.method === "GET") {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const readme = readFileSync(join(here, "..", "..", "README.md"), "utf8");
      json(res, 200, { markdown: readme });
    } catch {
      json(res, 200, { markdown: "# LeafMem\n\n帮助文档暂不可用。" });
    }
    return;
  }

  // GET /v1/stats
  if (path === "/v1/stats" && req.method === "GET") {
    const memories = await ctx.platform.listMemories({
      context: memoryContextFromQuery(ctx.projectId, url),
      limit: 10_000,
    });

    // Aggregate by kind
    const kindCounts: Record<string, number> = {};
    const scopeCounts: Record<string, number> = {};
    const sourceCounts: Record<string, number> = {};
    let newest: string | null = null;
    let oldest: string | null = null;

    for (const record of memories) {
      kindCounts[record.kind] = (kindCounts[record.kind] ?? 0) + 1;
      const scopeKey = `${record.scope.type}:${record.scope.id}`;
      scopeCounts[scopeKey] = (scopeCounts[scopeKey] ?? 0) + 1;
      sourceCounts[record.source] = (sourceCounts[record.source] ?? 0) + 1;

      if (!newest || record.updatedAt > newest) newest = record.updatedAt;
      if (!oldest || record.createdAt < oldest) oldest = record.createdAt;
    }

    // Cheap operational extras (2026-08-08): task-context rows and active
    // documents live in the same SQLite file; read counts directly.
    let taskCount = 0, activeDocCount = 0;
    try {
      if (ctx.agents?.storagePath) {
        using db = openSqliteDatabase(ctx.agents.storagePath);
        taskCount = Number(
          (db.prepare("SELECT COUNT(*) AS c FROM task_context").get() as { c?: number } | undefined)?.c ?? 0,
        );
        activeDocCount = Number(
          (db.prepare("SELECT COUNT(*) AS c FROM active_documents").get() as { c?: number } | undefined)?.c ?? 0,
        );
      }
    } catch { /* counts are best-effort */ }
    json(res, 200, {
      totalMemories: memories.length,
      kinds: kindCounts,
      scopes: scopeCounts,
      sources: sourceCounts,
      newestMemory: newest,
      oldestMemory: oldest,
      recentEvents: (ctx.events?.recent({ limit: 10 }) ?? []).length,
      taskCount,
      activeDocCount,
    });
    return;
  }

  // GET /v1/governance (Console Plan-A, 2026-08-07): read-only snapshot of
  // profile / distilled principles / recall usage / entity stats.
  if (path === "/v1/governance" && req.method === "GET") {
    const snapshot = await ctx.platform.getGovernanceSnapshot({
      context: memoryContextFromQuery(ctx.projectId, url),
    });
    json(res, 200, snapshot);
    return;
  }

  // GET /v1/tasks (2026-08-09): list task_context rows for the console
  // tasks page (dashboard 任务上下文 KPI landing).
  if (path === "/v1/tasks" && req.method === "GET") {
    try {
      const storagePath = ctx.agents?.storagePath;
      if (!storagePath) {
        json(res, 200, { tasks: [] });
        return;
      }
      using db = openSqliteDatabase(storagePath);
      const tasks = db
        .prepare(
          `SELECT task_id, scope_type, scope_id, title, status, created_at, updated_at
           FROM task_context
           ORDER BY updated_at DESC
           LIMIT 200`,
        )
        .all() as Array<Record<string, unknown>>;
      json(res, 200, { tasks });
    } catch {
      json(res, 200, { tasks: [] });
    }
    return;
  }

  // GET /v1/events (enhanced with pagination & type filter)
  // GET /v1/graph (2026-08-08): lightweight entity knowledge-graph payload.
  // Nodes = entities, edges = entity_relations. No external graph DB needed:
  // the SQLite tables already hold a small graph (tens of nodes), rendered
  // client-side with a canvas force layout.
  if (path === "/v1/graph" && req.method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "300", 10), 800);
    try {
      const storagePath = ctx.agents?.storagePath;
      if (!storagePath) {
        json(res, 200, { nodes: [], edges: [] });
        return;
      }
      using db = openSqliteDatabase(storagePath);
      const nodes = db
        .prepare(
          `SELECT e.id, e.name, e.kind,
                  (SELECT COUNT(*) FROM entity_links l WHERE l.entity_id = e.id) AS link_count
           FROM entities e
           ORDER BY link_count DESC
           LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
      const ids = new Set(nodes.map((n) => String(n.id)));
      const edges = (
        db
          .prepare(
            `SELECT source_entity_id, target_entity_id, relation, confidence
             FROM entity_relations`,
          )
          .all() as Array<Record<string, unknown>>
      ).filter(
        (e) => ids.has(String(e.source_entity_id)) && ids.has(String(e.target_entity_id)),
      );
      let totalMemoryLinks = 0;
      try {
        using db2 = openSqliteDatabase(storagePath);
        totalMemoryLinks = Number(
          (db2.prepare("SELECT COUNT(*) AS c FROM entity_links").get() as { c?: number } | undefined)?.c ?? 0,
        );
      } catch { /* best-effort */ }
      json(res, 200, { nodes, edges, totalMemoryLinks });
    } catch {
      json(res, 200, { nodes: [], edges: [], totalMemoryLinks: 0 });
    }
    return;
  }

  // GET /v1/graph/entity?id= — entity detail: linked memories + relations.
  if (path === "/v1/graph/entity" && req.method === "GET") {
    const id = url.searchParams.get("id") ?? "";
    try {
      const storagePath = ctx.agents?.storagePath;
      if (!storagePath || !id) {
        json(res, 200, { entity: null, memories: [], relations: [] });
        return;
      }
      using db = openSqliteDatabase(storagePath);
      const entity = db
        .prepare("SELECT id, name, kind, aliases_json FROM entities WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;
      const memories = db
        .prepare(
          `SELECT l.relation, l.confidence, m.id AS memory_id, m.content, m.kind AS memory_kind
           FROM entity_links l
           LEFT JOIN memory_items m ON m.id = l.memory_id
           WHERE l.entity_id = ?
           ORDER BY l.confidence DESC
           LIMIT 60`,
        )
        .all(id) as Array<Record<string, unknown>>;
      const relations = db
        .prepare(
          `SELECT r.relation, r.confidence, e.id AS other_id, e.name AS other_name, e.kind AS other_kind,
                  CASE WHEN r.source_entity_id = ? THEN 'out' ELSE 'in' END AS dir
           FROM entity_relations r
           JOIN entities e ON e.id = CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END
           WHERE r.source_entity_id = ? OR r.target_entity_id = ?
           ORDER BY r.confidence DESC
           LIMIT 60`,
        )
        .all(id, id, id, id) as Array<Record<string, unknown>>;
      json(res, 200, { entity: entity ?? null, memories, relations });
    } catch {
      json(res, 200, { entity: null, memories: [], relations: [] });
    }
    return;
  }

  if (path === "/v1/events" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const type = url.searchParams.get("type") ?? undefined;
    const events = ctx.events?.recent({
      limit: Math.min(limit, 200),
      type: type as any,
    }) ?? [];
    json(res, 200, { events, total: events.length });
    return;
  }

  // POST /v1/inspect/recall
  if (path === "/v1/inspect/recall" && req.method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const context = mergeBodyContext(memoryContextFromQuery(ctx.projectId, url), body.context);

    const result = await ctx.platform.inspectRecall({
      context,
      message: (body.message as string) ?? "",
      recentMessages: body.recentMessages as string[] | undefined,
      toolContext: body.toolContext as string | undefined,
      maxChars: body.maxChars as number | undefined,
      inspect: true,
    });

    json(res, 200, result);
    return;
  }

  json(res, 404, { error: "Not found" });
}
