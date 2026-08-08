import type { LeafMem } from "../core/memory.js";
import { parseProfileSections } from "../core/memory.js";
import type { MemoryInput, MemoryRecallResult, MemoryRecord } from "../core/types.js";
import type { MemoryCaptureResult, MemoryProposalExtractor, MemoryRuntime } from "../runtime/types.js";
import { createMemoryRuntime, inferMemoryProposals } from "../runtime/runtime.js";
import type { InspectEventStore } from "../inspect/types.js";
import type { PlanGate } from "../cloud/gate.js";
import type { UsageMeter } from "../cloud/usage.js";
import type { CloudSyncManager } from "../cloud/sync.js";
import type { Plan } from "../cloud/types.js";
import {
  resolveContextScopes,
  canonicalTaskId,
  filterScopesByTargets,
  recordBelongsToProject,
} from "./context.js";
import type {
  CaptureTurnInput,
  ListMemoriesInput,
  MemoryContext,
  MemoryRecordRef,
  PlatformMemoryService,
  RecallInput,
  RecallInspection,
  ResolvedScopes,
  UpdateMemoryInput,
  WriteMemoryInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export type LeafMemPlatformServiceOptions = {
  memory: LeafMem;
  events?: InspectEventStore;
  /** Cloud infrastructure (optional, required for Pro/Team features) */
  cloud?: {
    gate: PlanGate;
    usage: UsageMeter;
    sync?: CloudSyncManager;
    /** Resolve project plan. Defaults to 'free'. */
    getPlan?: (projectId: string) => Promise<Plan>;
  };
  proposalExtractor?: MemoryProposalExtractor;
};

export class LeafMemPlatformService implements PlatformMemoryService {
  private readonly memory: LeafMem;
  private readonly events?: InspectEventStore;
  private readonly cloud?: LeafMemPlatformServiceOptions["cloud"];
  private readonly proposalExtractor?: MemoryProposalExtractor;

  constructor(options: LeafMemPlatformServiceOptions) {
    this.memory = options.memory;
    this.events = options.events;
    this.cloud = options.cloud;
    this.proposalExtractor = options.proposalExtractor;
  }

  // -----------------------------------------------------------------------
  // Cloud helpers
  // -----------------------------------------------------------------------

  private async getProjectPlan(projectId: string): Promise<Plan> {
    return this.cloud?.getPlan
      ? this.cloud.getPlan(projectId)
      : "free";
  }

  private async guardWrite(projectId: string): Promise<void> {
    if (!this.cloud) return;
    const plan = await this.getProjectPlan(projectId);
    await this.cloud.gate.assert(projectId, plan, "write_memory");
  }

  private async trackWrite(projectId: string): Promise<void> {
    if (!this.cloud) return;
    await this.cloud.usage.increment(projectId, "memoriesWritten");
  }

  // -----------------------------------------------------------------------
  // Scope resolution
  // -----------------------------------------------------------------------

  resolveContextScopes(context: MemoryContext): ResolvedScopes {
    return resolveContextScopes(context);
  }

  // -----------------------------------------------------------------------
  // Turn lifecycle
  // -----------------------------------------------------------------------

  async captureTurn(input: CaptureTurnInput): Promise<MemoryCaptureResult> {
    const resolvedScopes = resolveContextScopes(input.context);
    const { writeScope, recallScopes } = resolvedScopes;
    const taskKey = canonicalTaskId(input.context);
    const taskScope = recallScopes.find((scope) => scope.type === "task");
    const userScope = recallScopes.find((scope) => scope.type === "user");
    const lifecycleScopes = [writeScope, ...recallScopes.filter((scope) => !sameScope(scope, writeScope))];
    const rawProposals = this.proposalExtractor
      ? await this.proposalExtractor.extract({
          userMessage: input.userMessage,
          assistantMessage: input.assistantMessage,
          recentMessages: input.recentMessages,
          scopes: lifecycleScopes,
          taskId: taskKey,
          taskTitle: input.taskTitle,
          toolContext: input.toolContext,
        })
      : inferMemoryProposals({
          userMessage: input.userMessage,
          assistantMessage: input.assistantMessage,
          recentMessages: input.recentMessages,
          scopes: lifecycleScopes,
          taskId: taskKey,
          taskTitle: input.taskTitle,
          toolContext: input.toolContext,
        });
    const proposals = rawProposals.map((proposal) => ({
      ...proposal,
      metadata: { ...(proposal.metadata ?? {}), projectId: input.context.projectId },
      scopes: [
        selectDurableScopeForProposal(proposal.kind, {
          writeScope,
          taskScope,
          userScope,
        }),
      ],
    }));

    const runtime = this.buildRuntime(lifecycleScopes);
    const result = await runtime.captureTurn({
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      recentMessages: input.recentMessages,
      scopes: lifecycleScopes,
      proposals,
      taskId: taskKey,
      taskTitle: input.taskTitle,
      toolContext: input.toolContext,
    });

    if (this.events && result.stored.length > 0) {
      for (const record of result.stored) {
        this.events.emit({
          type: "memory_written",
          context: input.context,
          data: { recordId: record.id, kind: record.kind },
        });
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Recall
  // -----------------------------------------------------------------------

  async buildRecall(input: RecallInput): Promise<MemoryRecallResult> {
    const { recallScopes } = resolveContextScopes(input.context);
    const taskKey = canonicalTaskId(input.context);

    const runtime = this.buildRuntime(recallScopes);
    const result = await runtime.buildRecallContext({
      userMessage: input.message,
      recentMessages: input.recentMessages,
      scopes: recallScopes,
      maxChars: input.maxChars,
      taskId: taskKey,
      toolContext: input.toolContext,
    });

    if (this.events) {
      this.events.emit({
        type: "recall_built",
        context: input.context,
        data: {
          query: input.message,
          hitCount: result.hits.length,
          contextLength: result.injectedContext.length,
        },
      });
    }

    return result;
  }

  async inspectRecall(input: RecallInput): Promise<RecallInspection> {
    const result = await this.buildRecall(input);
    return {
      context: input.context,
      message: input.message,
      injectedContext: result.injectedContext,
      stableContext: result.stableContext,
      dynamicContext: result.dynamicContext,
      navigationContext: result.navigationContext,
      layers: result.layers,
      hits: result.hits,
    };
  }

  // -----------------------------------------------------------------------
  // Memory CRUD
  // -----------------------------------------------------------------------

  async writeMemory(input: WriteMemoryInput): Promise<MemoryRecord> {
    const { writeScope } = resolveContextScopes(input.context);

    // Cloud: check write quota before proceeding
    const projectId = input.context.projectId ?? "default";
    await this.guardWrite(projectId);

    const memoryInput: MemoryInput = {
      scope: writeScope,
      kind: input.kind,
      content: input.content,
      summary: input.summary,
      confidence: input.confidence,
      importance: input.importance,
      source: input.source,
      tags: input.tags,
      metadata: { ...(input.metadata ?? {}), projectId },
    };

    const record = await this.memory.remember(memoryInput);

    // Cloud: track usage + async sync push
    await this.trackWrite(projectId);
    this.cloud?.sync?.push(projectId).catch(() => {/* best effort */});

    if (this.events) {
      this.events.emit({
        type: "memory_written",
        context: input.context,
        data: { recordId: record.id, kind: record.kind },
      });
    }

    return record;
  }

  async listMemories(input: ListMemoriesInput): Promise<MemoryRecord[]> {
    const scopes = filterScopesByTargets(input.context, input.scopeTargets);

    let records = await this.memory.list({
      scopes,
    });

    // Filter by kind if specified
    if (input.kinds && input.kinds.length > 0) {
      const kindSet = new Set(input.kinds);
      records = records.filter((record) => kindSet.has(record.kind));
    }

    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map((tag) => tag.toLowerCase()));
      records = records.filter((record) => record.tags.some((tag) => tagSet.has(tag.toLowerCase())));
    }

    if (input.metadata && Object.keys(input.metadata).length > 0) {
      records = records.filter((record) =>
        Object.entries(input.metadata!).every(([key, value]) => record.metadata?.[key] === value),
      );
    }

    // Simple cursor-based pagination: cursor is the last-seen record id.
    // Skip records until we pass the cursor id, then return `limit` records.
    if (input.cursor) {
      const cursorIndex = records.findIndex((r) => r.id === input.cursor);
      if (cursorIndex >= 0) {
        records = records.slice(cursorIndex + 1);
      }
    }

    if (input.limit && input.limit > 0) {
      records = records.slice(0, input.limit);
    }

    return records;
  }

  async getMemory(input: MemoryRecordRef): Promise<MemoryRecord | null> {
    const record = await this.memory.get(input.id);
    if (!record) {
      return null;
    }

    // Project isolation: verify the record belongs to this project context
    if (!recordBelongsToProject(record, input.context)) {
      return null;
    }

    return record;
  }

  async updateMemory(input: {
    ref: MemoryRecordRef;
    patch: UpdateMemoryInput;
  }): Promise<MemoryRecord | null> {
    // Project isolation check
    const existing = await this.getMemory(input.ref);
    if (!existing) {
      return null;
    }

    const result = await this.memory.update(input.ref.id, {
      kind: input.patch.kind,
      content: input.patch.content,
      summary: input.patch.summary,
      confidence: input.patch.confidence,
      importance: input.patch.importance,
      source: input.patch.source,
      tags: input.patch.tags,
      metadata: input.patch.metadata,
    });

    if (this.events && result) {
      this.events.emit({
        type: "memory_updated",
        context: input.ref.context,
        data: { recordId: input.ref.id },
      });
    }

    return result;
  }

  async deleteMemory(input: MemoryRecordRef): Promise<boolean> {
    // Project isolation check
    const existing = await this.getMemory(input);
    if (!existing) {
      return false;
    }

    const deleted = await this.memory.forget(input.id);

    if (this.events && deleted) {
      this.events.emit({
        type: "memory_deleted",
        context: input.context,
        data: { recordId: input.id },
      });
    }

    return deleted;
  }

  // -----------------------------------------------------------------------
  // Governance snapshot (Console Plan-A, 2026-08-07)
  // -----------------------------------------------------------------------

  /**
   * Custom: read-only snapshot of the P0/P1 enhancement outputs.
   * Reads only; never writes. Fail-safe: entity stats degrade to zero.
   */
  async getGovernanceSnapshot(input: { context: MemoryContext }): Promise<import("./types.js").GovernanceSnapshot> {
    const scopes = resolveContextScopes(input.context).recallScopes;
    const allRecords = await this.memory.list({ scopes });

    // --- Profile (P1-3 delta-ops document, active kind=profile) ---
    const profile: import("./types.js").GovernanceSnapshot["profile"] = {
      present: false,
      preamble: "",
      sections: [],
    };
    for (const scope of scopes) {
      try {
        const doc = await this.memory.active.read("profile", scope);
        if (doc && doc.content.trim()) {
          const parsed = parseProfileSections(doc.content);
          profile.present = true;
          profile.updatedAt = doc.updatedAt;
          profile.preamble = parsed.preamble;
          profile.sections = parsed.sections.map((s) => ({ title: s.title, content: s.body.replace(/\n+$/, "") }));
          break;
        }
      } catch {
        // Missing profile for this scope is fine — try the next one.
      }
    }

    // --- Principles (P1-1 distilled memories) ---
    const principles: import("./types.js").PrincipleView[] = allRecords
      .filter((r) => r.kind === "principle")
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => ({
        id: r.id,
        summary: r.summary ?? r.content.slice(0, 160),
        tags: [...r.tags],
        importance: r.importance,
        supportsCount: Array.isArray(r.metadata?.supports) ? (r.metadata!.supports as unknown[]).length : 0,
        lastRefreshedAt: typeof r.metadata?.lastRefreshedAt === "string" ? (r.metadata.lastRefreshedAt as string) : undefined,
      }));

    // --- Recall usage (P0-2 recall_count feedback) ---
    let totalRecallCount = 0;
    for (const r of allRecords) {
      const rc = typeof r.metadata?.recallCount === "number" ? (r.metadata.recallCount as number) : 0;
      totalRecallCount += rc;
    }
    const recallHot: import("./types.js").RecallHotItem[] = allRecords
      .map((r) => ({ r, rc: typeof r.metadata?.recallCount === "number" ? (r.metadata.recallCount as number) : 0 }))
      .filter((x) => x.rc > 0)
      .toSorted((a, b) => b.rc - a.rc)
      .slice(0, 10)
      .map((x) => ({
        id: x.r.id,
        kind: x.r.kind,
        recallCount: x.rc,
        lastRecalledAt: typeof x.r.metadata?.lastRecalledAt === "string" ? (x.r.metadata.lastRecalledAt as string) : undefined,
        summary: x.r.summary ?? x.r.content.slice(0, 120),
      }));

    // --- Entity stats (P0-1 wiring) ---
    let entityCount = 0;
    let entityLinkCount = 0;
    if (this.memory.entityStore) {
      try {
        const stats = await this.memory.entityStore.getEntityStats();
        entityCount = stats.entityCount;
        entityLinkCount = stats.totalLinks;
      } catch {
        // Entity stats are best-effort only.
      }
    }

    return {
      profile,
      principles,
      stats: {
        principleCount: principles.length,
        totalRecallCount,
        entityCount,
        entityLinkCount,
      },
      recallHot,
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private buildRuntime(scopes: import("../core/types.js").MemoryScope[]): MemoryRuntime {
    return createMemoryRuntime({
      memory: this.memory,
      defaultScopes: scopes,
    });
  }
}

function selectDurableScopeForProposal(
  kind: string,
  scopes: {
    writeScope: import("../core/types.js").MemoryScope;
    taskScope?: import("../core/types.js").MemoryScope;
    userScope?: import("../core/types.js").MemoryScope;
  },
): import("../core/types.js").MemoryScope {
  if ((kind === "preference" || kind === "identity") && scopes.userScope) {
    return scopes.userScope;
  }
  if (kind === "decision" && scopes.taskScope) {
    return scopes.taskScope;
  }
  return scopes.writeScope;
}

function sameScope(
  left: import("../core/types.js").MemoryScope,
  right: import("../core/types.js").MemoryScope,
): boolean {
  return left.type === right.type && left.id === right.id;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlatformService(
  options: LeafMemPlatformServiceOptions,
): PlatformMemoryService {
  return new LeafMemPlatformService(options);
}
