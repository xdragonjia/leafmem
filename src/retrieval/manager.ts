import { cosineSimilarity } from "../core/hash-embedding.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import { createEmbeddingProvider, HashEmbeddingProvider } from "./embeddings.js";
import { QmdRetrievalBackend } from "./qmd.js";
import { CrossEncoderReranker, resolveRerankConfigFromEnv } from "./reranker.js";
import type {
  MemoryEmbeddingProvider,
  RetrievalHit,
  RetrievalManagerOptions,
  RetrievalRecallResult,
} from "./types.js";
import type { VectorStore } from "./vector-store.js";
import { buildEmbeddingText } from "./vector-store.js";

const DEFAULT_MAX_RESULTS = 8;
/** Fusion weights when a cross-encoder rerank succeeds. */
const RERANK_FUSION_WEIGHT = 0.6;
const BASE_FUSION_WEIGHT = 1 - RERANK_FUSION_WEIGHT;

/** B0.5：精排候选池大小（原 512 硬编码）。见 searchBuiltin 注释。 */
const PRERANK_POOL = 160;

/**
 * B0.7（2026-10-22）：送进 cross-encoder 的文档默认截断长度（可用
 * LEAFMEM_RERANK_DOC_CHARS 覆盖）。
 *
 * 实测依据：rerank 端点（BAAI/bge-reranker-v2-m3）延迟随文档总 token 数近似线性上升，
 * 40 篇 × ~450 字实测 620~885ms，而生产 timeout 只有 3000ms —— 真实记忆条目常有
 * 3000~5000 字，整篇送进去会**超时降级**（静默退回原序，白付 3 秒）。
 * 另实测 siliconflow 连续 ~11 次调用后开始 429，payload 越大越容易撞限流。
 */
const RERANK_DOC_CHARS_DEFAULT = 4000;

export class RetrievalManager {
  /** B0.6：跨进程持久化文档向量（可选；缺失则退化为纯内存缓存） */
  private readonly vectorCache: RetrievalManagerOptions["vectorCache"] | null;
  readonly backend: "builtin" | "qmd";
  readonly usesRemoteEmbeddings: boolean;
  private embeddingProviderPromise: Promise<MemoryEmbeddingProvider | null> | null;
  private readonly qmdBackend: QmdRetrievalBackend | null;
  private readonly vectorStore: VectorStore | null;
  private readonly reranker: CrossEncoderReranker | null;
  private readonly rerankTopK: number;
  private readonly rerankDocChars: number;

  constructor(private readonly options: RetrievalManagerOptions) {
    this.backend = options.backend ?? "builtin";
    this.usesRemoteEmbeddings = Boolean(options.embeddings || options.embeddingProvider);
    this.embeddingProviderPromise = options.embeddingProvider
      ? Promise.resolve(options.embeddingProvider)
      : createEmbeddingProvider(options.embeddings);
    this.qmdBackend = options.qmd?.enabled ? new QmdRetrievalBackend(options.qmd) : null;
    this.vectorStore = options.vectorStore ?? null;
    this.vectorCache = options.vectorCache ?? null;
    const rerankConfig = resolveRerankConfigFromEnv();
    this.reranker = rerankConfig ? new CrossEncoderReranker(rerankConfig) : null;
    this.rerankTopK = rerankConfig?.topK ?? 20;
    this.rerankDocChars = rerankConfig?.docChars ?? RERANK_DOC_CHARS_DEFAULT;
  }

  /**
   * Index a memory record into the vector store.
   * Called by the platform service after a successful write.
   * No-op if no vectorStore is configured or no embedding provider.
   */
  async indexRecord(record: MemoryRecord): Promise<void> {
    if (!this.vectorStore) return;
    const provider = (await this.embeddingProviderPromise) ?? new HashEmbeddingProvider();
    const text = buildEmbeddingText(record);
    const vector = await provider.embedQuery(text);
    await this.vectorStore.upsert([{
      id: record.id,
      vector,
      content: text,
      metadata: {
        scopeType: record.scope.type,
        scopeId: record.scope.id,
        kind: record.kind,
      },
    }]);
  }

  /**
   * Remove a record from the vector store.
   * Called by the platform service after a successful delete.
   */
  async deleteVector(id: string): Promise<void> {
    if (!this.vectorStore) return;
    await this.vectorStore.delete([id]);
  }

  async search(
    query: string,
    options: { scopes?: MemoryScope[]; maxResults?: number; minScore?: number } = {},
  ): Promise<RetrievalHit[]> {
    const limit = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
    // When a cross-encoder reranker is configured, widen the candidate pool
    // so rerank can surface relevant hits that lexical/hash scoring buried.
    const poolLimit = this.reranker ? Math.max(limit, this.rerankerTopK()) : limit;
    const poolOptions = { ...options, maxResults: poolLimit };
    let hits: RetrievalHit[];
    if (this.backend === "qmd" && this.qmdBackend) {
      const qmdHits = await this.qmdBackend.search(query, poolOptions);
      if (!this.options.qmd?.includeDefaultMemory) {
        return qmdHits.slice(0, limit);
      }
      const builtinHits = await this.searchBuiltin(query, poolOptions);
      hits = [...qmdHits, ...builtinHits].toSorted((left, right) => right.score - left.score);
    } else {
      hits = await this.searchBuiltin(query, poolOptions);
    }
    return await this.applyRerank(query, hits, limit);
  }

  /**
   * Cross-encoder rerank stage (custom addition).
   *
   * Reranks candidates against the query using a SiliconFlow-compatible
   * /v1/rerank endpoint (e.g. BAAI/bge-reranker-v2-m3). The rerank score is
   * fused with the original retrieval score (60/40) to keep lexical/recency
   * signals while letting true semantic relevance dominate ordering.
   *
   * Fail-safe: any error, timeout, or missing configuration returns the
   * original ordering untouched — recall is never blocked by the reranker.
   */
  private async applyRerank(
    query: string,
    hits: RetrievalHit[],
    limit: number,
  ): Promise<RetrievalHit[]> {
    if (!this.reranker || hits.length < 3) {
      return hits.slice(0, limit);
    }
    const topK = Math.min(hits.length, this.rerankerTopK());
    const pool = hits.slice(0, topK);
    // B0.7：截断后再送 cross-encoder（原样整篇送会超时降级，见 RERANK_DOC_CHARS 注释）
    const documents = pool.map((hit) =>
      (hit.record ? buildSearchText(hit.record) : hit.snippet).slice(0, this.rerankDocChars),
    );
    const result = await this.reranker.rerank(query, documents);
    if (!result) {
      return hits.slice(0, limit);
    }
    const maxBase = pool[0]?.score ?? 1;
    const fused = pool.map((hit, index) => {
      const rerankScore = result.scores[index] ?? 0;
      const normalizedBase = maxBase > 0 ? hit.score / maxBase : 0;
      return {
        ...hit,
        score: rerankScore * RERANK_FUSION_WEIGHT + normalizedBase * BASE_FUSION_WEIGHT,
        metadata: { ...(hit.metadata ?? {}), rerankScore },
      };
    });
    const sorted = fused.toSorted((left, right) => right.score - left.score);
    return sorted.slice(0, limit);
  }

  private rerankerTopK(): number {
    return this.rerankTopK;
  }

  async recall(
    query: string,
    options: { scopes?: MemoryScope[]; maxResults?: number; minScore?: number; maxChars?: number } = {},
  ): Promise<RetrievalRecallResult> {
    const hits = await this.search(query, options);
    return {
      query: query.trim(),
      hits,
      injectedContext: formatRetrievalContext(hits, options.maxChars ?? 4_000),
    };
  }

  /**
   * B0.5（2026-10-22）：文档向量缓存。
   *
   * 为什么必须做：searchBuiltin 对 baseHits（最多 512 条）**每次 recall 全量重算**
   * `provider.embedDocuments()` —— 远程 embedding 下实测单次 recall **9 秒**
   * （core search 只占 94ms）。这是真实会话注入路径的最大瓶颈。
   *
   * 失效判据：`id + updatedAt + modelId`。updatedAt 由 update() 无条件刷新；
   * modelId 变化（换 embedding 模型/维度）自动全量失效，避免混用不同向量空间。
   */
  private readonly docVectorCache = new Map<
    string,
    { updatedAt: string; modelId: string; vector: number[] }
  >();
  private static readonly DOC_VECTOR_CACHE_MAX = 20_000;

  private async searchBuiltin(
    query: string,
    options: { scopes?: MemoryScope[]; maxResults?: number; minScore?: number },
  ): Promise<RetrievalHit[]> {
    // Fast path: use vector store for ANN search if available
    if (this.vectorStore) {
      return this.searchVectorStore(query, options);
    }

    // B0.5：粗排池 512→160。remote embedding 是对池内**每条**文档算向量，
    // 512 条一次批量请求实测 4~9s；降到 160 后请求量 -69%，而 recall 最终只取 top-8，
    // core 打分（lexical 0.45 + hash 0.35）已保证粗排质量，精排池 160 足够。
    const baseHits = await this.options.memory.search(query, {
      scopes: options.scopes,
      maxResults: PRERANK_POOL,
      minScore: 0,
    });
    if (baseHits.length === 0) {
      return [];
    }
    const provider = (await this.embeddingProviderPromise) ?? new HashEmbeddingProvider();
    if (provider.id === "hash") {
      return baseHits
        .filter((hit) => hit.score >= (options.minScore ?? 0.18))
        .slice(0, options.maxResults ?? DEFAULT_MAX_RESULTS)
        .map((hit) => ({
          source: "builtin" as const,
          score: hit.score,
          snippet: hit.snippet,
          record: hit.record,
          searchHit: hit,
        }));
    }

    const queryEmbedding = await provider.embedQuery(query);
    // 🔴 modelId 必须含**具体模型名**：只用 provider.id（如 "openai"）时，
    // 同一 provider 下换模型（bge-m3 → bge-large）缓存不会失效 ⇒ 混用不同向量空间，
    // 相似度计算失去意义。取不到 model 时降级为 "default"。
    const modelId = `${(provider as { id?: string }).id ?? "hash"}:${this.options.embeddings?.model ?? "default"}`;
    // B0.6：三级查找 —— 进程内 Map → SQLite 持久表 → 远程 embedding。
    // 落盘的意义：进程重启不丢、E3 扩容后命中率不退化（否则每次重启首次 recall 4~6s）。
    const resolved = new Map<string, number[]>();
    const needFromDb: string[] = [];
    for (const hit of baseHits) {
      const cached = this.docVectorCache.get(hit.record.id);
      if (cached && cached.updatedAt === hit.record.updatedAt && cached.modelId === modelId) {
        resolved.set(hit.record.id, cached.vector);
      } else {
        needFromDb.push(hit.record.id);
      }
    }
    if (needFromDb.length > 0 && this.vectorCache) {
      try {
        const rows = this.vectorCache.getMany(needFromDb, modelId) as Map<
          string,
          { updatedAt: string; modelId: string; vector: number[] }
        >;
        for (const hit of baseHits) {
          const row = rows.get(hit.record.id);
          if (row && row.updatedAt === hit.record.updatedAt) {
            resolved.set(hit.record.id, row.vector);
            this.docVectorCache.set(hit.record.id, {
              updatedAt: row.updatedAt,
              modelId,
              vector: row.vector,
            });
          }
        }
      } catch {
        /* fail-open：缓存不可用则走远程 */
      }
    }
    const missing: Array<{ id: string; updatedAt: string; text: string }> = [];
    for (const hit of baseHits) {
      if (!resolved.has(hit.record.id)) {
        missing.push({
          id: hit.record.id,
          updatedAt: hit.record.updatedAt,
          text: buildSearchText(hit.record),
        });
      }
    }
    if (missing.length > 0) {
      const fresh = await provider.embedDocuments(missing.map((item) => item.text));
      missing.forEach((item, index) => {
        const vector = fresh[index];
        if (vector) {
          this.docVectorCache.set(item.id, {
            updatedAt: item.updatedAt,
            modelId,
            vector: vector as number[],
          });
        }
      });
      if (this.vectorCache) {
        try {
          this.vectorCache.putMany(
            missing
              .map((item) => {
                const cachedNow = this.docVectorCache.get(item.id);
                return cachedNow && cachedNow.updatedAt === item.updatedAt
                  ? { id: item.id, updatedAt: item.updatedAt, modelId, vector: cachedNow.vector }
                  : null;
              })
              .filter((x): x is { id: string; updatedAt: string; modelId: string; vector: number[] } => x !== null),
          );
          for (const item of missing) {
            const cachedNow = this.docVectorCache.get(item.id);
            if (cachedNow) resolved.set(item.id, cachedNow.vector);
          }
        } catch {
          /* fail-open */
        }
      }
      if (this.docVectorCache.size > RetrievalManager.DOC_VECTOR_CACHE_MAX) {
        const drop = Math.floor(RetrievalManager.DOC_VECTOR_CACHE_MAX / 5);
        let i = 0;
        for (const key of this.docVectorCache.keys()) {
          if (i++ >= drop) break;
          this.docVectorCache.delete(key);
        }
      }
    }
    const combined = baseHits.map((hit) => {
      const vector = resolved.get(hit.record.id) ?? this.docVectorCache.get(hit.record.id)?.vector ?? [];
      const vectorScore = clamp(cosineSimilarity(queryEmbedding, vector), 0, 1);
      return {
        source: "builtin" as const,
        score: hit.score * 0.65 + vectorScore * 0.35,
        snippet: hit.snippet,
        record: hit.record,
        searchHit: {
          ...hit,
          reasons: {
            ...hit.reasons,
            vector: vectorScore,
          },
        } as typeof hit,
      };
    });
    return combined
      .filter((hit) => hit.score >= (options.minScore ?? 0.18))
      .toSorted((left, right) => right.score - left.score)
      .slice(0, options.maxResults ?? DEFAULT_MAX_RESULTS);
  }

  /**
   * ANN search path: query the vector store directly.
   * Falls back to FTS if embedding provider is unavailable.
   */
  private async searchVectorStore(
    query: string,
    options: { scopes?: MemoryScope[]; maxResults?: number; minScore?: number },
  ): Promise<RetrievalHit[]> {
    const provider = (await this.embeddingProviderPromise) ?? new HashEmbeddingProvider();
    const queryVector = await provider.embedQuery(query);
    const limit = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const topK = Math.max(1, limit * 2);
    const filters = buildScopeFilters(options.scopes);
    const batches = filters.length === 0
      ? [await this.vectorStore!.search(queryVector, {
          topK,
          minScore: options.minScore ?? 0.18,
        })]
      : await Promise.all(
          filters.map((filter) =>
            this.vectorStore!.search(queryVector, {
              topK,
              minScore: options.minScore ?? 0.18,
              filter,
            }),
          ),
        );

    const mergedHits = new Map<string, (typeof batches)[number][number]>();
    for (const batch of batches) {
      for (const hit of batch) {
        const existing = mergedHits.get(hit.id);
        if (!existing || hit.score > existing.score) {
          mergedHits.set(hit.id, hit);
        }
      }
    }

    const records = await this.options.memory.list({ scopes: options.scopes });
    const recordsById = new Map(records.map((record) => [record.id, record]));

    const results: RetrievalHit[] = [];
    for (const hit of [...mergedHits.values()].toSorted((left, right) => right.score - left.score)) {
      const record = recordsById.get(hit.id);
      if (!record) {
        continue;
      }
      results.push({
        source: "builtin",
        score: hit.score,
        snippet: record.content.slice(0, 200),
        record,
        metadata: { vectorScore: hit.score },
      });
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }
}

export function formatRetrievalContext(hits: RetrievalHit[], maxChars: number): string {
  if (hits.length === 0) {
    return "";
  }
  const blocks: string[] = [];
  for (const hit of hits) {
    if (hit.source === "builtin" && hit.record) {
      const markers = [`id ${hit.record.id}`, `source ${hit.record.source}`];
      if (hit.record.tags.length > 0) {
        markers.push(`tags ${hit.record.tags.join(", ")}`);
      }
      blocks.push(
        `- [${hit.record.kind}] ${hit.record.summary?.trim() || hit.record.content.trim()} ` +
          `(${markers.join("; ")}; score ${hit.score.toFixed(2)})`,
      );
      continue;
    }
    const path = hit.path ? ` (${hit.path})` : "";
    blocks.push(`- [qmd] ${hit.snippet.trim()}${path}`);
  }
  const text = `Relevant memory:\n${blocks.join("\n")}`;
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars).trimEnd();
}

function buildSearchText(record: MemoryRecord): string {
  return [record.kind, record.summary ?? "", record.content, record.tags.join(" ")].filter(Boolean).join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildScopeFilters(scopes?: MemoryScope[]): Record<string, unknown>[] {
  if (!scopes || scopes.length === 0) {
    return [];
  }
  const unique = new Map<string, Record<string, unknown>>();
  for (const scope of scopes) {
    unique.set(`${scope.type}:${scope.id}`, {
      scopeType: scope.type,
      scopeId: scope.id,
    });
  }
  return [...unique.values()];
}
