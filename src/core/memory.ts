import { randomUUID } from "node:crypto";
import { ActiveMemoryManager } from "../active/manager.js";
import { InMemoryActiveMemoryStore, SqliteActiveMemoryStore } from "../active/store.js";
import type { EntityExtractor, EntityStore } from "../entity/types.js";
import { MaintenanceManager } from "../maintenance/manager.js";
import { RetrievalManager } from "../retrieval/manager.js";
import type { VectorStore } from "../retrieval/vector-store.js";
import { openSqliteDatabase } from "../system/sqlite.js";
import { TaskContextManager } from "../task/manager.js";
import { InMemoryTaskContextStore, SqliteTaskContextStore } from "../task/store.js";
import type { MemoryInferencer, MemoryStorageBackend } from "../system/types.js";
import { cosineSimilarity, embedTextHash } from "./hash-embedding.js";
import type { MemoryEvaluator } from "./evaluator.js";
import { InMemoryStore, SqliteMemoryStore } from "./storage.js";
import {
  normalizeScope,
  scopeKey,
  type MemoryInput,
  type MemoryEvidenceRef,
  type MemoryListOptions,
  type MemoryRecallOptions,
  type MemoryRecallResult,
  type MemoryRecord,
  type MemorySearchHit,
  type MemorySearchOptions,
  type MemoryScope,
  type MemoryStore,
} from "./types.js";
import { normalizeText, tokenOverlapScore, uniqueTokens } from "./tokenize.js";

export type SearchWeights = {
  lexical: number;
  hash: number;
  recency: number;
  importance: number;
  scope: number;
};

const DEFAULT_SEARCH_WEIGHTS: SearchWeights = {
  lexical: 0.45,
  hash: 0.35,
  recency: 0.08,
  importance: 0.07,
  scope: 0.05,
};

const ENTITY_MATCH_BOOST = 0.18;
/** Custom (P0-3): FTS5 BM25 lexical-match boost, injected like entity boost. */
const FTS_MATCH_BOOST = 0.22;
/** Custom (P0-3): IDF denominator — entities with this many links get half
 * the full boost (e.g. K=40: 0 links≈1.0, 40 links→0.5, 181 links→0.18). */
const ENTITY_IDF_K = 40;
/** Custom (P1-importance): distilled kind=principle memories are surfaced
 * higher in recall so curated top-level guidance beats raw fragments. */
const PRINCIPLE_BOOST = 0.1;

export type LeafMemOptions = {
  storage?: {
    backend?: MemoryStorageBackend;
    path?: string;
  };
  storagePath?: string;
  store?: MemoryStore;
  idFactory?: () => string;
  now?: () => Date;
  inferencer?: MemoryInferencer;
  retrieval?: {
    backend?: "builtin" | "qmd";
    vectorStore?: VectorStore;
    embeddings?: {
      provider: "openai" | "gemini" | "voyage" | "script" | "auto";
      model?: string;
      dimensions?: number;
      fallback?: "openai" | "gemini" | "voyage" | "script" | "none";
      remote?: {
        apiKey?: string;
        baseUrl?: string;
        headers?: Record<string, string>;
      };
    };
    qmd?: {
      enabled?: boolean;
      command?: string;
      collections?: Array<{
        name: string;
        path: string;
        pattern?: string;
        kind?: "memory" | "sessions";
      }>;
      includeDefaultMemory?: boolean;
      maxResults?: number;
      maxSnippetChars?: number;
      maxInjectedChars?: number;
      timeoutMs?: number;
    };
  };
  active?: {
    contextMaxChars?: number;
    experienceMaxChars?: number;
  };
  task?: {
    recentEntriesLimit?: number;
    windowMaxChars?: number;
    summaryMaxChars?: number;
  };
  embeddingDimensions?: number;
  /** Similarity threshold (0-1) above which a new remember() merges into an existing record instead of creating a new one. Set to 1 to disable. Default 0.85. */
  dedupeThreshold?: number;
  /** Pluggable memory evaluator for conflict resolution. When set, used instead of dedupeThreshold. */
  evaluator?: MemoryEvaluator;
  /** Optional entity store for lightweight entity linking. */
  entityStore?: EntityStore;
  /** Optional entity extractor. Requires entityStore to persist links. */
  entityExtractor?: EntityExtractor;
  /** Override the default search scoring weights. */
  searchWeights?: Partial<SearchWeights>;
};

export class LeafMem {
  private readonly store: MemoryStore;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly embeddingDimensions: number;
  private readonly dedupeThreshold: number;
  private readonly evaluator: MemoryEvaluator | null;
  private readonly weights: SearchWeights;
  /** Custom (P1-1): inferencer kept for principle reflection (reflect()). */
  private readonly inferencer: MemoryInferencer | null;
  /** Custom (P0-3): sqlite path for FTS5 boost queries; null for memory backend. */
  private readonly sqlitePath: string | null;
  readonly active: ActiveMemoryManager;
  readonly task: TaskContextManager;
  readonly retrieval: RetrievalManager;
  readonly maintenance: MaintenanceManager;
  readonly entityStore: EntityStore | null;
  readonly entityExtractor: EntityExtractor | null;

  /** Serialize mutating operations to prevent read-modify-write races. */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  /** Dedup window for recall counting (custom P0-2, 2026-08-07). */
  private readonly recentRecallCounts = new Map<string, number>();

  constructor(options: LeafMemOptions = {}) {
    const storageBackend = resolveStorageBackend(options);
    const storagePath = options.storage?.path ?? options.storagePath ?? ".leafmem/memory.sqlite";
    const sqlitePath = deriveSqlitePath(storagePath);
    this.store = options.store ?? createDefaultStore(storageBackend, storagePath);
    // Custom (P0-3): remember the sqlite path for FTS5 boost queries.
    // Null when the backend is in-memory (no FTS table exists there).
    // The FTS query itself is fail-safe (returns empty on any error).
    this.sqlitePath = storageBackend === "sqlite" ? sqlitePath : null;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
    this.embeddingDimensions = options.embeddingDimensions ?? 128;
    this.dedupeThreshold = clamp(options.dedupeThreshold ?? 0.85, 0, 1);
    this.evaluator = options.evaluator ?? null;
    this.weights = { ...DEFAULT_SEARCH_WEIGHTS, ...options.searchWeights };
    this.inferencer = options.inferencer ?? null;
    this.entityStore = options.entityStore ?? null;
    this.entityExtractor = options.entityExtractor ?? null;
    this.active = new ActiveMemoryManager({
      store:
        storageBackend === "memory" || options.store instanceof InMemoryStore
          ? new InMemoryActiveMemoryStore()
          : new SqliteActiveMemoryStore(sqlitePath),
      inferencer: options.inferencer,
      now: this.now,
      contextMaxChars: options.active?.contextMaxChars,
      experienceMaxChars: options.active?.experienceMaxChars,
    });
    this.task = new TaskContextManager({
      store:
        storageBackend === "memory" || options.store instanceof InMemoryStore
          ? new InMemoryTaskContextStore()
          : new SqliteTaskContextStore(sqlitePath),
      inferencer: options.inferencer,
      now: this.now,
      recentEntriesLimit: options.task?.recentEntriesLimit,
      windowMaxChars: options.task?.windowMaxChars,
      summaryMaxChars: options.task?.summaryMaxChars,
    });
    this.retrieval = new RetrievalManager({
      memory: this,
      backend: options.retrieval?.backend,
      vectorStore: options.retrieval?.vectorStore,
      embeddings: options.retrieval?.embeddings,
      qmd: options.retrieval?.qmd,
    });
    this.maintenance = new MaintenanceManager({
      active: this.active,
      inferencer: options.inferencer,
      now: this.now,
      memory: this,
    });
  }

  async remember(input: MemoryInput): Promise<MemoryRecord> {
    return this.enqueue(async () => {
      const nowIso = this.now().toISOString();
      const records = await this.store.load();

      // --- Evaluate: use evaluator or fallback to threshold-based dedup ---
      if (this.evaluator || this.dedupeThreshold < 1) {
        const inputText = buildSearchText({
          kind: input.kind,
          content: input.content,
          summary: input.summary,
          tags: input.tags ?? [],
          scope: normalizeScope(input.scope),
        } as MemoryRecord);
        const inputVector = embedTextHash(inputText, this.embeddingDimensions);
        const inputTokens = uniqueTokens(inputText);
        const scopeK = scopeKey(normalizeScope(input.scope));

        // Collect candidates with similarity scores
        const candidates: Array<{ record: MemoryRecord; similarity: number }> = [];
        for (const existing of records) {
          if (scopeKey(existing.scope) !== scopeK) continue;
          if (existing.kind !== input.kind) continue;
          const existingText = buildSearchText(existing);
          const tokenScore = tokenOverlapScore(inputTokens, uniqueTokens(existingText));
          const hashScore = normalizeSimilarity(
            cosineSimilarity(inputVector, embedTextHash(existingText, this.embeddingDimensions)),
          );
          const similarity = tokenScore * 0.5 + hashScore * 0.5;
          const candidateThreshold = this.evaluator ? 0.7 : this.dedupeThreshold * 0.7;
          if (similarity >= candidateThreshold) {
            candidates.push({ record: existing, similarity });
          }
        }

        if (candidates.length > 0) {
          // Sort by similarity descending
          candidates.sort((a, b) => b.similarity - a.similarity);

          if (this.evaluator) {
            // Use evaluator for intelligent conflict resolution
            const decision = await this.evaluator.evaluate({
              incoming: { content: input.content, kind: input.kind, tags: input.tags ?? [] },
              candidates: candidates.map((c) => ({
                id: c.record.id,
                content: c.record.content,
                kind: c.record.kind,
                similarity: c.similarity,
              })),
            });

            if (decision.action === "ignore") {
              const best = candidates[0]!.record;
              applyIncomingMarkers(best, input);
              best.updatedAt = nowIso;
              await this.persistRecord(records, best);
              await this.syncDerivedState(best);
              return { ...best, scope: { ...best.scope }, tags: [...best.tags] };
            }

            if (decision.action === "update") {
              const target = records.find((r) => r.id === decision.targetId);
              if (target) {
                target.content = (decision.merged || input.content).trim();
                target.summary = summarizeContent(target.content);
                target.confidence = clamp(Math.max(target.confidence, input.confidence ?? 0.7), 0.05, 1);
                target.importance = clamp(Math.max(target.importance, input.importance ?? 0.5), 0, 1);
                applyIncomingMarkers(target, input);
                target.updatedAt = nowIso;
                await this.persistRecord(records, target);
                await this.syncDerivedState(target);
                return { ...target, scope: { ...target.scope }, tags: [...target.tags] };
              }
            }

            if (decision.action === "contradict") {
              const target = records.find((r) => r.id === decision.targetId);
              if (target) {
                const previousContent = target.content;
                target.content = (decision.resolution || input.content).trim();
                target.summary = summarizeContent(target.content);
                target.confidence = clamp(input.confidence ?? 0.7, 0.05, 1);
                target.importance = clamp(input.importance ?? 0.5, 0, 1);
                // Custom (P1-2): changelog entry makes the contradiction auditable.
                const changelog = Array.isArray(target.metadata?.changelog)
                  ? [...(target.metadata!.changelog as unknown[])]
                  : [];
                changelog.push({
                  date: nowIso,
                  action: "contradict",
                  reason: "evaluator contradiction; previousContent preserved in metadata",
                });
                target.metadata = {
                  ...target.metadata,
                  contradicted: true,
                  previousContent,
                  changelog,
                };
                applyIncomingMarkers(target, input);
                target.updatedAt = nowIso;
                await this.persistRecord(records, target);
                await this.syncDerivedState(target);
                return { ...target, scope: { ...target.scope }, tags: [...target.tags] };
              }
            }
            // action === "add" falls through to create new record below
          } else {
            // Legacy threshold-based dedup (no evaluator)
            const best = candidates[0]!;
            if (best.similarity >= this.dedupeThreshold) {
              const existing = best.record;
              existing.content = input.content.trim();
              existing.summary = input.summary?.trim() || summarizeContent(input.content);
              existing.confidence = clamp(Math.max(existing.confidence, input.confidence ?? 0.7), 0.05, 1);
              existing.importance = clamp(Math.max(existing.importance, input.importance ?? 0.5), 0, 1);
              applyIncomingMarkers(existing, input);
              existing.updatedAt = nowIso;
              await this.persistRecord(records, existing);
              await this.syncDerivedState(existing);
              return { ...existing, scope: { ...existing.scope }, tags: [...existing.tags] };
            }
          }
        }
      }

      // --- No duplicate found: create new record ---
      const record: MemoryRecord = {
        id: this.idFactory(),
        scope: normalizeScope(input.scope),
        kind: input.kind,
        content: input.content.trim(),
        summary: input.summary?.trim() || summarizeContent(input.content),
        confidence: clamp(input.confidence ?? 0.7, 0.05, 1),
        importance: clamp(input.importance ?? 0.5, 0, 1),
        source: input.source?.trim() || "manual",
        tags: [...new Set((input.tags ?? []).map((tag) => normalizeText(tag)).filter(Boolean))],
        metadata: input.metadata ? { ...input.metadata } : undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      records.push(record);
      await this.persistRecord(records, record);
      await this.syncDerivedState(record);
      return record;
    });
  }

  async update(id: string, patch: Partial<MemoryInput>): Promise<MemoryRecord | null> {
    return this.enqueue(async () => {
      const records = await this.store.load();
      const record = records.find((r) => r.id === id);
      if (!record) return null;

      const nowIso = this.now().toISOString();
      const contentChanged = patch.content !== undefined;
      if (patch.content !== undefined) record.content = patch.content.trim();
      if (patch.summary !== undefined) record.summary = patch.summary?.trim() || summarizeContent(record.content);
      else if (contentChanged) record.summary = summarizeContent(record.content);
      if (patch.confidence !== undefined) record.confidence = clamp(patch.confidence, 0.05, 1);
      if (patch.importance !== undefined) record.importance = clamp(patch.importance, 0, 1);
      if (patch.source !== undefined) record.source = patch.source?.trim() || record.source;
      if (patch.tags !== undefined) {
        record.tags = [...new Set(patch.tags.map((t) => normalizeText(t)).filter(Boolean))];
      }
      if (patch.kind !== undefined) record.kind = patch.kind;
      if (patch.scope !== undefined) record.scope = normalizeScope(patch.scope);
      if (patch.metadata !== undefined) record.metadata = patch.metadata ? { ...patch.metadata } : undefined;
      record.updatedAt = nowIso;

      await this.persistRecord(records, record);
      await this.syncDerivedState(record);
      return { ...record, scope: { ...record.scope }, tags: [...record.tags] };
    });
  }

  async forget(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const records = await this.store.load();
      const index = records.findIndex((r) => r.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      await this.deleteRecord(records, id);
      await this.retrieval.deleteVector(id);
      await this.clearEntityLinks(id);
      return true;
    });
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const records = await this.store.load();
    return records.find((record) => record.id === id) ?? null;
  }

  async list(options: MemoryListOptions = {}): Promise<MemoryRecord[]> {
    const records = await this.store.load();
    const sortBy = options.sortBy ?? "updatedAt";
    const sortField = sortBy === "createdAt" ? "createdAt" : "updatedAt";
    const filtered = records
      .filter((record) => matchesRequestedScopes(record.scope, options.scopes))
      .toSorted((left, right) => right[sortField].localeCompare(left[sortField]));
    const offset = options.offset && options.offset > 0 ? options.offset : 0;
    const sliced = offset > 0 ? filtered.slice(offset) : filtered;
    if (options.limit && options.limit > 0) {
      return sliced.slice(0, options.limit);
    }
    return sliced;
  }

  /**
   * Custom (P1-2, 2026-08-07): decay — lower importance for stale, unused
   * records. Deterministic, never deletes (red line R6: demote not drop).
   *
   * A record is decayed when ALL of the following hold:
   *   - it is NOT pinned (tags contain "pinned")          [guard 1]
   *   - it has NOT been recalled within recallFreshDays    [guard 2]
   *     (recallCount===0 or lastRecalledAt older than the window)
   *   - it has NOT been updated within ageDays (it is stale)
   *   - its importance is above targetImportance (nothing to demote)
   *
   * Decay sets importance to targetImportance (default 0.3) and appends a
   * changelog entry, so the operation is auditable and reversible.
   */
  async decay(options: {
    scopes?: MemoryScope[];
    ageDays?: number;
    recallFreshDays?: number;
    targetImportance?: number;
    dryRun?: boolean;
  } = {}): Promise<{
    scanned: number;
    decayed: { id: string; summary?: string; from: number; to: number }[];
    dryRun: boolean;
  }> {
    const ageDays = options.ageDays ?? 180;
    const recallFreshDays = options.recallFreshDays ?? 90;
    const targetImportance = clamp(options.targetImportance ?? 0.3, 0, 1);
    const dryRun = options.dryRun ?? false;
    const now = this.now();

    const records = await this.store.load();
    const scoped = records.filter((r) => matchesRequestedScopes(r.scope, options.scopes));
    const decayed: { id: string; summary?: string; from: number; to: number }[] = [];

    return this.enqueue(async () => {
      for (const record of scoped) {
        if (record.tags.includes("pinned")) continue; // guard 1: pinned exempt
        const recallCount =
          typeof record.metadata?.recallCount === "number" ? (record.metadata.recallCount as number) : 0;
        const lastRecalledAt = typeof record.metadata?.lastRecalledAt === "string" ? (record.metadata.lastRecalledAt as string) : undefined;
        const recalledRecently =
          lastRecalledAt !== undefined &&
          now.getTime() - Date.parse(lastRecalledAt) < recallFreshDays * 24 * 60 * 60 * 1000;
        if (recallCount > 0 && recalledRecently) continue; // guard 2: recently recalled exempt
        const ageMs = now.getTime() - Date.parse(record.updatedAt);
        if (ageMs < ageDays * 24 * 60 * 60 * 1000) continue; // not stale yet
        if (record.importance <= targetImportance) continue; // already low

        decayed.push({ id: record.id, summary: record.summary, from: record.importance, to: targetImportance });
        if (dryRun) continue;

        record.importance = targetImportance;
        const changelog = Array.isArray(record.metadata?.changelog)
          ? [...(record.metadata!.changelog as unknown[])]
          : [];
        changelog.push({
          date: now.toISOString(),
          action: "decay",
          reason: `stale >${ageDays}d and not recalled within ${recallFreshDays}d`,
          from: decayed[decayed.length - 1]!.from,
          to: targetImportance,
        });
        record.metadata = { ...(record.metadata ?? {}), changelog };
        // Custom (P1-2 hardening, 2026-08-07): intentionally do NOT refresh
        // record.updatedAt. Decay demotes a stale record; touching updatedAt
        // would (a) make it look fresh and boost it via recency — defeating
        // the demotion — and (b) pull it into reflect's recent pool (which
        // filters on updatedAt), risking re-distillation of stale content.
        // The changelog entry's `date` already records when the decay ran.
        await this.persistRecord(records, record);
      }
      return { scanned: scoped.length, decayed, dryRun };
    });
  }

  /**
   * Custom (P1-1, 2026-08-07): principle reflection — periodic distillation.
   *
   * Groups recent lesson/decision memories by primary tag; any cluster with
   * >= clusterSize members is distilled by the inferencer into ONE
   * kind="principle" memory (importance 0.85) that cites the supporting
   * record ids in metadata.supports, so every principle is traceable back to
   * its evidence (stale re-check quality gate).
   *
   * The distillation prompt embeds a consolidation rule (NO COMPUTATION):
   * the LLM must transcribe faithfully and never invent numbers or infer
   * unstated facts.
   *
   * Frequency throttle: last reflect run is stored in active-document
   * metadata (lastReflectAt) with a 6-day default window, so weekly runs
   * proceed but repeated calls within the week are skipped.
   *
   * Returns the created principles (empty if nothing new / throttled /
   * no inferencer). Never throws — any failure is captured per cluster.
   */
  async reflect(options: {
    scopes?: MemoryScope[];
    sinceDays?: number;
    clusterSize?: number;
    maxClusters?: number;
    intervalMs?: number;
    dryRun?: boolean;
  } = {}): Promise<{
    ran: boolean;
    reason?: "no_inferencer" | "fresh" | "no_clusters";
    scanned: number;
    clusters: { tag: string; size: number }[];
    principles: { id: string; summary: string; supports: string[] }[];
  }> {
    const sinceDays = options.sinceDays ?? 14;
    const clusterSize = options.clusterSize ?? 3;
    const maxClusters = options.maxClusters ?? 6;
    const intervalMs = options.intervalMs ?? 6 * 24 * 60 * 60 * 1000;
    const dryRun = options.dryRun ?? false;
    const now = this.now();

    if (!this.inferencer) {
      return { ran: false, reason: "no_inferencer", scanned: 0, clusters: [], principles: [] };
    }

    // Frequency throttle via active-document metadata.
    const scopeForMarker = options.scopes?.[0] ?? { type: "agent", id: "workbuddy" };
    const markerDoc = await this.active.read("context", scopeForMarker);
    const markerMeta = (markerDoc?.metadata ?? {}) as Record<string, unknown>;
    const lastReflectAt = typeof markerMeta.lastReflectAt === "string" ? markerMeta.lastReflectAt : undefined;
    if (lastReflectAt && now.getTime() - Date.parse(lastReflectAt) < intervalMs) {
      return { ran: false, reason: "fresh", scanned: 0, clusters: [], principles: [] };
    }

    const cutoff = now.getTime() - sinceDays * 24 * 60 * 60 * 1000;
    const records = await this.store.load();
    const pool = records.filter(
      (r) =>
        matchesRequestedScopes(r.scope, options.scopes) &&
        (r.kind === "lesson" || r.kind === "decision" || r.kind === "note") &&
        Date.parse(r.updatedAt) >= cutoff &&
        !r.tags.includes("pinned"),
    );

    // Group by primary tag (first non-generic tag).
    const GENERIC_TAGS = new Set(["p0", "p1", "sop", "pinned", "workbuddy", "session"]);
    const byTag = new Map<string, MemoryRecord[]>();
    for (const r of pool) {
      const primary = r.tags.find((t) => !GENERIC_TAGS.has(t.toLowerCase()));
      if (!primary) continue;
      const key = primary.toLowerCase();
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key)!.push(r);
    }
    const clusters = [...byTag.entries()]
      .filter(([, items]) => items.length >= clusterSize)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, maxClusters);

    const clusterInfo = clusters.map(([tag, items]) => ({ tag, size: items.length }));
    if (clusters.length === 0) {
      return { ran: false, reason: "no_clusters", scanned: pool.length, clusters: [], principles: [] };
    }
    if (dryRun) {
      return { ran: true, scanned: pool.length, clusters: clusterInfo, principles: [] };
    }

    const principles: { id: string; summary: string; supports: string[] }[] = [];
    for (const [tag, items] of clusters) {
      try {
        const evidence = items
          .map((r, i) => `[${i + 1}] id=${r.id} kind=${r.kind} (${r.summary ?? r.content.slice(0, 120).replace(/\s+/g, " ")})`)
          .join("\n");
        const system =
          "You are a memory curator. Distill a cluster of related memories into ONE high-level principle. " +
          "Rules: (1) PREFER UPDATE semantics — one well-supported principle beats several siblings; " +
          "(2) one principle tracks one facet only; (3) match by entity/facet not vague topic; " +
          "(4) resolve vague references to full entity names; (5) preserve history — never claim events that are absent from the evidence; " +
          "(6) NO COMPUTATION — transcribe faithfully, never do arithmetic or infer numbers/facts not stated in the evidence; " +
          "(7) keep unrelated topics separate.";
        const prompt =
          `Cluster tag: "${tag}" (${items.length} memories)\n\nEvidence:\n${evidence}\n\n` +
          "Write ONE principle as plain text with this exact shape:\n" +
          "# <one-sentence conclusion, full subject-verb-object, with entity names>\n" +
          "- 场景：<when this applies>\n" +
          "- 内容：<the distilled rule/insight>\n" +
          "- 动作：<what to do next time>\n" +
          "- 时效：长期有效\n" +
          "- 来源：reflect 蒸馏 " + now.toISOString().slice(0, 10) + "，支撑条目 " + items.map((r) => r.id.slice(0, 8)).join(",") + "\n" +
          "Output ONLY the principle text, nothing else.";

        const result = await this.inferencer({
          kind: "experience",
          system,
          prompt,
          maxChars: 1600,
        });
        if (!result.ok || !result.text.trim()) continue;

        const written = await this.remember({
          scope: scopeForMarker,
          kind: "principle",
          content: result.text.trim(),
          importance: 0.85,
          confidence: 0.75,
          source: "phase7-reflect",
          tags: [tag, "principle", "reflected"],
          metadata: {
            supports: items.map((r) => r.id),
            reflectTag: tag,
            reflectedAt: now.toISOString(),
            lastRefreshedAt: now.toISOString(),
          },
        });
        principles.push({ id: written.id, summary: written.summary ?? "", supports: items.map((r) => r.id) });
      } catch {
        // Per-cluster failure must not abort the whole reflection.
      }
    }

    // Mark last reflect time.
    await this.active.write({
      kind: "context",
      scope: scopeForMarker,
      content: markerDoc?.content ?? "",
      metadata: { ...markerMeta, lastReflectAt: now.toISOString() },
    });

    return { ran: true, scanned: pool.length, clusters: clusterInfo, principles };
  }

  /**
   * Custom (P1-3, 2026-08-07): delta-based user profile maintenance.
   *
   * Builds/refreshes a single section-based "profile" active document from
   * the user's high-confidence preference/identity memories. Instead of
   * letting the LLM rewrite the whole document (which drifts), it asks for
   * delta ops (set_section / append_to_section / remove_section) and applies
   * them mechanically — sections the LLM does not mention are copied
   * verbatim, so prose drift is structurally impossible. Parse failure or
   * zero ops => document unchanged ("can only get better or stay the same").
   *
   * Returns { ran, reason?, sectionsBefore, sectionsAfter, applied }.
   */
  async buildProfile(options: {
    scope?: MemoryScope;
    limit?: number;
    dryRun?: boolean;
  } = {}): Promise<{
    ran: boolean;
    reason?: "no_inferencer" | "no_source_memories";
    sectionsBefore: number;
    sectionsAfter: number;
    applied: number;
    content?: string;
  }> {
    const scope = options.scope ?? { type: "agent", id: "workbuddy" };
    const limit = options.limit ?? 40;
    const dryRun = options.dryRun ?? false;

    if (!this.inferencer) {
      return { ran: false, reason: "no_inferencer", sectionsBefore: 0, sectionsAfter: 0, applied: 0 };
    }

    // Gather high-confidence preference/identity memories as the source of truth.
    const records = await this.store.load();
    const sources = records
      .filter(
        (r) =>
          matchesRequestedScopes(r.scope, [scope]) &&
          (r.kind === "preference" || r.kind === "identity") &&
          r.importance >= 0.6,
      )
      .toSorted((a, b) => b.importance - a.importance)
      .slice(0, limit);

    if (sources.length === 0) {
      return { ran: false, reason: "no_source_memories", sectionsBefore: 0, sectionsAfter: 0, applied: 0 };
    }

    const existing = await this.active.read("profile", scope);
    const existingContent = existing?.content ?? "";
    const { preamble, sections } = parseProfileSections(existingContent);

    const sourceDigest = sources
      .map((r, i) => `[${i + 1}] (${r.kind}, imp=${r.importance}) ${(r.summary ?? r.content).replace(/\s+/g, " ").slice(0, 300)}`)
      .join("\n");

    const existingSectionTitles = sections.map((s) => s.title);
    const system =
      "You maintain a user profile as section-based markdown. You may only modify sections by emitting delta operations; " +
      "any section you do not mention stays exactly as-is. Never invent facts not present in the source memories. " +
      "Output ONLY a JSON array of operations.";
    const prompt =
      `Current profile sections: ${existingSectionTitles.length ? existingSectionTitles.join(" | ") : "(none yet)"}\n\n` +
      `Source memories (preference/identity):\n${sourceDigest}\n\n` +
      'Emit a JSON array of operations. Allowed forms:\n' +
      '  {"op":"set_section","section":"<section title>","content":"<new full section body>"}\n' +
      '  {"op":"append_to_section","section":"<section title>","content":"<lines to append>"}\n' +
      '  {"op":"remove_section","section":"<section title>"}\n' +
      "Guidance: use short, stable section titles (e.g. 工作偏好, 文件路径约定, 沟通偏好, 技术环境). " +
      "Consolidate facts about the SAME topic into ONE section. " +
      (existingSectionTitles.length === 0
        ? "The profile is EMPTY: you MUST create sections covering the important facts from the source memories (one set_section op per topic)."
        : "Only output [] if the existing profile already covers everything in the source memories and nothing is outdated.");

    const result = await this.inferencer({
      kind: "experience",
      system,
      prompt,
      maxChars: 3500,
      currentContent: existingContent,
    });

    if (!result.ok) {
      // Inferencer failure => unchanged (fail-safe).
      return { ran: false, reason: "no_inferencer", sectionsBefore: sections.length, sectionsAfter: sections.length, applied: 0, content: existingContent };
    }

    const ops = parseProfileDeltaOps(result.text);
    const nextSections = applyProfileDeltaOps(sections, ops);
    const nextContent = renderProfileSections(preamble, nextSections);

    if (dryRun || ops.length === 0) {
      return {
        ran: true,
        sectionsBefore: sections.length,
        sectionsAfter: nextSections.length,
        applied: ops.length,
        content: nextContent,
      };
    }

    await this.active.write({
      kind: "profile",
      scope,
      content: nextContent,
      metadata: {
        ...(existing?.metadata ?? {}),
        lastProfileRefreshAt: this.now().toISOString(),
        profileSources: sources.map((s) => s.id),
        appliedOps: ops.length,
      },
    });

    return {
      ran: true,
      sectionsBefore: sections.length,
      sectionsAfter: nextSections.length,
      applied: ops.length,
      content: nextContent,
    };
  }

  async search(query: string, options: MemorySearchOptions = {}): Promise<MemorySearchHit[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const queryTokens = uniqueTokens(normalizedQuery);
    const queryVector = embedTextHash(normalizedQuery, this.embeddingDimensions);
    const records = await this.store.load();
    const scopedRecords = records.filter((record) => matchesRequestedScopes(record.scope, options.scopes));
    const entityBoosts = await this.resolveEntityBoosts(normalizedQuery);
    const ftsBoosts = this.ftsBoosts(normalizedQuery, options.scopes);
    const hits: MemorySearchHit[] = [];
    const w = this.weights;

    for (const record of scopedRecords) {
      const candidateText = buildSearchText(record);
      const candidateTokens = uniqueTokens(candidateText);
      const lexical = tokenOverlapScore(queryTokens, candidateTokens);
      const hash = clamp(
        cosineSimilarity(queryVector, embedTextHash(candidateText, this.embeddingDimensions)),
        0,
        1,
      );
      const entity = entityBoosts.get(record.id) ?? 0;
      const fts = ftsBoosts.get(record.id) ?? 0;
      // Custom (P1-importance): distilled principles get a fixed boost so
      // curated top-level guidance outranks raw fragments on relevance ties.
      const principle = record.kind === "principle" ? 1 : 0;
      const recency = computeRecencyBoost(record.updatedAt, this.now());
      const importance = record.importance;
      const scope = resolveScopeWeight(record.scope, options.scopes);
      // Custom (P1-2): records past their metadata.valid_until window and
      // not superseded-into a successor are demoted (they are known-stale).
      const validUntilPenalty = isPastValidUntil(record, this.now()) ? 0.5 : 1.0;
      const score =
        (lexical * w.lexical +
          hash * w.hash +
          recency * w.recency +
          importance * w.importance +
          scope * w.scope +
          entity * ENTITY_MATCH_BOOST +
          fts * FTS_MATCH_BOOST +
          principle * PRINCIPLE_BOOST) *
        validUntilPenalty;
      if (score < (options.minScore ?? 0.18)) {
        continue;
      }
      hits.push({
        record,
        score,
        reasons: { lexical, hash, recency, importance, scope, entity, fts, principle },
        snippet: buildSnippet(record.content, queryTokens),
        evidence: buildEvidenceRef(record),
      });
    }

    return hits
      .toSorted((left, right) => right.score - left.score)
      .slice(0, options.maxResults ?? 8);
  }

  async recall(options: MemoryRecallOptions): Promise<MemoryRecallResult> {
    const query = buildRecallQuery(options.query, options.recentMessages);
    const hits = await this.search(query, options);
    this.recordRecallCounts(hits);
    const graphContext = await this.formatEntityGraphContext(query, hits);
    const navigationContext = formatMemoryNavigation(
      hits.map((hit) => hit.record),
      Math.min(1_200, Math.max(0, options.maxChars ?? 1_200)),
    );
    const dynamicContext = [formatRecallContext(hits, options.maxChars ?? 4_000), graphContext]
      .filter(Boolean)
      .join("\n\n");
    return {
      query,
      hits,
      injectedContext: dynamicContext,
      dynamicContext: dynamicContext || undefined,
      navigationContext: navigationContext || undefined,
      evidence: hits.map((hit) => hit.evidence),
      layers: graphContext || navigationContext
        ? { graph: graphContext || undefined, navigation: navigationContext || undefined }
        : undefined,
    };
  }

  /**
   * Custom (P0-2, 2026-08-07): record recall usage for the top hits.
   * Increments metadata.recallCount / lastRecalledAt on the recall path only
   * (never search(), which is also used for dedupe-candidate collection).
   * Fire-and-forget through the mutation queue: never races with user writes,
   * never blocks or breaks the recall response. 5-minute dedup window per
   * record prevents burst re-counting of the same hit.
   */
  private recordRecallCounts(hits: MemorySearchHit[]): void {
    if (hits.length === 0) return;
    const top = hits.slice(0, 3);
    const now = this.now();
    const nowMs = now.getTime();
    void this.enqueue(async () => {
      try {
        const records = await this.store.load();
        const touched: MemoryRecord[] = [];
        for (const hit of top) {
          const id = hit.record.id;
          const lastCounted = this.recentRecallCounts.get(id) ?? 0;
          if (nowMs - lastCounted < 5 * 60_000) continue;
          this.recentRecallCounts.set(id, nowMs);
          const record = records.find((r) => r.id === id);
          if (!record) continue;
          const prev =
            typeof record.metadata?.recallCount === "number"
              ? (record.metadata.recallCount as number)
              : 0;
          record.metadata = {
            ...(record.metadata ?? {}),
            recallCount: prev + 1,
            lastRecalledAt: now.toISOString(),
          };
          touched.push(record);
        }
        for (const record of touched) {
          await this.persistRecord(records, record);
        }
      } catch {
        // Never let counting break recall.
      }
    }).catch(() => undefined);
  }

  async buildNavigation(options: {
    scopes?: MemoryScope[];
    maxItems?: number;
    maxChars?: number;
  } = {}): Promise<string> {
    const records = await this.list({ scopes: options.scopes });
    const items = records
      .toSorted((left, right) => {
        const importance = right.importance - left.importance;
        return importance !== 0 ? importance : right.updatedAt.localeCompare(left.updatedAt);
      })
      .slice(0, options.maxItems ?? 6);
    return formatMemoryNavigation(items, options.maxChars ?? 1_200);
  }

  /** Enqueue a mutating operation so read-modify-write sequences don't interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.then(() => {}, () => {});
    return next;
  }

  private async persistRecord(records: MemoryRecord[], record: MemoryRecord): Promise<void> {
    if (this.store.upsert) {
      await this.store.upsert(record);
      return;
    }
    await this.store.save(records);
  }

  private async deleteRecord(records: MemoryRecord[], id: string): Promise<void> {
    if (this.store.delete) {
      await this.store.delete(id);
      return;
    }
    await this.store.save(records);
  }

  private async syncDerivedState(record: MemoryRecord): Promise<void> {
    await this.retrieval.indexRecord(record);
    await this.syncEntitiesForRecord(record);
  }

  private async syncEntitiesForRecord(record: MemoryRecord): Promise<void> {
    if (!this.entityStore || !this.entityExtractor) {
      return;
    }

    await this.clearEntityLinks(record.id);
    const text = [record.summary ?? "", record.content].filter(Boolean).join("\n");
    if (!text.trim()) {
      return;
    }

    const extracted = await this.entityExtractor.extract(text);
    const storedEntities = [];
    for (const entity of extracted) {
      const stored = await this.entityStore.upsertEntity({
        name: entity.name,
        aliases: entity.aliases,
        kind: entity.kind,
      });
      storedEntities.push(stored);
      await this.entityStore.link(stored.id, record.id, "mentions");
    }
    for (let i = 0; i < storedEntities.length; i++) {
      for (let j = i + 1; j < storedEntities.length; j++) {
        await this.entityStore.relate({
          sourceEntityId: storedEntities[i]!.id,
          targetEntityId: storedEntities[j]!.id,
          relation: "co_occurs",
          memoryId: record.id,
          confidence: 0.5,
        });
      }
    }
  }

  private async clearEntityLinks(memoryId: string): Promise<void> {
    if (!this.entityStore) {
      return;
    }
    await this.entityStore.clearRelationsForMemory(memoryId);
    const links = await this.entityStore.getLinkedEntities(memoryId);
    for (const link of links) {
      await this.entityStore.unlink(link.entityId, memoryId);
    }
  }

  /**
   * Custom (P0-3, 2026-08-07): entity boosts with inverse-frequency weighting.
   * For each query-matched entity, every linked record gets a boost of
   *   1 / (1 + linkCount / ENTITY_IDF_K)
   * Rare entities (few links) boost strongly; high-cardinality entities
   * (e.g. "weknora" with 181 links) boost weakly, preventing a flood of
   * weakly-related records from crowding out the genuinely relevant ones.
   * Returns map memoryId -> boostMultiplier in (0,1]; capped at 1.0 after
   * accumulating multi-entity boosts. Fail-safe on any store error.
   */
  private async resolveEntityBoosts(query: string): Promise<Map<string, number>> {
    const boosts = new Map<string, number>();
    if (!this.entityStore || !this.entityExtractor) return boosts;
    try {
      const entityIds = await this.resolveEntityIds(query);
      if (entityIds.size === 0) return boosts;
      for (const entityId of entityIds) {
        const links = await this.entityStore.getLinkedMemories(entityId);
        if (links.length === 0) continue;
        const boost = 1 / (1 + links.length / ENTITY_IDF_K);
        for (const link of links) {
          boosts.set(link.memoryId, (boosts.get(link.memoryId) ?? 0) + boost);
        }
      }
      for (const [id, v] of boosts) boosts.set(id, Math.min(v, 1.0));
    } catch {
      // Fail-safe: entity boost is best-effort only.
    }
    return boosts;
  }

  /**
   * Custom (P0-3, 2026-08-07): FTS5 BM25 lexical-match boosts.
   * Queries the pre-built memory_items_fts table for records whose content
   * lexically matches significant ASCII tokens of the query (proper nouns,
   * tool/tech names). Chinese is not indexed by the default unicode61
   * tokenizer, so this mainly strengthens proper-noun / term queries.
   * Boosts are graded by BM25 rank (best match -> 1.0, decaying), so a
   * keyword shared by many records no longer gives them an equal full boost.
   * Fail-safe: returns an empty map on any error (table missing, bad query,
   * non-sqlite backend), never breaking the search path.
   */
  private ftsBoosts(query: string, scopes?: MemoryScope[]): Map<string, number> {
    const boosts = new Map<string, number>();
    if (!this.sqlitePath) return boosts;
    // Significant ASCII tokens (>=2 chars). CJK is not FTS-indexable here.
    const tokens = [...new Set(
      [...query.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.\-]+/g)].map((m) => m[0]),
    )];
    if (tokens.length === 0) return boosts;
    const ftsQuery = tokens.map((t) => `"${t.replace(/["*^(){}[\]]/g, " ")}"`).join(" OR ");
    try {
      using db = openSqliteDatabase(this.sqlitePath);
      const scopeFilter =
        scopes && scopes.length > 0
          ? ` AND fts.scope IN (${scopes.map(() => "?").join(",")})`
          : "";
      const scopeArgs = scopes && scopes.length > 0 ? scopes.map((s) => `${s.type}:${s.id}`) : [];
      // Custom (P0-3 hardening, 2026-08-07): JOIN memory_items so stale FTS rows
      // (left over from deleted records) cannot occupy the LIMIT 30 quota —
      // measured 16/30 slots wasted before this fix.
      const rows = db
        .prepare(
          `SELECT fts.id, bm25(memory_items_fts) AS bm25
           FROM memory_items_fts AS fts
           JOIN memory_items AS m ON m.id = fts.id
           WHERE memory_items_fts MATCH ?${scopeFilter}
           ORDER BY bm25(memory_items_fts) LIMIT 30`,
        )
        .all(ftsQuery, ...scopeArgs) as { id: string; bm25: number }[];
      // bm25() returns negative scores; smaller (more negative) = better match.
      rows.forEach((row, rank) => {
        // Rank decay: rank 0 -> 1.0, rank 29 -> ~0.36; never below 0.3.
        const boost = Math.max(0.3, 1.0 - rank * 0.022);
        boosts.set(row.id, Math.max(boosts.get(row.id) ?? 0, boost));
      });
    } catch {
      // Fail-safe: FTS boost is best-effort only.
    }
    return boosts;
  }

  private async resolveEntityIds(query: string): Promise<Set<string>> {
    if (!this.entityStore) {
      return new Set();
    }

    const entityIds = new Set<string>();
    const trimmed = query.trim();
    if (!trimmed) {
      return new Set();
    }

    const directMatches = await Promise.all([
      this.entityStore.findByName(trimmed),
      this.entityStore.findByAlias(trimmed),
      this.entityStore.searchEntities(trimmed, { limit: 8 }),
    ]);
    const extracted = this.entityExtractor ? await this.entityExtractor.extract(trimmed) : [];

    for (const match of directMatches[0] ? [directMatches[0]] : []) {
      entityIds.add(match.id);
    }
    for (const match of directMatches[1] ? [directMatches[1]] : []) {
      entityIds.add(match.id);
    }
    for (const entity of directMatches[2]) {
      entityIds.add(entity.id);
    }

    for (const entity of extracted) {
      const matched = await this.entityStore.findByName(entity.name);
      if (matched) {
        entityIds.add(matched.id);
      }
      for (const alias of entity.aliases ?? []) {
        const aliasMatch = await this.entityStore.findByAlias(alias);
        if (aliasMatch) {
          entityIds.add(aliasMatch.id);
        }
      }
    }

    return entityIds;
  }

  private async formatEntityGraphContext(query: string, hits: MemorySearchHit[]): Promise<string> {
    if (!this.entityStore) {
      return "";
    }

    const entityIds = await this.resolveEntityIds(query);
    for (const hit of hits.slice(0, 5)) {
      const links = await this.entityStore.getLinkedEntities(hit.record.id);
      for (const link of links) {
        entityIds.add(link.entityId);
      }
    }
    if (entityIds.size === 0) {
      return "";
    }

    const names = new Map<string, string>();
    for (const id of entityIds) {
      const entity = await this.entityStore.getEntity(id);
      if (entity) {
        names.set(id, entity.name);
      }
    }

    const lines: string[] = [];
    const seenRelations = new Set<string>();
    for (const id of entityIds) {
      const relations = await this.entityStore.getRelationsForEntity(id, { limit: 4 });
      for (const relation of relations) {
        const source = names.get(relation.sourceEntityId) ?? (await this.entityStore.getEntity(relation.sourceEntityId))?.name;
        const target = names.get(relation.targetEntityId) ?? (await this.entityStore.getEntity(relation.targetEntityId))?.name;
        if (!source || !target) {
          continue;
        }
        const key = `${relation.sourceEntityId}:${relation.targetEntityId}:${relation.relation}:${relation.memoryId ?? ""}`;
        if (seenRelations.has(key)) {
          continue;
        }
        seenRelations.add(key);
        lines.push(`- ${source} ${relation.relation} ${target}`);
        if (lines.length >= 8) {
          break;
        }
      }
      if (lines.length >= 8) {
        break;
      }
    }

    if (lines.length > 0) {
      return `Related entity graph:\n${lines.join("\n")}`;
    }
    const entityList = [...names.values()].slice(0, 8);
    return entityList.length > 0 ? `Related entities:\n${entityList.map((name) => `- ${name}`).join("\n")}` : "";
  }
}

export function createLeafMem(options: LeafMemOptions = {}): LeafMem {
  return new LeafMem(options);
}

function createDefaultStore(backend: MemoryStorageBackend, storagePath: string): MemoryStore {
  if (backend === "memory") {
    return new InMemoryStore();
  }
  return new SqliteMemoryStore(deriveSqlitePath(storagePath));
}

function resolveStorageBackend(options: LeafMemOptions): MemoryStorageBackend {
  if (options.storage?.backend) {
    return options.storage.backend;
  }
  if (options.store instanceof InMemoryStore) {
    return "memory";
  }
  return "sqlite";
}

function deriveSqlitePath(storagePath: string): string {
  if (storagePath.endsWith(".sqlite") || storagePath.endsWith(".db")) {
    return storagePath;
  }
  return storagePath.includes(".") ? storagePath : `${storagePath}.sqlite`;
}

function matchesRequestedScopes(recordScope: MemoryScope, requestedScopes?: MemoryScope[]): boolean {
  if (!requestedScopes || requestedScopes.length === 0) {
    return true;
  }
  const key = scopeKey(recordScope);
  return requestedScopes.some((scope) => scopeKey(scope) === key);
}

function resolveScopeWeight(recordScope: MemoryScope, requestedScopes?: MemoryScope[]): number {
  if (!requestedScopes || requestedScopes.length === 0) {
    return 0.5;
  }
  const key = scopeKey(recordScope);
  const match = requestedScopes.find((scope) => scopeKey(scope) === key);
  if (!match) {
    return 0;
  }
  return clamp(match.weight ?? 1, 0, 1.5) / 1.5;
}

function buildSearchText(record: MemoryRecord): string {
  return [
    record.kind,
    record.summary ?? "",
    record.content,
    record.tags.join(" "),
    record.scope.type,
    record.scope.id,
  ]
    .filter(Boolean)
    .join("\n");
}

function applyIncomingMarkers(record: MemoryRecord, input: MemoryInput): void {
  const incomingTags = (input.tags ?? []).map((tag) => normalizeText(tag)).filter(Boolean);
  record.tags = [
    ...new Set([...record.tags, ...incomingTags]),
  ];

  const incomingMetadata = input.metadata ? { ...input.metadata } : undefined;
  const incomingSource = input.source?.trim();
  if (!incomingMetadata && (!incomingSource || incomingSource === record.source)) {
    return;
  }

  const previousMetadata = record.metadata ?? {};
  const nextMetadata: Record<string, unknown> = { ...previousMetadata };
  let metadataConflict = false;
  if (incomingMetadata) {
    for (const [key, value] of Object.entries(incomingMetadata)) {
      if (!(key in nextMetadata)) {
        nextMetadata[key] = value;
      } else if (JSON.stringify(nextMetadata[key]) !== JSON.stringify(value)) {
        metadataConflict = true;
      }
    }
  }
  if (incomingSource && incomingSource !== record.source) {
    nextMetadata.sourceHistory = [
      ...new Set([
        record.source,
        ...stringArray(previousMetadata.sourceHistory),
        ...stringArray(incomingMetadata?.sourceHistory),
        incomingSource,
      ]),
    ];
  }
  if ((incomingSource && incomingSource !== record.source) || metadataConflict) {
    nextMetadata.markerHistory = [
      ...objectArray(previousMetadata.markerHistory),
      {
        source: incomingSource ?? "manual",
        tags: incomingTags,
        metadata: incomingMetadata ?? {},
      },
    ];
  }
  record.metadata = nextMetadata;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()) : [];
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function computeRecencyBoost(iso: string, now: Date): number {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return 0;
  }
  const ageMs = Math.max(0, now.getTime() - timestamp);
  const ageDays = ageMs / 86_400_000;
  return 1 / (1 + ageDays / 30);
}

/**
 * Custom (P1-2, 2026-08-07): a record whose metadata.valid_until is a past
 * date/time is known-stale and should be demoted in recall scoring.
 * Records carrying metadata.supersededBy are already chained to a successor,
 * so they are treated as resolved (not penalized here).
 */
function isPastValidUntil(record: MemoryRecord, now: Date): boolean {
  const validUntil = record.metadata?.validUntil ?? record.metadata?.valid_until;
  if (typeof validUntil !== "string") return false;
  const ts = Date.parse(validUntil);
  if (Number.isNaN(ts)) return false;
  if (record.metadata?.supersededBy !== undefined) return false; // superseded chain resolves it
  return now.getTime() > ts;
}

// ---------------------------------------------------------------------------
// Custom (P1-3, 2026-08-07): delta-ops profile maintenance
// ---------------------------------------------------------------------------
// A profile document is section-based markdown. Sections are "## <title>"
// blocks; any text before the first section header is the preamble.
// Delta ops let the LLM change only the sections it mentions; every
// unmentioned section is mechanically copied verbatim, so prose drift is
// structurally impossible. Zero ops / parse failure => document unchanged.

export type ProfileSection = { title: string; body: string };

/** Custom (Console Plan-A, 2026-08-07): exported for the governance snapshot. */
export function parseProfileSections(content: string): { preamble: string; sections: ProfileSection[] } {
  const lines = content.split("\n");
  let preamble = "";
  const sections: ProfileSection[] = [];
  let current: ProfileSection | null = null;
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      current = { title: match[1]!.trim(), body: "" };
      sections.push(current);
    } else if (current) {
      current.body += line + "\n";
    } else {
      preamble += line + "\n";
    }
  }
  return { preamble: preamble.replace(/\n+$/, ""), sections };
}

function renderProfileSections(preamble: string, sections: ProfileSection[]): string {
  const parts: string[] = [];
  if (preamble.trim()) parts.push(preamble.trim());
  for (const s of sections) {
    parts.push(`## ${s.title}\n${s.body.replace(/\n+$/, "")}`);
  }
  return parts.join("\n\n") + "\n";
}

type ProfileDeltaOp =
  | { op: "set_section"; section: string; content: string }
  | { op: "append_to_section"; section: string; content: string }
  | { op: "remove_section"; section: string };

/**
 * Parse the LLM's delta-ops JSON. Extremely defensive: any malformed input
 * returns [] (=> the document is left unchanged), never throws.
 */
function parseProfileDeltaOps(text: string): ProfileDeltaOp[] {
  try {
    // Tolerate code fences / leading prose: extract the first JSON array.
    const fenceMatch = /\[[\s\S]*\]/.exec(text);
    if (!fenceMatch) return [];
    const raw = JSON.parse(fenceMatch[0]);
    if (!Array.isArray(raw)) return [];
    const ops: ProfileDeltaOp[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const op = item.op;
      const section = typeof item.section === "string" ? item.section.trim() : "";
      const content = typeof item.content === "string" ? item.content : "";
      if (op === "remove_section" && section) {
        ops.push({ op: "remove_section", section });
      } else if ((op === "set_section" || op === "append_to_section") && section && content.trim()) {
        ops.push({ op, section, content: content.trim() });
      }
    }
    return ops;
  } catch {
    return [];
  }
}

/**
 * Apply delta ops mechanically to the section list. Unmentioned sections are
 * preserved verbatim. Returns a new list (never mutates the input).
 */
function applyProfileDeltaOps(sections: ProfileSection[], ops: ProfileDeltaOp[]): ProfileSection[] {
  let result = sections.map((s) => ({ title: s.title, body: s.body }));
  for (const op of ops) {
    if (op.op === "remove_section") {
      result = result.filter((s) => s.title !== op.section);
      continue;
    }
    const idx = result.findIndex((s) => s.title === op.section);
    if (op.op === "set_section") {
      if (idx >= 0) {
        result[idx] = { title: op.section, body: op.content };
      } else {
        result.push({ title: op.section, body: op.content });
      }
    } else if (op.op === "append_to_section") {
      if (idx >= 0) {
        const prev = result[idx]!;
        result[idx] = { title: op.section, body: (prev.body.replace(/\n+$/, "") + "\n" + op.content).replace(/^\n+/, "") };
      } else {
        result.push({ title: op.section, body: op.content });
      }
    }
  }
  return result;
}

function buildSnippet(content: string, queryTokens: string[]): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= 220) {
    return normalized;
  }
  const lower = normalized.toLowerCase();
  const token = queryTokens.find((entry) => lower.includes(entry));
  if (!token) {
    return `${normalized.slice(0, 217)}...`;
  }
  const index = lower.indexOf(token);
  const start = Math.max(0, index - 90);
  const end = Math.min(normalized.length, index + 130);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function summarizeContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}

function normalizeSimilarity(value: number): number {
  return clamp((value + 1) / 2, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildRecallQuery(query: string, recentMessages?: string[]): string {
  const parts = [
    query.trim(),
    ...(recentMessages ?? []).map((message) => message.trim()).filter(Boolean),
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, 1200);
}

export function formatRecallContext(hits: MemorySearchHit[], maxChars: number): string {
  if (hits.length === 0) {
    return "";
  }
  const lines = [
    "Relevant long-term memory:",
    "Use these memories as supporting context.",
    "",
  ];
  let used = lines.join("\n").length;
  for (const hit of hits) {
    const markers = [`id: ${hit.record.id}`, `source: ${hit.record.source}`];
    if (hit.record.tags.length > 0) {
      markers.push(`tags: ${hit.record.tags.join(", ")}`);
    }
    if (hit.record.metadata) {
      markers.push(`metadata: ${JSON.stringify(hit.record.metadata)}`);
    }
    const block = [
      `- [${hit.record.kind}] ${hit.record.scope.type}:${hit.record.scope.id} (score ${hit.score.toFixed(2)})`,
      `  markers: ${markers.join("; ")}`,
      `  ${hit.record.content.trim()}`,
    ].join("\n");
    if (used + block.length + 1 > maxChars) {
      break;
    }
    lines.push(block);
    used += block.length + 1;
  }
  return lines.join("\n").trim();
}

export function formatMemoryNavigation(records: MemoryRecord[], maxChars: number): string {
  if (records.length === 0 || maxChars < 120) {
    return "";
  }
  const lines = [
    "Memory navigation:",
    "Use memory_recall(action=get, id=...) to inspect exact records; use memory_recall(action=task_window, taskId=..., message=current query) for task-linked context.",
    "",
  ];
  let used = lines.join("\n").length;
  for (const record of records) {
    const summary = (record.summary?.trim() || record.content.trim()).replace(/\s+/g, " ");
    const taskId = stringMetadata(record.metadata, "taskId");
    const taskLine = taskId ? ` task=memory_recall(action=task_window, taskId=${taskId}, message=current query)` : "";
    const line =
      `- ${record.kind} ${record.scope.type}:${record.scope.id} id=${record.id} ` +
      `get=memory_recall(action=get, id=${record.id})${taskLine} summary=${summary}`;
    if (used + line.length + 1 > maxChars) {
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 3 ? lines.join("\n").trim() : "";
}

function buildEvidenceRef(record: MemoryRecord): MemoryEvidenceRef {
  const tools: MemoryEvidenceRef["tools"] = [
    {
      name: "memory_recall",
      arguments: { action: "get", id: record.id },
    },
  ];
  const taskId = stringMetadata(record.metadata, "taskId");
  if (taskId) {
    tools.push({
      name: "memory_recall",
      arguments: { action: "task_window", taskId, message: "<current query>" },
    });
  }
  return {
    recordId: record.id,
    scope: { ...record.scope },
    source: record.source,
    tags: [...record.tags],
    metadata: record.metadata ? { ...record.metadata } : undefined,
    tools,
  };
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
