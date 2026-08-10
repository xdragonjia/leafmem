import { AGENT_IDS } from "../agents/manager.js";
import type { MemoryContext } from "../platform/types.js";

const SCOPE_TYPES = ["agent", "session", "user", "task", "document", "project", "repo"] as const;

export function memoryContextFromQuery(projectId: string, url: URL): MemoryContext {
  const scope = url.searchParams.get("scope")?.trim();
  const view = url.searchParams.get("view")?.trim();

  // "全部记忆": no scope filtering at all (single-machine union of everything).
  if (scope === "all" || view === "all") {
    return { projectId, allScopes: true };
  }

  // Any explicit scope of any type: agent:x / user:x / task:x / ...
  if (scope && scope.includes(":")) {
    const [prefix, ...rest] = scope.split(":");
    const id = rest.join(":").trim();
    if (id && (SCOPE_TYPES as readonly string[]).includes(prefix!.toLowerCase())) {
      return { projectId, anyScope: { type: prefix!.toLowerCase(), id } };
    }
  }

  if (scope === "shared" || view === "shared") {
    // Wildcard user scope (2026-08-10): the shared view is a union of
    // everything across hosts, so user-scoped memories (host-independent
    // user facts/lessons) must not be silently excluded.
    return { projectId, agentIds: [...AGENT_IDS], userId: "*" };
  }

  return { projectId };
}

export function mergeBodyContext(base: MemoryContext, value: unknown): MemoryContext {
  const bodyContext =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    ...base,
    ...bodyContext,
    projectId: base.projectId,
  } as MemoryContext;
}
