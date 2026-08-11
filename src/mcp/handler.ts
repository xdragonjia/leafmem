import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LeafMem } from "../core/memory.js";
import type { InspectEventStore } from "../inspect/types.js";
import {
  MEMORY_SCOPE_TYPES,
  parseMemoryScopeType,
  type MemoryRecord,
  type MemoryScope,
} from "../core/types.js";
import { createMemoryRuntime, type MemoryRuntime } from "../runtime/index.js";

type JsonRpcId = string | number | null;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"] as const;

// 运行时从 package.json 读取版本号（相对 dist/mcp/ 与 src/mcp/ 都是 ../../package.json），
// 避免 serverInfo.version 硬编码再次漂移（0.2.0 审查 m1）。
function readPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const PACKAGE_VERSION = readPackageVersion();
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_CONTEXT_MAX_CHARS = 400;
const ACTIVE_EXPERIENCE_MAX_CHARS = 800;
const SCOPE_TYPE_SCHEMA = { type: "string", enum: [...MEMORY_SCOPE_TYPES] };
const SERVER_INSTRUCTIONS =
  "Use memory_recall with action='recall' and no scopeType/scopeId when continuity or prior decisions matter, so LeafMem can search shared memory across agents. " +
  "Use memory_write with action='remember' for durable user preferences, facts, or explicit remember requests. " +
  "Use memory_write with action='commit' when the host agent has already distilled a session; include activeContext/activeExperience when available, and follow maintenanceRequest if returned. " +
  "Use memory_write with action='task_append' or memory_recall with action='task_window' for longer task-focused work. " +
  "Use memory_organize for periodic curation (reflect/profile/decay) and memory_govern for user-driven corrections (update/delete/attribute/pin).";

export type MemoryToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutatesMemory?: boolean;
  execute(args: Record<string, unknown>): Promise<unknown>;
};

export function createMemoryToolSet(params: {
  memory: LeafMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
  onMemoryChanged?: () => Promise<void>;
  events?: InspectEventStore;
}): MemoryToolDefinition[] {
  const runtime =
    params.runtime ??
    createMemoryRuntime({
      memory: params.memory,
      defaultScopes: params.defaultScopes,
    });

  // ---------------------------------------------------------------------
  // LeafMem closed-loop tool surface (2026-08-09 refactor):
  //   memory_write    — write memory   (remember/commit/task_append/active_distill)
  //   memory_recall   — recall memory  (recall/search/get/list/task_window/active_get)
  //   memory_organize — curate memory  (prepare/apply/reflect/profile/decay/calibrate/rebuild)
  //   memory_govern   — manage memory  (update/delete/attribute/pin)
  // ---------------------------------------------------------------------
  return [
    {
      name: "memory_recall",
      description: "Recall long-term memory: build prompt-ready recall context, search/get/list records, build a task window, or read active context/experience.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["recall", "search", "get", "list", "task_window", "active_get"] },
          message: { type: "string" },
          query: { type: "string" },
          id: { type: "string" },
          taskId: { type: "string" },
          toolContext: { type: "string" },
          recentMessages: { type: "array", items: { type: "string" } },
          scopeType: SCOPE_TYPE_SCHEMA,
          scopeId: { type: "string" },
          maxResults: { type: "number" },
          minScore: { type: "number" },
          maxChars: { type: "number" },
          limit: { type: "number" },
        },
        required: ["action"],
      },
      execute: async (args) => {
        const action = expectString(args.action, "action");
        const scopes = parseReadScopeArgs(args);
        if (action === "recall") {
          const result = await runtime.buildRecallContext({
            userMessage: expectString(args.message, "message"),
            recentMessages: Array.isArray(args.recentMessages)
              ? args.recentMessages.filter((entry): entry is string => typeof entry === "string")
              : undefined,
            scopes,
            maxChars: expectNumber(args.maxChars),
          });
          params.events?.emit({
            type: "recall_built",
            context: { projectId: "local", agentIds: (scopes ?? []).map((s) => s.id).filter((id) => id !== "shared") },
            data: {
              message: truncForEvent(expectString(args.message, "message")),
              hits: (result.hits ?? []).length,
            },
          });
          return result;
        }
        if (action === "search") {
          return {
            hits: await params.memory.search(expectString(args.query, "query"), {
              scopes,
              maxResults: expectNumber(args.maxResults),
              minScore: expectNumber(args.minScore),
            }),
          };
        }
        if (action === "get") {
          return { record: await params.memory.get(expectString(args.id, "id")) };
        }
        if (action === "list") {
          return {
            records: await params.memory.list({
              scopes,
              limit: expectNumber(args.limit),
            }),
          };
        }
        if (action === "task_window") {
          return await params.memory.task.buildWindow({
            taskId: expectString(args.taskId, "taskId"),
            currentQuery: expectString(args.message, "message"),
            toolContext: optionalString(args.toolContext),
            maxChars: expectNumber(args.maxChars),
          });
        }
        if (action === "active_get") {
          const scope = requireScope(args, params.defaultScopes);
          return {
            context: await params.memory.active.read("context", scope),
            experience: await params.memory.active.read("experience", scope),
            profile: await params.memory.active.read("profile", scope),
          };
        }
        throw new Error("action must be recall, search, get, list, task_window, or active_get");
      },
    },
    {
      name: "memory_write",
      description: "Write memory: remember a durable record, commit a host-distilled session (returns maintenanceRequest when deeper governance is due), append a task entry, or distill active context/experience.",
      mutatesMemory: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["remember", "commit", "task_append", "active_distill"] },
          // remember
          content: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          confidence: { type: "number" },
          importance: { type: "number" },
          source: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          metadata: { type: "object", additionalProperties: true },
          // commit
          agent: { type: "string" },
          sessionId: { type: "string" },
          taskId: { type: "string" },
          title: { type: "string" },
          cwd: { type: "string" },
          timestamp: { type: "string" },
          messageCount: { type: "number" },
          rollingSummary: { type: "string" },
          activeContext: { type: "string" },
          activeExperience: { type: "string" },
          governanceReport: { type: "object", additionalProperties: true },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                role: { type: "string" },
                content: { type: "string" },
                summary: { type: "string" },
                tokenCount: { type: "number" },
                metadata: { type: "object", additionalProperties: true },
              },
              required: ["role", "content"],
            },
          },
          durableMemories: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                content: { type: "string" },
                kind: { type: "string" },
                summary: { type: "string" },
                scopeType: SCOPE_TYPE_SCHEMA,
                scopeId: { type: "string" },
                confidence: { type: "number" },
                importance: { type: "number" },
                source: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                metadata: { type: "object", additionalProperties: true },
              },
              required: ["content"],
            },
          },
          // task_append
          role: { type: "string" },
          // active_distill
          maxChars: { type: "number" },
          scopeType: SCOPE_TYPE_SCHEMA,
          scopeId: { type: "string" },
        },
        required: ["action"],
      },
      execute: async (args) => {
        const action = expectString(args.action, "action");
        if (action === "remember") {
          const scope = requireScope(args, params.defaultScopes);
          const written = await params.memory.remember({
            scope,
            kind: optionalString(args.kind) ?? "note",
            content: expectString(args.content, "content"),
            summary: optionalString(args.summary),
            confidence: expectNumber(args.confidence),
            importance: expectNumber(args.importance),
            source: optionalString(args.source),
            tags: Array.isArray(args.tags)
              ? args.tags.filter((entry): entry is string => typeof entry === "string")
              : undefined,
            metadata: asRecord(args.metadata) ?? undefined,
          });
          params.events?.emit({
            type: "memory_written",
            context: scopeContextOf(scope),
            data: { recordId: written.id, kind: written.kind },
          });
          return { record: written };
        }
        if (action === "commit") {
          const agent = expectString(args.agent, "agent");
          const sessionId = expectString(args.sessionId, "sessionId");
          const rollingSummary = expectString(args.rollingSummary, "rollingSummary");
          const activeContext = optionalString(args.activeContext);
          const activeExperience = optionalString(args.activeExperience);
          const governanceReport = asRecord(args.governanceReport) ?? undefined;
          const taskId = optionalString(args.taskId) ?? `${agent}:${sessionId}`;
          const scope = parseScopeArgs(args, params.defaultScopes)?.[0];
          if (!scope) {
            throw new Error("scopeType and scopeId are required when no default scope is configured");
          }
          let task = await params.memory.task.get(taskId);
          if (!task) {
            task = await params.memory.task.create({
              taskId,
              scope,
              title: optionalString(args.title) ?? `${agent} session ${sessionId}`,
              status: "completed",
            });
          }

          const existingRecord = await findSessionMemoryRecord(params.memory, scope, sessionId, taskId);
          const existingMetadata = asRecord(existingRecord?.metadata) ?? {};
          const previousMessageCount = expectNumber(existingMetadata.messageCount) ?? 0;
          const messageCount = expectNumber(args.messageCount);
          const entries = parseSessionCommitEntries(args.entries);
          const shouldAppendEntries =
            entries.length > 0 &&
            (messageCount === undefined || messageCount > previousMessageCount || existingRecord === null);
          const appendedEntries = [];
          if (shouldAppendEntries) {
            for (const entry of entries) {
              const appended = await params.memory.task.appendEntry({
                taskId,
                role: entry.role,
                content: entry.content,
                summary: entry.summary,
                tokenCount: entry.tokenCount,
                metadata: entry.metadata,
              });
              if (appended) {
                appendedEntries.push(appended);
              }
            }
            await params.memory.task.markEntriesSummarized(
              taskId,
              appendedEntries.map((entry) => entry.id),
              rollingSummary,
            );
          }

          const state = await params.memory.task.setRollingSummary(taskId, rollingSummary);
          const nowIso = new Date().toISOString();
          const source = existingRecord?.source || `${agent}_session_commit`;
          const sessionMetadata = compactRecord({
            ...existingMetadata,
            agent,
            sessionId,
            taskId,
            cwd: optionalString(args.cwd) ?? optionalString(existingMetadata.cwd),
            timestamp: optionalString(args.timestamp) ?? optionalString(existingMetadata.timestamp),
            messageCount: Math.max(
              previousMessageCount,
              messageCount ?? previousMessageCount + appendedEntries.length,
            ),
            lastCommittedAt: nowIso,
            commitSource: "host",
            resumeCount:
              (expectNumber(existingMetadata.resumeCount) ?? 0) +
              (existingRecord && appendedEntries.length > 0 ? 1 : 0),
          });
          const sessionPatch = {
            scope,
            kind: "note",
            content: buildSessionCommitContent({
              agent,
              sessionId,
              taskId,
              cwd: optionalString(args.cwd) ?? optionalString(existingMetadata.cwd),
              timestamp: optionalString(args.timestamp) ?? optionalString(existingMetadata.timestamp),
              rollingSummary,
            }),
            summary: clampText(`${agent} session ${sessionId}: ${rollingSummary}`, 220),
            confidence: 0.9,
            importance: 0.6,
            source,
            tags: [agent, "session"],
            metadata: sessionMetadata,
          };
          const sessionRecord = existingRecord
            ? await params.memory.update(existingRecord.id, sessionPatch)
            : await params.memory.remember(sessionPatch);

          const durableRecords = [];
          for (const memory of parseDurableMemories(args.durableMemories)) {
            durableRecords.push(
              await params.memory.remember({
                scope: memory.scope ?? scope,
                kind: memory.kind,
                content: memory.content,
                summary: memory.summary,
                confidence: memory.confidence,
                importance: memory.importance,
                source: memory.source ?? `${agent}_session_commit`,
                tags: memory.tags,
                metadata: compactRecord({
                  ...memory.metadata,
                  sessionId,
                  taskId,
                  cwd: optionalString(args.cwd),
                  origin: "host_session_commit",
                }),
              }),
            );
          }

          const sourceRecordIds = [
            sessionRecord?.id,
            ...durableRecords.map((record) => record.id),
          ].filter((id): id is string => typeof id === "string");
          const governanceMetadata = compactRecord({
            lastLightGovernedAt: nowIso,
            lastGovernedBy: agent,
            sessionId,
            taskId,
            sourceRecordIds,
            governanceReport,
          });
          const active = {
            context: await writeActiveDocument({
              memory: params.memory,
              kind: "context",
              scope,
              content: activeContext ?? rollingSummary,
              metadata: governanceMetadata,
              maxChars: ACTIVE_CONTEXT_MAX_CHARS,
            }),
            experience: activeExperience
              ? await writeActiveDocument({
                  memory: params.memory,
                  kind: "experience",
                  scope,
                  content: activeExperience,
                  metadata: governanceMetadata,
                  maxChars: ACTIVE_EXPERIENCE_MAX_CHARS,
                })
              : undefined,
          };
          const maintenanceRequest = await buildMaintenanceRequestIfDue(params.memory, scope, nowIso);

          return {
            task,
            state,
            sessionRecord,
            appendedEntries: appendedEntries.length,
            durableRecords,
            active,
            maintenanceRequest,
          };
        }
        if (action === "task_append") {
          const taskId = expectString(args.taskId, "taskId");
          let task = await params.memory.task.get(taskId);
          if (!task) {
            const scope = parseScopeArgs(args, params.defaultScopes)?.[0];
            if (!scope) {
              throw new Error("scopeType and scopeId are required when creating a task");
            }
            task = await params.memory.task.create({
              taskId,
              scope,
              title: optionalString(args.title) ?? taskId,
            });
          }
          const entry = await params.memory.task.appendEntry({
            taskId,
            role: expectString(args.role, "role") as "user" | "assistant" | "system" | "tool",
            content: expectString(args.content, "content"),
          });
          // 2026-08-11: let task_append carry an optional rolling summary so a
          // task created purely via appends is not left with transcript-but-no-
          // summary (console showed "Rolling Summary 暂无" on such tasks).
          const taskRollingSummary = optionalString(args.rollingSummary);
          if (taskRollingSummary) {
            await params.memory.task.setRollingSummary(taskId, taskRollingSummary);
          }
          return { task, entry };
        }
        if (action === "active_distill") {
          const scope = requireScope(args, params.defaultScopes);
          const kind = expectString(args.kind, "kind");
          const content = expectString(args.content, "content");
          if (kind === "context") {
            return {
              document: await params.memory.active.distillContext({
                scope,
                sessionSummary: content,
                maxChars: expectNumber(args.maxChars),
              }),
            };
          }
          if (kind === "experience") {
            return {
              document: await params.memory.active.distillExperience({
                scope,
                newData: content,
                maxChars: expectNumber(args.maxChars),
              }),
            };
          }
          if (kind === "profile") {
            // 2026-08-10: host-model-driven profile refresh via SECTION-LEVEL
            // merge. The host model supplies the updated section(s) as
            // "## Title\nbody" markdown; mergeProfile replaces only the
            // sections it names and preserves every other section verbatim,
            // so a partial refresh can never wipe unrelated sections. This is
            // the free path that replaced the inferencer-only buildProfile.
            const merged = await params.memory.mergeProfile({ scope, content });
            return {
              merged,
              document: await params.memory.active.read("profile", scope),
            };
          }
          throw new Error("kind must be 'context', 'experience', or 'profile'");
        }
        throw new Error("action must be remember, commit, task_append, or active_distill");
      },
    },
    {
      name: "memory_organize",
      description: "Curate memory: prepare/apply host-mediated active maintenance, distill principles (reflect), refresh the user profile (profile), decay stale records (decay), or maintain active experience (calibrate/rebuild).",
      mutatesMemory: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["prepare", "apply", "reflect", "profile", "decay", "calibrate", "rebuild"] },
          agent: { type: "string" },
          scopeType: SCOPE_TYPE_SCHEMA,
          scopeId: { type: "string" },
          maxChars: { type: "number" },
          recentLimit: { type: "number" },
          offset: { type: "number" },
          activeContext: { type: "string" },
          activeExperience: { type: "string" },
          governanceReport: { type: "object", additionalProperties: true },
          // decay tuning params
          ageDays: { type: "number" },
          recallFreshDays: { type: "number" },
          targetImportance: { type: "number" },
          dryRun: { type: "boolean" },
          // reflect tuning params
          sinceDays: { type: "number" },
          clusterSize: { type: "number" },
          maxClusters: { type: "number" },
          // profile tuning params
          profileLimit: { type: "number" },
        },
        required: ["action"],
      },
      execute: async (args) => {
        const action = expectString(args.action, "action");
        const scope = requireScope(args, params.defaultScopes);
        if (action === "prepare") {
          return {
            request: await buildMaintenanceRequest(params.memory, scope, new Date().toISOString()),
          };
        }
        if (action === "apply") {
          const activeContext = optionalString(args.activeContext);
          const activeExperience = optionalString(args.activeExperience);
          if (!activeContext && !activeExperience) {
            throw new Error("activeContext or activeExperience is required for apply");
          }
          const nowIso = new Date().toISOString();
          const governanceMetadata = compactRecord({
            lastLightGovernedAt: nowIso,
            lastDeepGovernedAt: nowIso,
            lastGovernedBy: optionalString(args.agent) ?? "host",
            governanceReport: asRecord(args.governanceReport) ?? undefined,
          });
          return {
            context: activeContext
              ? await writeActiveDocument({
                  memory: params.memory,
                  kind: "context",
                  scope,
                  content: activeContext,
                  metadata: governanceMetadata,
                  maxChars: ACTIVE_CONTEXT_MAX_CHARS,
                })
              : await params.memory.active.read("context", scope),
            experience: activeExperience
              ? await writeActiveDocument({
                  memory: params.memory,
                  kind: "experience",
                  scope,
                  content: activeExperience,
                  metadata: governanceMetadata,
                  maxChars: ACTIVE_EXPERIENCE_MAX_CHARS,
                })
              : await params.memory.active.read("experience", scope),
          };
        }
        if (action === "reflect") {
          return {
            result: await params.memory.reflect({
              scopes: [scope],
              sinceDays: optionalNumber(args.sinceDays),
              clusterSize: optionalNumber(args.clusterSize),
              maxClusters: optionalNumber(args.maxClusters),
              dryRun: args.dryRun === true,
            }),
          };
        }
        if (action === "profile") {
          return {
            result: await params.memory.buildProfile({
              scope,
              limit: optionalNumber(args.profileLimit),
              dryRun: args.dryRun === true,
            }),
          };
        }
        if (action === "decay") {
          return {
            result: await params.memory.decay({
              scopes: [scope],
              ageDays: optionalNumber(args.ageDays),
              recallFreshDays: optionalNumber(args.recallFreshDays),
              targetImportance: optionalNumber(args.targetImportance),
              dryRun: args.dryRun === true,
            }),
          };
        }
        if (action === "calibrate") {
          return {
            result: await params.memory.maintenance.calibrateExperience({
              scope,
              maxChars: expectNumber(args.maxChars),
            }),
          };
        }
        if (action === "rebuild") {
          return {
            result: await params.memory.maintenance.rebuildExperience({
              scope,
              maxChars: expectNumber(args.maxChars),
              recentLimit: optionalNumber(args.recentLimit),
              offset: optionalNumber(args.offset),
            }),
          };
        }
        throw new Error("action must be prepare, apply, reflect, profile, decay, calibrate, or rebuild");
      },
    },
    {
      name: "memory_govern",
      description: "Manage memory: update or delete records (explicit scope required), attribute recall usefulness, or pin/unpin a record against decay.",
      mutatesMemory: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["update", "delete", "attribute", "pin"] },
          id: { type: "string" },
          pinned: { type: "boolean" },
          scopeType: SCOPE_TYPE_SCHEMA,
          scopeId: { type: "string" },
          content: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          confidence: { type: "number" },
          importance: { type: "number" },
          source: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          metadata: { type: "object", additionalProperties: true },
          recordIds: { type: "array", items: { type: "string" }, maxItems: 20 },
          response: { type: "string" },
          outcome: { type: "string", enum: ["positive", "neutral", "negative"] },
        },
        required: ["action"],
      },
      execute: async (args) => {
        const action = expectString(args.action, "action");
        if (action === "update" || action === "pin") {
          const id = expectString(args.id, "id");
          const scope = requireDestructiveScope(args, params.defaultScopes);
          const existing = await params.memory.get(id);
          if (!existing || !sameScope(existing.scope, scope)) {
            return { record: null, updated: false };
          }
          let patch: Record<string, unknown>;
          if (action === "pin") {
            const pin = args.pinned !== false; // default true
            const tags = [...existing.tags].filter((t) => t !== "pinned");
            if (pin) tags.push("pinned");
            patch = { tags };
          } else {
            patch = {};
            if (args.content !== undefined) patch.content = args.content;
            if (args.kind !== undefined) patch.kind = args.kind;
            if (args.summary !== undefined) patch.summary = args.summary;
            if (args.confidence !== undefined) patch.confidence = args.confidence;
            if (args.importance !== undefined) patch.importance = args.importance;
            if (args.source !== undefined) patch.source = args.source;
            if (args.tags !== undefined) patch.tags = args.tags;
            // asRecord() 可能返回 null；memory.update 对 metadata 是整包替换
            // （memory.ts:364），传 null 会清空 metadata。null 时改为不传（0.2.0 审查 m2）。
            if (args.metadata !== undefined) patch.metadata = asRecord(args.metadata) ?? undefined;
          }
          const record = await params.memory.update(id, patch);
          if (record) {
            params.events?.emit({
              type: "memory_updated",
              context: scopeContextOf(scope),
              data: { recordId: id, kind: record.kind },
            });
          }
          return { record, updated: record !== null };
        }
        if (action === "delete") {
          const id = expectString(args.id, "id");
          const scope = requireDestructiveScope(args, params.defaultScopes);
          const existing = await params.memory.get(id);
          if (!existing || !sameScope(existing.scope, scope)) {
            return { deleted: false };
          }
          const deleted = await params.memory.forget(id);
          if (deleted) {
            params.events?.emit({
              type: "memory_deleted",
              context: scopeContextOf(scope),
              data: { recordId: id },
            });
          }
          return { deleted };
        }
        if (action === "attribute") {
          const scope = requireScope(args, params.defaultScopes);
          // Attribute "actually used" to recalled palace records: importance
          // += 0.05 capped. Called after a recalled memory genuinely guided work.
          const recordIds = Array.isArray(args.recordIds)
            ? args.recordIds.filter((v): v is string => typeof v === "string").slice(0, 20)
            : [];
          const boosted: { id: string; importance: number }[] = [];
          if (recordIds.length > 0) {
            for (const id of recordIds) {
              const record = await params.memory.get(id);
              if (!record) continue;
              const next = Math.min(record.importance + 0.05, 0.95);
              if (next > record.importance) {
                await params.memory.update(id, { importance: next });
                boosted.push({ id, importance: Number(next.toFixed(2)) });
              }
            }
          }
          const response = optionalString(args.response) ?? "";
          return {
            result: {
              boostedRecords: boosted,
              experienceAttribution: response
                ? await params.memory.maintenance.attributeExperience({
                    scope,
                    response,
                    outcome: (optionalString(args.outcome) as "positive" | "neutral" | "negative" | undefined) ?? "neutral",
                  })
                : { activatedEntries: [], outcome: optionalString(args.outcome) ?? "neutral" },
            },
          };
        }
        throw new Error("action must be update, delete, attribute, or pin");
      },
    },
  ];
}

export function createMemoryMcpHandler(params: {
  memory: LeafMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
  onMemoryChanged?: () => Promise<void>;
  events?: InspectEventStore;
}) {
  const tools = createMemoryToolSet(params);
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    async handleRequest(payload: unknown) {
      const request = asRecord(payload);
      if (!request) {
        return rpcError(null, -32600, "Invalid Request");
      }
      const id = normalizeId(request.id);
      const method = typeof request.method === "string" ? request.method : "";

      if (method === "initialize") {
        const paramsRecord = asRecord(request.params);
        const requestedVersion = typeof paramsRecord?.protocolVersion === "string"
          ? paramsRecord.protocolVersion
          : "";
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
          requestedVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
        )
          ? requestedVersion
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          serverInfo: { name: "leafmem", version: PACKAGE_VERSION },
          capabilities: { tools: {} },
          instructions: SERVER_INSTRUCTIONS,
        });
      }

      if (method === "notifications/initialized") {
        // Acknowledge but no response needed for notifications
        return undefined;
      }

      if (method === "ping") {
        return rpcResult(id, {});
      }

      if (method === "tools/list") {
        return rpcResult(id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
      }

      if (method === "tools/call") {
        const paramsRecord = asRecord(request.params);
        const name = typeof paramsRecord?.name === "string" ? paramsRecord.name : "";
        const args = asRecord(paramsRecord?.arguments) ?? {};
        const tool = toolMap.get(name);
        if (!tool) {
          return rpcError(id, -32601, `Unknown tool: ${name}`);
        }
        try {
          const result = await tool.execute(args);
          if (tool.mutatesMemory) {
            await params.onMemoryChanged?.();
          }
          const output = compactToolResult(name, result, args);
          return rpcResult(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(output, null, 2),
              },
            ],
            isError: false,
          });
        } catch (error) {
          return rpcError(id, -32602, error instanceof Error ? error.message : String(error));
        }
      }

      return rpcError(id, -32601, `Unknown method: ${method}`);
    },
  };
}

function compactToolResult(name: string, result: unknown, args?: Record<string, unknown>): unknown {
  // Only the recall action returns prompt-ready context; its hits are trimmed
  // (content omitted) because the injected context already carries the content.
  // search/get/list/task_window/active_get return full records.
  if (name !== "memory_recall" || asRecord(args)?.action !== "recall") {
    return result;
  }
  const recall = asRecord(result);
  if (!recall) {
    return result;
  }
  return compactRecord({
    ...recall,
    hits: Array.isArray(recall.hits)
      ? recall.hits.map((hit) => compactSearchHit(hit))
      : undefined,
    evidence: Array.isArray(recall.evidence)
      ? recall.evidence.map((evidence) => compactEvidence(evidence))
      : undefined,
  });
}

function compactSearchHit(value: unknown): unknown {
  const hit = asRecord(value);
  if (!hit) {
    return value;
  }
  const record = asRecord(hit.record);
  return compactRecord({
    ...hit,
    record: record
      ? compactRecord({
          id: record.id,
          scope: record.scope,
          kind: record.kind,
          summary: record.summary,
          source: record.source,
          tags: record.tags,
          metadata: compactMetadata(record.metadata),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
      : undefined,
    evidence: Array.isArray(hit.evidence)
      ? hit.evidence.map((evidence) => compactEvidence(evidence))
      : compactEvidence(hit.evidence),
  });
}

function compactEvidence(value: unknown): unknown {
  const evidence = asRecord(value);
  if (!evidence) {
    return value;
  }
  return compactRecord({
    ...evidence,
    metadata: compactMetadata(evidence.metadata),
  });
}

function compactMetadata(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  const json = JSON.stringify(value);
  if (json.length <= 1_000) {
    return value;
  }
  const metadata = asRecord(value);
  if (!metadata) {
    return { truncated: true };
  }
  return compactRecord({
    sessionId: metadata.sessionId,
    taskId: metadata.taskId,
    cwd: metadata.cwd,
    timestamp: metadata.timestamp,
    lastImportedAt: metadata.lastImportedAt,
    lastCommittedAt: metadata.lastCommittedAt,
    truncated: true,
  });
}

type SessionCommitEntry = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  summary?: string;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
};

type SessionCommitDurableMemory = {
  scope?: MemoryScope;
  kind: string;
  content: string;
  summary?: string;
  confidence?: number;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

type ActiveDocumentKind = "context" | "experience";

async function writeActiveDocument(input: {
  memory: LeafMem;
  kind: ActiveDocumentKind;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  maxChars: number;
}) {
  const current = await input.memory.active.read(input.kind, input.scope);
  return await input.memory.active.write({
    kind: input.kind,
    scope: input.scope,
    content: clampText(input.content, input.maxChars),
    metadata: compactRecord({
      ...(asRecord(current?.metadata) ?? {}),
      ...input.metadata,
    }),
  });
}

async function buildMaintenanceRequestIfDue(
  memory: LeafMem,
  scope: MemoryScope,
  nowIso: string,
) {
  const [context, experience] = await Promise.all([
    memory.active.read("context", scope),
    memory.active.read("experience", scope),
  ]);
  if (!isMaintenanceDue([context?.metadata, experience?.metadata], nowIso)) {
    return undefined;
  }
  return await buildMaintenanceRequest(memory, scope, nowIso);
}

async function buildMaintenanceRequest(
  memory: LeafMem,
  scope: MemoryScope,
  nowIso: string,
) {
  const [context, experience, records] = await Promise.all([
    memory.active.read("context", scope),
    memory.active.read("experience", scope),
    memory.list({ scopes: [scope], limit: 12 }),
  ]);
  return {
    kind: "active_memory_maintenance",
    scope,
    generatedAt: nowIso,
    intervalHours: 24,
    active: { context, experience },
    palaceRecords: records.map((record) => ({
      id: record.id,
      kind: record.kind,
      content: clampText(record.content, 700),
      summary: record.summary,
      source: record.source,
      tags: record.tags,
      metadata: record.metadata,
      updatedAt: record.updatedAt,
    })),
    instructions: [
      "Use the host LLM to lightly deduplicate, decay stale details, and correct active memory against durable palace records.",
      "Keep activeContext compact and current; keep activeExperience as reusable lessons only.",
      "Return memory_organize with action='apply', activeContext, activeExperience, and a short governanceReport.",
    ],
  };
}

function isMaintenanceDue(metadataList: Array<unknown>, nowIso: string): boolean {
  const now = Date.parse(nowIso);
  const lastDeepAt = metadataList
    .map((metadata) => optionalString(asRecord(metadata)?.lastDeepGovernedAt))
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0];
  return lastDeepAt === undefined || now - lastDeepAt >= MAINTENANCE_INTERVAL_MS;
}

async function findSessionMemoryRecord(
  memory: LeafMem,
  scope: MemoryScope,
  sessionId: string,
  taskId: string,
): Promise<MemoryRecord | null> {
  const records = await memory.list({ scopes: [scope] });
  return (
    records.find((record) => {
      const metadata = asRecord(record.metadata) ?? {};
      return (
        optionalString(metadata.sessionId) === sessionId &&
        optionalString(metadata.taskId) === taskId &&
        (record.tags.includes("session") || record.source.includes("_session_"))
      );
    }) ?? null
  );
}

function parseSessionCommitEntries(value: unknown): SessionCommitEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("entries must be an array");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      throw new Error(`entries[${index}] must be an object`);
    }
    const role = expectString(record.role, `entries[${index}].role`);
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
      throw new Error(`entries[${index}].role must be user, assistant, system, or tool`);
    }
    return {
      role,
      content: expectString(record.content, `entries[${index}].content`),
      summary: optionalString(record.summary),
      tokenCount: expectNumber(record.tokenCount),
      metadata: asRecord(record.metadata) ?? undefined,
    };
  });
}

function parseDurableMemories(value: unknown): SessionCommitDurableMemory[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("durableMemories must be an array");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      throw new Error(`durableMemories[${index}] must be an object`);
    }
    const scopeType = optionalString(record.scopeType);
    const scopeId = optionalString(record.scopeId);
    const scope = scopeType || scopeId
      ? {
          type: parseMemoryScopeType(
            expectString(record.scopeType, `durableMemories[${index}].scopeType`),
            `durableMemories[${index}].scopeType`,
          ),
          id: expectString(record.scopeId, `durableMemories[${index}].scopeId`),
        }
      : undefined;
    return {
      scope,
      kind: optionalString(record.kind) ?? "note",
      content: expectString(record.content, `durableMemories[${index}].content`),
      summary: optionalString(record.summary),
      confidence: expectNumber(record.confidence),
      importance: expectNumber(record.importance),
      source: optionalString(record.source),
      tags: Array.isArray(record.tags)
        ? record.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
        : undefined,
      metadata: asRecord(record.metadata) ?? undefined,
    };
  });
}

function buildSessionCommitContent(input: {
  agent: string;
  sessionId: string;
  taskId: string;
  cwd?: string;
  timestamp?: string;
  rollingSummary: string;
}): string {
  return [
    `${input.agent} session: ${input.sessionId}`,
    input.timestamp ? `Started: ${input.timestamp}` : "",
    input.cwd ? `Working directory: ${input.cwd}` : "",
    `Task id: ${input.taskId}`,
    "",
    "Session summary:",
    input.rollingSummary,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars).trimEnd();
}

function requireScope(args: Record<string, unknown>, fallback?: MemoryScope[]): MemoryScope {
  const scope = parseScopeArgs(args, fallback)?.[0];
  if (!scope) {
    throw new Error("scopeType and scopeId are required when no default scope is configured");
  }
  return scope;
}

function requireDestructiveScope(args: Record<string, unknown>, fallback?: MemoryScope[]): MemoryScope {
  const requested = parseReadScopeArgs(args)?.[0];
  const defaultScope = fallback?.[0];
  if (defaultScope && requested && !sameScope(requested, defaultScope)) {
    throw new Error("scopeType and scopeId must match the configured default scope");
  }
  const scope = requested ?? defaultScope;
  if (!scope) {
    throw new Error("scopeType and scopeId are required for update/delete when no default scope is configured");
  }
  return scope;
}

function parseScopeArgs(
  args: Record<string, unknown>,
  fallback?: MemoryScope[],
): MemoryScope[] | undefined {
  return parseReadScopeArgs(args) ?? fallback;
}

function parseReadScopeArgs(args: Record<string, unknown>): MemoryScope[] | undefined {
  const scopeType = optionalString(args.scopeType);
  const scopeId = optionalString(args.scopeId);
  if (!scopeType && !scopeId) {
    return undefined;
  }
  if (!scopeType || !scopeId) {
    throw new Error("scopeType and scopeId must be provided together");
  }
  return [{ type: parseMemoryScopeType(scopeType), id: scopeId }];
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.type === right.type && left.id === right.id;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expectNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }
  return null;
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

// ---------------------------------------------------------------------------
// Inspect event helpers (2026-08-08: durable audit trail for the console)
// ---------------------------------------------------------------------------

function scopeContextOf(scope: { type: string; id: string }) {
  // Events are an audit/display trail; projectId is a fixed local placeholder.
  return scope.type === "agent" ? { projectId: "local", agentId: scope.id } : { projectId: "local" };
}

function truncForEvent(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
