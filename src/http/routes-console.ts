import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "./server.js";
import { json, readBody } from "./server.js";
import { memoryContextFromQuery, mergeBodyContext } from "./scope-context.js";
import { openSqliteDatabase } from "../system/sqlite.js";

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
      json(res, 200, { nodes, edges });
    } catch {
      json(res, 200, { nodes: [], edges: [] });
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
