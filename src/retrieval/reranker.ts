import { leafmemEnv } from "../system/env-compat.js";
/**
 * Cross-encoder reranker client.
 *
 * Custom addition (not in upstream): SiliconFlow-compatible /v1/rerank API
 * integration for reranking recall candidates with BAAI/bge-reranker-v2-m3.
 *
 * Design principles:
 * - Never block recall: on timeout / network error / misconfiguration,
 *   return null so the caller keeps the original ordering.
 * - Zero new dependencies: uses global fetch (Node 18+) + AbortController.
 * - Env-configurable: LEAFMEM_RERANK_URL / LEAFMEM_RERANK_MODEL /
 *   LEAFMEM_RERANK_API_KEY (falls back to OPENAI_API_KEY) /
 *   LEAFMEM_RERANK_TIMEOUT_MS / LEAFMEM_RERANK_TOP_K.
 */

export type RerankConfig = {
  /** Rerank endpoint URL, e.g. https://api.siliconflow.cn/v1/rerank */
  url: string;
  /** Model name, e.g. BAAI/bge-reranker-v2-m3 */
  model: string;
  /** API key (Bearer token) */
  apiKey: string;
  /** Request timeout in milliseconds. Default 3000. */
  timeoutMs: number;
  /** Max documents sent per rerank call. Default 20（B0.7 实测最优）。 */
  topK: number;
  /** 送入 cross-encoder 的每篇文档截断长度（字符）。Default 4000（B0.7 实测）。 */
  docChars: number;
};

export type RerankResult = {
  /** Relevance score (0-1) aligned to input document order; -1 = missing. */
  scores: number[];
  model: string;
};

export function resolveRerankConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RerankConfig | null {
  const url = leafmemEnv("RERANK_URL", env)?.trim();
  const model = leafmemEnv("RERANK_MODEL", env)?.trim();
  const apiKey = (leafmemEnv("RERANK_API_KEY", env) ?? env.OPENAI_API_KEY)?.trim();
  if (!url || !model || !apiKey) {
    return null;
  }
  return {
    url,
    model,
    apiKey,
    timeoutMs: parsePositiveInt(leafmemEnv("RERANK_TIMEOUT_MS", env), 3000),
    // B0.7 实测（15 条标注题，正文覆盖 @1/@3/@8）：
    //   topK40+全文 6/9/10 但 p50 1597ms；topK20+全文 6/10/10 且 p50 906ms；
    //   topK10 降至 5/9/9。故取 topK=20（质量不降、少 700ms）。
    topK: parsePositiveInt(leafmemEnv("RERANK_TOP_K", env), 20),
    // 截断长度实测单调：800→4/7/9、2000→5/7/9、4000→6/9/10、不截断→6/9/10。
    // 取 4000（覆盖 p99 条目长度，同时给病态超长条目兜底）。
    docChars: parsePositiveInt(leafmemEnv("RERANK_DOC_CHARS", env), 4000),
  };
}

export class CrossEncoderReranker {
  /** 最近一次失败原因（null = 上一次成功）。供上层/探针判断"是否静默降级"。 */
  lastFailure: string | null = null;
  private lastLoggedAt = 0;

  constructor(private readonly config: RerankConfig) {}

  private noteFailure(reason: string): void {
    this.lastFailure = reason;
    const now = Date.now();
    // 节流：5 分钟内只记一次，避免限流期间刷屏
    if (now - this.lastLoggedAt > 300_000) {
      this.lastLoggedAt = now;
      console.warn(`[leafmem] rerank degraded → fallback to base order: ${reason}`);
    }
  }

  /**
   * Rerank documents against a query.
   * Returns null on any failure — callers MUST fall back to the original order.
   */
  async rerank(query: string, documents: string[]): Promise<RerankResult | null> {
    const trimmedQuery = query.trim();
    const docs = documents.map((doc) => doc.trim()).filter((doc) => doc.length > 0);
    if (!trimmedQuery || docs.length === 0) {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          query: trimmedQuery,
          documents: docs.slice(0, this.config.topK),
          top_n: Math.min(docs.length, this.config.topK),
          return_documents: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 🔴 2026-10-22：429/5xx 以前是静默 return null，导致"rerank 明明配了却没生效"
        // 只能靠 metadata 里有没有 rerankScore 反推。实测 siliconflow 连续 ~11 次调用后
        // 开始 429，一次探针跑 37 条查询时后半段全部降级。此处保留原因供上层告警。
        this.noteFailure(`HTTP ${response.status}${response.status === 429 ? " (rate limited)" : ""}`);
        return null;
      }
      const payload = (await response.json()) as {
        model?: string;
        results?: Array<{ index: number; relevance_score: number }>;
      };
      if (!Array.isArray(payload.results) || payload.results.length === 0) {
        return null;
      }
      const scores = new Array<number>(docs.length).fill(-1);
      for (const result of payload.results) {
        if (
          Number.isInteger(result.index) &&
          result.index >= 0 &&
          result.index < scores.length &&
          typeof result.relevance_score === "number"
        ) {
          scores[result.index] = clamp01(result.relevance_score);
        }
      }
      this.lastFailure = null;
      return { scores, model: payload.model ?? this.config.model };
    } catch (error) {
      const aborted = (error as { name?: string })?.name === "AbortError";
      this.noteFailure(aborted ? `timeout ${this.config.timeoutMs}ms` : String((error as Error)?.message ?? error));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
