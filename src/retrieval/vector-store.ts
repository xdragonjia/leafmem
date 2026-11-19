import type { MemoryRecord } from "../core/types.js";

// ---------------------------------------------------------------------------
// Vector store types
// ---------------------------------------------------------------------------

export type VectorDocument = {
  id: string;
  vector: number[];
  content: string;
  metadata?: Record<string, unknown>;
};

export type VectorSearchResult = {
  id: string;
  score: number;
  content: string;
  metadata?: Record<string, unknown>;
};

export type VectorSearchOptions = {
  topK?: number;
  filter?: Record<string, unknown>;
  minScore?: number;
};

// ---------------------------------------------------------------------------
// Vector store interface
// ---------------------------------------------------------------------------

/**
 * Pluggable vector store abstraction.
 *
 * LeafMem ships two implementations:
 * - `InMemoryVectorStore` — zero-dependency, brute-force cosine (test / dev)
 * - `QdrantVectorStore` — REST-based ANN via Qdrant (production)
 */
export interface VectorStore {
  readonly id: string;

  /** Insert or update documents. Vectors must be pre-computed. */
  upsert(docs: VectorDocument[]): Promise<void>;

  /** ANN / brute-force vector search. */
  search(queryVector: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;

  /** Delete by document IDs. */
  delete(ids: string[]): Promise<void>;

  /** Total document count. */
  count(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a text string suitable for embedding from a MemoryRecord.
 */
export function buildEmbeddingText(record: MemoryRecord): string {
  // 🔴 2026-11-19：把「模式三件套」并入 embedding 输入。
  //   此前 metadata.pattern/trigger_context/applicability 只存不检 ⇒ 命名模式
  //   是「纯叙事字段」，向量检索读不到 ⇒ 「激活锚」在机器层不成立（消费侧自证）。
  //   并入后「QA 闭环」「判据形态」等模式短语与「采集→质量闸→落盘」等情境词
  //   直接参与向量化，新任务按功能结构提问时可命中。向后兼容：无三件套的
  //   存量条目按原样拼接（filter(Boolean) 丢弃空段）。
  const meta = (record.metadata ?? {}) as Record<string, unknown>;
  const patternBits = [meta.pattern, meta.trigger_context, meta.applicability]
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  return [
    record.kind,
    record.summary ?? "",
    ...patternBits,
    record.content,
    record.tags.join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}
