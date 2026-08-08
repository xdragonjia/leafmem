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
  /** Max documents sent per rerank call. Default 40. */
  topK: number;
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
    topK: parsePositiveInt(leafmemEnv("RERANK_TOP_K", env), 40),
  };
}

export class CrossEncoderReranker {
  constructor(private readonly config: RerankConfig) {}

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
      return { scores, model: payload.model ?? this.config.model };
    } catch {
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
