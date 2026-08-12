import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "./server.js";
import { bindAuthorizedContext, json, readBody } from "./server.js";
import { memoryContextFromQuery } from "./scope-context.js";

/** 2026-08-11 scope-resolution fix: writes must honour an explicit scope.
 *
 * Bug: POST /v1/memories only read body.context, so a top-level body.scope
 * (or nothing at all) silently fell through to the session-local projectId
 * scope (proj_local_*) — records became invisible to agent-scoped recall and
 * console views. Precedence now: body.scope > body.context.scope > URL ?scope=.
 * If none provided, keep the legacy projectId behavior (console session pool).
 */
function writeContext(
  projectId: string,
  url: URL,
  bodyContext: unknown,
  bodyScope?: unknown,
): Record<string, unknown> {
  const pick = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const scope =
    pick(bodyScope) ??
    pick((bodyContext as Record<string, unknown> | undefined)?.scope) ??
    pick(url.searchParams.get("scope"));
  if (scope) {
    return memoryContextFromQuery(
      projectId,
      new URL(`http://local/v1/memories?scope=${encodeURIComponent(scope)}`),
    ) as unknown as Record<string, unknown>;
  }
  return bindAuthorizedContext(projectId, bodyContext);
}

export async function handleMemoryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  path: string,
  url: URL,
): Promise<void> {
  // POST /v1/memories/batch — create many
  if (path === "/v1/memories/batch" && req.method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const memories = Array.isArray(body.memories) ? body.memories : [];
    const records = [];
    for (const item of memories) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const memory = item as Record<string, unknown>;
      const context = writeContext(ctx.projectId, url, memory.context, memory.scope ?? body.scope);
      records.push(await ctx.platform.writeMemory({
        context: context as any,
        kind: (memory.kind as string) ?? "note",
        content: (memory.content as string) ?? "",
        summary: memory.summary as string | undefined,
        confidence: memory.confidence as number | undefined,
        importance: memory.importance as number | undefined,
        source: memory.source as string | undefined,
        tags: memory.tags as string[] | undefined,
        metadata: memory.metadata as Record<string, unknown> | undefined,
      }));
    }
    json(res, 201, { memories: records, count: records.length });
    return;
  }

  // DELETE /v1/memories/batch — delete many
  if (path === "/v1/memories/batch" && req.method === "DELETE") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    // 2026-08-11 fix (same root cause as the single-DELETE 404 incident):
    // batch used a bare projectId context, so recordBelongsToProject never
    // matched agent-scoped records and every batch delete silently returned
    // {deleted: 0}. Mirror the single-DELETE semantics: an explicit scope=
    // selection is required to touch agent-scoped records.
    const hasExplicitScope = Boolean(url.searchParams.get("scope")?.trim());
    const context = hasExplicitScope
      ? memoryContextFromQuery(ctx.projectId, url)
      : { projectId: ctx.projectId };
    let deleted = 0;
    for (const id of ids) {
      if (await ctx.platform.deleteMemory({ context, id })) {
        deleted++;
      }
    }
    json(res, 200, { deleted });
    return;
  }

  // GET /v1/memories/export — export JSON
  if (path === "/v1/memories/export" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "1000", 10);
    const records = await ctx.platform.listMemories({
      context: memoryContextFromQuery(ctx.projectId, url),
      limit: Math.min(limit, 5000),
    });
    json(res, 200, {
      exportedAt: new Date().toISOString(),
      count: records.length,
      memories: records,
    });
    return;
  }

  // POST /v1/memories — create
  if (path === "/v1/memories" && req.method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const context = writeContext(ctx.projectId, url, body.context, body.scope);
    const record = await ctx.platform.writeMemory({
      context: context as any,
      kind: (body.kind as string) ?? "note",
      content: (body.content as string) ?? "",
      summary: body.summary as string | undefined,
      confidence: body.confidence as number | undefined,
      importance: body.importance as number | undefined,
      source: body.source as string | undefined,
      tags: body.tags as string[] | undefined,
      metadata: body.metadata as Record<string, unknown> | undefined,
    });
    json(res, 201, record);
    return;
  }

  // GET /v1/memories — list
  if (path === "/v1/memories" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean);
    const tags = url.searchParams.get("tags")?.split(",").filter(Boolean);
    const records = await ctx.platform.listMemories({
      context: memoryContextFromQuery(ctx.projectId, url),
      limit: Math.min(limit, 200),
      cursor,
      kinds,
      tags,
      metadata: parseMetadataFilters(url),
    });
    json(res, 200, { memories: records, count: records.length });
    return;
  }

  // Extract ID for single-resource routes
  const idMatch = path.match(/^\/v1\/memories\/([^/]+)(?:\/history)?$/);
  if (!idMatch) {
    json(res, 404, { error: "Not found" });
    return;
  }
  const id = idMatch[1]!;
  const ref = { context: memoryContextFromQuery(ctx.projectId, url), id };
  const writeRef = { context: { projectId: ctx.projectId }, id };
  // Destructive ops require an explicit scope= selection (2026-08-08):
  // view=shared / no-scope callers must NOT be able to mutate agent-scoped
  // records (project isolation, see console tests). The console sends the
  // currently selected scope on its delete button, so this stays usable.
  const hasExplicitScope = Boolean(url.searchParams.get("scope")?.trim());
  const destructiveRef = hasExplicitScope ? ref : writeRef;

  // GET /v1/memories/:id/history
  if (path.endsWith("/history") && req.method === "GET") {
    const events = ctx.events
      ? ctx.events.recent({ limit: 500 }).events.filter((event) => event.data?.["recordId"] === id)
      : [];
    json(res, 200, { events, count: events.length });
    return;
  }

  // GET /v1/memories/:id
  if (req.method === "GET") {
    const record = await ctx.platform.getMemory(ref);
    if (!record) {
      json(res, 404, { error: "Memory not found" });
      return;
    }
    json(res, 200, record);
    return;
  }

  // PATCH /v1/memories/:id
  if (req.method === "PATCH") {
    const patch = (await readBody(req)) as Record<string, unknown>;
    const updated = await ctx.platform.updateMemory({
      ref: destructiveRef,
      patch: {
        content: patch.content as string | undefined,
        summary: patch.summary as string | undefined,
        kind: patch.kind as string | undefined,
        confidence: patch.confidence as number | undefined,
        importance: patch.importance as number | undefined,
        source: patch.source as string | undefined,
        tags: patch.tags as string[] | undefined,
        metadata: patch.metadata as Record<string, unknown> | undefined,
      },
    });
    if (!updated) {
      json(res, 404, { error: "Memory not found" });
      return;
    }
    json(res, 200, updated);
    return;
  }

  // DELETE /v1/memories/:id
  // (2026-08-08 fix) use the scope-aware ref: the old writeRef carried only
  // projectId, so recordBelongsToProject could never match agent-scoped
  // records and every delete returned 404.
  if (req.method === "DELETE") {
    const deleted = await ctx.platform.deleteMemory(destructiveRef);
    if (!deleted) {
      json(res, 404, { error: "Memory not found" });
      return;
    }
    json(res, 204, null);
    return;
  }

  json(res, 405, { error: "Method not allowed" });
}

function parseMetadataFilters(url: URL): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (key.startsWith("metadata.")) {
      metadata[key.slice("metadata.".length)] = value;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
