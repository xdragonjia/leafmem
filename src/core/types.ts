export const MEMORY_SCOPE_TYPES = ["agent", "session", "user", "task", "document", "project", "repo"] as const;

export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];

export type MemoryScope = {
  type: MemoryScopeType;
  id: string;
  weight?: number;
};

export type MemoryKind =
  | "fact"
  | "preference"
  | "decision"
  | "identity"
  | "experience"
  | "lesson"
  | "note"
  | (string & {});

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  summary?: string;
  confidence: number;
  importance: number;
  source: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MemoryInput = {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  summary?: string;
  confidence?: number;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /**
   * 2026-10-22：是否参与服务端语义去重（token 0.5 + hash 0.5，阈值 0.85 合并）。
   * 默认 true（原有行为）。**分块式批量摄入**必须传 false：分块器已按 chunk 指纹做精确幂等，
   * 而同一节的兄弟块天然共享面包屑标题、tags 与词汇（实测相邻块相似度均值 0.647、
   * 极值 0.917），走模糊合并会把不同块覆盖成一条，等于丢知识。
   */
  dedupe?: boolean;
  /**
   * 2026-10-22（B3）：更新时**不刷新 updatedAt**。
   *
   * 只用于"元数据维护"类写入（回填 eventTime、标记 superseded/archived）。
   * 为什么必须存在：recency 打分取 max(lastRecalledAt, updatedAt)，
   * 若回填 4,300 条把 updatedAt 全刷成 now，等于宣称"这些全部是刚更新的"，
   * 1 年前的记录 recency 从 0.2 抬到 1.0（权重 0.08 ⇒ +0.064 分），
   * 排序被系统性污染，且语义上是假话。
   */
  preserveUpdatedAt?: boolean;
};

export type MemorySearchOptions = {
  scopes?: MemoryScope[];
  maxResults?: number;
  minScore?: number;
  /**
   * E1（2026-10-22）：是否包含已退出"当前事实"的记录（status=superseded/archived）。
   * 默认 false —— 被替代/归档的记忆不该再参与当前问答（它们是历史快照）。
   * 排查历史、做对账、跑迁移核验时传 true。
   */
  includeInactive?: boolean;
  /**
   * E1：as-of 查询（"当时/8 月那会儿/历史上"）。只保留 eventTime <= asOf 的记录；
   * **eventTime 缺失的记录仍然可见**（未知时间不判为未来，否则一次查询丢掉 12.5% 记忆）。
   */
  asOf?: string;
};

export type MemorySearchHit = {
  record: MemoryRecord;
  score: number;
  reasons: {
    lexical: number;
    hash: number;
    recency: number;
    importance: number;
    scope: number;
    entity?: number;
    /** Custom (P0-3): FTS5 BM25 boost signal, graded 0.3-1.0. */
    fts?: number;
    /** Custom (P1-importance): distilled-principle boost signal, 0 or 1. */
    principle?: number;
  };
  snippet: string;
  evidence: MemoryEvidenceRef;
};

export type MemoryRecallOptions = MemorySearchOptions & {
  query: string;
  recentMessages?: string[];
  maxChars?: number;
};

export type MemoryEvidenceRef = {
  recordId: string;
  scope: MemoryScope;
  source: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  tools: Array<{
    name: "memory_recall";
    arguments: Record<string, string>;
  }>;
};

export type MemoryRecallResult = {
  query: string;
  hits: MemorySearchHit[];
  injectedContext: string;
  stableContext?: string;
  dynamicContext?: string;
  navigationContext?: string;
  evidence?: MemoryEvidenceRef[];
  layers?: {
    active?: string;
    task?: string;
    palace?: string;
    retrieval?: string;
    graph?: string;
    navigation?: string;
    /** 🔴 2026-10-21 A-MEM：链接邻居上下文块（跨后端保留通道）。 */
    linked?: string;
  };
};

export type MemoryListOptions = {
  scopes?: MemoryScope[];
  limit?: number;
  offset?: number;
  sortBy?: "createdAt" | "updatedAt";
};

export interface MemoryStore {
  load(): Promise<MemoryRecord[]>;
  save(records: MemoryRecord[]): Promise<void>;
  upsert?(record: MemoryRecord): Promise<void>;
  delete?(id: string): Promise<void>;
  /** 🔴 2026-10-21 A-MEM：取给定记忆的链接邻居 id（双向，限 limit 条）。可选实现。 */
  linkedNeighborIds?(ids: string[], limit: number): Promise<string[]>;
  /** 🔴 2026-10-21 A-MEM：写一条记忆间链接。可选实现。 */
  addLink?(sourceId: string, targetId: string, relation: string, confidence: number): Promise<void>;
}

export function normalizeScope(scope: MemoryScope): MemoryScope {
  return {
    type: scope.type,
    id: scope.id.trim(),
    weight: scope.weight,
  };
}

export function parseMemoryScopeType(value: string, label = "scopeType"): MemoryScopeType {
  if ((MEMORY_SCOPE_TYPES as readonly string[]).includes(value)) {
    return value as MemoryScopeType;
  }
  throw new Error(
    `Unsupported ${label}: ${value}. Use one of: ${MEMORY_SCOPE_TYPES.join(", ")}. ` +
      `For a new or custom agent, use scopeType "agent" and put the agent name in scopeId.`,
  );
}

export function scopeKey(scope: MemoryScope): string {
  return `${scope.type}:${scope.id}`.toLowerCase();
}
