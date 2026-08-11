#!/usr/bin/env node
/**
 * LeafMem LongMemEval Benchmark — with optional remote embedding rerank
 * 
 * Usage:
 *   # Baseline (hash only)
 *   node --experimental-strip-types benchmarks/longmemeval/bench.ts
 * 
 *   # With BGE-M3 via LM Studio
 *   node --experimental-strip-types benchmarks/longmemeval/bench.ts \
 *     --embed-url http://127.0.0.1:1234 --embed-model text-embedding-bge-m3
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const leafmemPath = resolve(import.meta.dirname, "../../dist/index.js");
const { createLeafMem, InMemoryStore } = await import(leafmemPath);

// Also import cosineSimilarity for reranking
const hashEmbPath = resolve(import.meta.dirname, "../../dist/core/hash-embedding.js");
const { cosineSimilarity } = await import(hashEmbPath);

// ── Types ──────────────────────────────────────────────────────────────
type Turn = { role: string; content: string };
type LMEQuestion = {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Record<string, Turn>[];
};

type BenchResult = {
  questionId: string;
  questionType: string;
  question: string;
  groundTruthIds: string[];
  retrievedIds: string[];
  retrievedScores: number[];
  hitAt5: boolean;
  hitAt10: boolean;
  ndcg5: number;
  ndcg10: number;
  elapsedMs: number;
  rank: number | null;
};

// ── Embedding client ───────────────────────────────────────────────────
type EmbedProvider = "openai" | "gemini";

class RemoteEmbedder {
  private readonly provider: EmbedProvider;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly maxChars: number;

  constructor(opts: {
    provider: EmbedProvider;
    baseUrl: string;
    model: string;
    apiKey?: string;
    batchSize?: number;
    maxChars?: number;
  }) {
    this.provider = opts.provider;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey ?? "";
    this.batchSize = opts.batchSize ?? (opts.provider === "gemini" ? 20 : 32);
    this.maxChars = opts.maxChars ?? 4_000;
  }

  async embed(texts: string[], taskType: "query" | "document" = "document"): Promise<number[][]> {
    const truncated = texts.map(t => t.trim().length > 0 ? t.slice(0, this.maxChars) : " ");
    if (this.provider === "gemini") {
      return this.embedGemini(truncated, taskType);
    }
    return this.embedOpenAI(truncated);
  }

  async embedOne(text: string): Promise<number[]> {
    return (await this.embed([text], "query"))[0];
  }

  private async fetchWithRetry(url: string, init: RequestInit, maxRetries: number = 3): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, init);
        if (response.ok) return response;
        if (response.status === 429 || response.status >= 500) {
          const wait = Math.min(2000 * Math.pow(2, attempt), 30000);
          console.warn(`  ⚠ Embedding API ${response.status}, retry in ${wait}ms...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error(`Embedding failed: ${response.status} ${await response.text()}`);
      } catch (err: any) {
        if (attempt < maxRetries && (err.code === 'UND_ERR_SOCKET' || err.cause?.code === 'UND_ERR_SOCKET' || err.message?.includes('fetch failed'))) {
          const wait = Math.min(2000 * Math.pow(2, attempt), 30000);
          console.warn(`  ⚠ Socket error, retry in ${wait}ms...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Max retries exceeded');
  }

  private async embedOpenAI(texts: string[]): Promise<number[][]> {
    const allVectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
      const response = await this.fetchWithRetry(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      const data = (await response.json()) as { data: { embedding: number[] }[] };
      for (const item of data.data) {
        allVectors.push(item.embedding);
      }
    }
    return allVectors;
  }

  private async embedGemini(texts: string[], taskType: "query" | "document"): Promise<number[][]> {
    const geminiTask = taskType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const allVectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const requests = batch.map(text => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: geminiTask,
      }));
      const response = await this.fetchWithRetry(
        `${this.baseUrl}/v1beta/models/${this.model}:batchEmbedContents`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({ requests }),
        },
      );
      const data = (await response.json()) as { embeddings: { values: number[] }[] };
      for (const item of data.embeddings) {
        allVectors.push(item.values);
      }
    }
    return allVectors;
  }
}

// ── Metrics ────────────────────────────────────────────────────────────
function recallAtK(retrievedIds: string[], groundTruthIds: string[], k: number): boolean {
  const topK = new Set(retrievedIds.slice(0, k));
  return groundTruthIds.some(id => topK.has(id));
}

function ndcgAtK(retrievedIds: string[], groundTruthIds: string[], k: number): number {
  const topK = retrievedIds.slice(0, k);
  const gtSet = new Set(groundTruthIds);
  for (let i = 0; i < topK.length; i++) {
    if (gtSet.has(topK[i])) return 1 / Math.log2(i + 2);
  }
  return 0;
}

function findRank(retrievedIds: string[], groundTruthIds: string[]): number | null {
  const gtSet = new Set(groundTruthIds);
  for (let i = 0; i < retrievedIds.length; i++) {
    if (gtSet.has(retrievedIds[i])) return i + 1;
  }
  return null;
}

function buildSessionText(session: Record<string, Turn>, date?: string): string {
  const keys = Object.keys(session).sort((a, b) => Number(a) - Number(b));
  const turns = keys.map(k => `${session[k].role}: ${session[k].content}`);
  return (date ? `[Date: ${date}]\n` : "") + turns.join("\n");
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ── CLI args ───────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let dataPath = resolve(import.meta.dirname, "longmemeval_s_cleaned.json");
  let topK = 10;
  let limit = 0;
  let outputPath = "";
  let weights: Record<string, number> | null = null;
  let embedProvider: EmbedProvider = "openai";
  let embedUrl = "";
  let embedModel = "";
  let embedKey = "";
  let embedBatch = 0;  // 0 = use provider default
  let embedWeight = 0.35;  // default: 65% builtin + 35% vector
  // 2026-08-11: cross-encoder rerank stage mirroring the production pipeline
  // (src/retrieval/manager.ts): widen pool to rerank-top-k, fuse
  // rerankScore * rerank-weight + normalizedBase * (1-rerank-weight),
  // fail-safe to the embedding-fused ordering on any error.
  let rerankUrl = "";
  let rerankModel = "";
  let rerankKey = "";
  let rerankTopK = 40;
  let rerankWeight = 0.6;
  let rerankTimeoutMs = 15_000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data" && args[i + 1]) dataPath = resolve(args[++i]);
    else if (args[i] === "--top-k" && args[i + 1]) topK = parseInt(args[++i], 10);
    else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === "--output" && args[i + 1]) outputPath = resolve(args[++i]);
    else if (args[i] === "--weights" && args[i + 1]) weights = JSON.parse(args[++i]);
    else if (args[i] === "--embed-provider" && args[i + 1]) embedProvider = args[++i] as EmbedProvider;
    else if (args[i] === "--embed-url" && args[i + 1]) embedUrl = args[++i];
    else if (args[i] === "--embed-model" && args[i + 1]) embedModel = args[++i];
    else if (args[i] === "--embed-key" && args[i + 1]) embedKey = args[++i];
    else if (args[i] === "--embed-batch" && args[i + 1]) embedBatch = parseInt(args[++i], 10);
    else if (args[i] === "--embed-weight" && args[i + 1]) embedWeight = parseFloat(args[++i]);
    else if (args[i] === "--rerank-url" && args[i + 1]) rerankUrl = args[++i];
    else if (args[i] === "--rerank-model" && args[i + 1]) rerankModel = args[++i];
    else if (args[i] === "--rerank-key" && args[i + 1]) rerankKey = args[++i];
    else if (args[i] === "--rerank-top-k" && args[i + 1]) rerankTopK = parseInt(args[++i], 10);
    else if (args[i] === "--rerank-weight" && args[i + 1]) rerankWeight = parseFloat(args[++i]);
    else if (args[i] === "--rerank-timeout-ms" && args[i + 1]) rerankTimeoutMs = parseInt(args[++i], 10);
  }

  // Default URLs per provider
  if (!embedUrl) {
    if (embedProvider === "gemini") embedUrl = "https://generativelanguage.googleapis.com";
  }
  if (!embedModel) {
    if (embedProvider === "gemini") embedModel = "gemini-embedding-001";
  }

  if (!outputPath) {
    const ts = new Date().toISOString().replace(/[:-]/g, "").slice(0, 15);
    const embedTag = embedModel ? `_${embedModel.replace(/[^a-zA-Z0-9]/g, "_")}` : "";
    const rerankTag = rerankModel ? `_rerank_${rerankModel.replace(/[^a-zA-Z0-9]/g, "_")}` : "";
    const resultsDir = resolve(import.meta.dirname, "../results");
    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
    outputPath = resolve(resultsDir, `lme_leafmem${embedTag}${rerankTag}_${ts}.jsonl`);
  }

  const embedder = (embedUrl && embedModel) ? new RemoteEmbedder({
    provider: embedProvider,
    baseUrl: embedUrl,
    model: embedModel,
    apiKey: embedKey,
    batchSize: embedBatch || undefined,
  }) : null;
  const reranker = (rerankUrl && rerankModel) ? {
    url: rerankUrl,
    model: rerankModel,
    apiKey: rerankKey || embedKey,
    topK: rerankTopK,
    weight: rerankWeight,
    timeoutMs: rerankTimeoutMs,
  } : null;
  return { dataPath, topK, limit, outputPath, weights, embedder, embedWeight, reranker };
}

// ── Cross-encoder rerank client (mirrors src/retrieval/reranker.ts) ────
async function crossEncoderRerank(
  cfg: { url: string; model: string; apiKey: string; topK: number; timeoutMs: number },
  query: string,
  documents: string[],
): Promise<number[] | null> {
  const docs = documents.map((d) => d.trim()).filter((d) => d.length > 0);
  if (!query.trim() || docs.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        query: query.trim(),
        documents: docs.slice(0, cfg.topK),
        top_n: Math.min(docs.length, cfg.topK),
        return_documents: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      results?: Array<{ index: number; relevance_score: number }>;
    };
    if (!Array.isArray(payload.results) || payload.results.length === 0) return null;
    const scores = new Array<number>(docs.length).fill(-1);
    for (const result of payload.results) {
      if (
        Number.isInteger(result.index) &&
        result.index >= 0 &&
        result.index < scores.length &&
        typeof result.relevance_score === "number"
      ) {
        scores[result.index] = clamp(result.relevance_score, 0, 1);
      }
    }
    return scores;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const rerankTag = opts.reranker ? " + cross-encoder rerank" : "";
  const mode = opts.embedder ? `hybrid (${opts.embedWeight * 100}% vector)${rerankTag}` : "builtin (hash only)";
  console.log(`\n🧠 LeafMem × LongMemEval Benchmark`);
  console.log(`   Mode:    ${mode}`);
  console.log(`   Data:    ${opts.dataPath}`);
  console.log(`   Top-K:   ${opts.topK}`);
  console.log(`   Limit:   ${opts.limit || "all"}`);
  console.log(`   Output:  ${opts.outputPath}\n`);

  const raw = readFileSync(opts.dataPath, "utf-8");
  const questions: LMEQuestion[] = JSON.parse(raw);
  const total = opts.limit > 0 ? Math.min(opts.limit, questions.length) : questions.length;
  console.log(`Loaded ${questions.length} questions, running ${total}\n`);

  const results: BenchResult[] = [];
  const startTime = Date.now();

  for (let qi = 0; qi < total; qi++) {
    const q = questions[qi];
    const qStart = Date.now();

    const memory = createLeafMem({
      store: new InMemoryStore(),
      dedupeThreshold: 1,
      ...(opts.weights ? { searchWeights: opts.weights } : {}),
    });

    // Build session texts for potential embedding
    const sessionTexts: string[] = [];
    const sessionIds: string[] = [];

    for (let si = 0; si < q.haystack_sessions.length; si++) {
      const text = buildSessionText(q.haystack_sessions[si], q.haystack_dates[si]);
      const sid = q.haystack_session_ids[si];
      sessionTexts.push(text);
      sessionIds.push(sid);
      await memory.remember({
        scope: { type: "session", id: sid },
        kind: "session",
        content: text,
        importance: 0.5,
        tags: [],
        metadata: { sessionId: sid, date: q.haystack_dates[si] },
      });
    }

    // Get base hits (larger pool for reranking, but bounded to reduce embedding cost)
    const candidatePool = opts.reranker
      ? Math.max(opts.topK, opts.reranker.topK)
      : opts.embedder ? 20 : Math.max(opts.topK, 10);
    const baseHits = await memory.search(q.question, {
      maxResults: candidatePool,
      minScore: 0,
    });

    let finalHits: { id: string; score: number }[];

    if (opts.embedder && baseHits.length > 0) {
      // 2026-08-11 robustness: if embedding fails for a single question
      // (API 400/timeout/etc.), degrade to builtin ordering for that question
      // instead of aborting the entire 500-question run.
      try {
        // Embed query + all candidate documents
        const queryVec = await opts.embedder.embedOne(q.question);
        const docTexts = baseHits.map((h: any) =>
          [h.record.kind, h.record.content].filter(Boolean).join("\n"),
        );
        const docVecs = await opts.embedder.embed(docTexts);

        // Combine scores: builtin * (1-w) + vector * w
        const builtinWeight = 1 - opts.embedWeight;
        finalHits = baseHits.map((h: any, idx: number) => {
          const vecScore = clamp(cosineSimilarity(queryVec, docVecs[idx] ?? []), 0, 1);
          return {
            id: h.record.scope.id as string,
            score: h.score * builtinWeight + vecScore * opts.embedWeight,
          };
        });
        finalHits.sort((a, b) => b.score - a.score);
      } catch (err) {
        console.warn(`  ⚠ Question ${q.question_id}: embedding failed, using builtin order`);
        finalHits = baseHits.map((h: any) => ({
          id: h.record.scope.id as string,
          score: h.score as number,
        }));
      }
    } else {
      finalHits = baseHits.map((h: any) => ({
        id: h.record.scope.id as string,
        score: h.score as number,
      }));
    }

    // 2026-08-11: cross-encoder rerank stage, mirroring the production
    // pipeline (pool limited to reranker.topK; fuse rerank*0.6 + normalized
    // base*0.4; fail-safe keeps embedding-fused ordering on any failure).
    if (opts.reranker && finalHits.length >= 3) {
      const pool = finalHits.slice(0, opts.reranker.topK);
      const idToRecord = new Map(baseHits.map((h: any) => [h.record.scope.id, h.record]));
      const documents = pool.map((h) => {
        const record = idToRecord.get(h.id) as any;
        return record
          ? [record.kind, record.summary ?? "", record.content, record.tags.join(" "), record.scope.type, record.scope.id].filter(Boolean).join("\n")
          : h.id;
      });
      const scores = await crossEncoderRerank(opts.reranker, q.question, documents);
      if (scores) {
        const maxBase = pool[0]?.score ?? 1;
        finalHits = pool.map((h, index) => {
          const rerankScore = scores[index] ?? 0;
          const normalizedBase = maxBase > 0 ? h.score / maxBase : 0;
          return {
            ...h,
            score: rerankScore * opts.reranker!.weight + normalizedBase * (1 - opts.reranker!.weight),
          };
        }).sort((a, b) => b.score - a.score);
      }
    }

    const retrievedIds = finalHits.map(h => h.id);
    const retrievedScores = finalHits.map(h => h.score);

    const result: BenchResult = {
      questionId: q.question_id,
      questionType: q.question_type,
      question: q.question,
      groundTruthIds: q.answer_session_ids,
      retrievedIds,
      retrievedScores,
      hitAt5: recallAtK(retrievedIds, q.answer_session_ids, 5),
      hitAt10: recallAtK(retrievedIds, q.answer_session_ids, 10),
      ndcg5: ndcgAtK(retrievedIds, q.answer_session_ids, 5),
      ndcg10: ndcgAtK(retrievedIds, q.answer_session_ids, 10),
      elapsedMs: Date.now() - qStart,
      rank: findRank(retrievedIds, q.answer_session_ids),
    };

    results.push(result);
    // 2026-08-11 robustness: append each result incrementally so a mid-run
    // crash (API 400 / network) never loses completed questions.
    writeFileSync(opts.outputPath, results.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");

    const hitSymbol = result.hitAt5 ? "✅" : result.hitAt10 ? "🟡" : "❌";
    if ((qi + 1) % 25 === 0 || qi === total - 1) {
      const running5 = results.filter(r => r.hitAt5).length;
      const running10 = results.filter(r => r.hitAt10).length;
      console.log(
        `[${qi + 1}/${total}] R@5=${(running5 / results.length * 100).toFixed(1)}% R@10=${(running10 / results.length * 100).toFixed(1)}% | last: ${hitSymbol} ${q.question_type} rank=${result.rank ?? "miss"} (${result.elapsedMs}ms)`,
      );
    }
  }

  const totalMs = Date.now() - startTime;

  // ── Summary ──────────────────────────────────────────────────────────
  const hit5 = results.filter(r => r.hitAt5).length;
  const hit10 = results.filter(r => r.hitAt10).length;
  const avgNdcg5 = results.reduce((s, r) => s + r.ndcg5, 0) / results.length;
  const avgNdcg10 = results.reduce((s, r) => s + r.ndcg10, 0) / results.length;

  console.log(`\n${"━".repeat(60)}`);
  console.log(`LeafMem LongMemEval Results [${mode}]`);
  console.log(`${"━".repeat(60)}`);
  console.log(`Questions: ${total}`);
  console.log(`R@5:       ${(hit5 / total * 100).toFixed(1)}% (${hit5}/${total})`);
  console.log(`R@10:      ${(hit10 / total * 100).toFixed(1)}% (${hit10}/${total})`);
  console.log(`NDCG@5:    ${avgNdcg5.toFixed(3)}`);
  console.log(`NDCG@10:   ${avgNdcg10.toFixed(3)}`);
  console.log(`Time:      ${(totalMs / 1000).toFixed(1)}s (${(totalMs / total).toFixed(0)}ms/q)`);
  console.log(`${"━".repeat(60)}`);

  // Per-category breakdown
  const categories = new Map<string, BenchResult[]>();
  for (const r of results) {
    if (!categories.has(r.questionType)) categories.set(r.questionType, []);
    categories.get(r.questionType)!.push(r);
  }
  console.log(`\nPer-category breakdown:`);
  console.log(`${"─".repeat(72)}`);
  console.log(`${"Category".padEnd(28)} ${"Count".padStart(5)} ${"R@5".padStart(7)} ${"R@10".padStart(7)} ${"NDCG@5".padStart(8)} ${"NDCG@10".padStart(8)}`);
  console.log(`${"─".repeat(72)}`);

  const sorted = [...categories.entries()].sort((a, b) => {
    const ra = a[1].filter(r => r.hitAt5).length / a[1].length;
    const rb = b[1].filter(r => r.hitAt5).length / b[1].length;
    return rb - ra;
  });
  for (const [cat, items] of sorted) {
    const h5 = items.filter(r => r.hitAt5).length;
    const h10 = items.filter(r => r.hitAt10).length;
    const n5 = items.reduce((s, r) => s + r.ndcg5, 0) / items.length;
    const n10 = items.reduce((s, r) => s + r.ndcg10, 0) / items.length;
    console.log(
      `${cat.padEnd(28)} ${String(items.length).padStart(5)} ${(h5 / items.length * 100).toFixed(1).padStart(6)}% ${(h10 / items.length * 100).toFixed(1).padStart(6)}% ${n5.toFixed(3).padStart(8)} ${n10.toFixed(3).padStart(8)}`,
    );
  }
  console.log(`${"─".repeat(72)}`);

  // Miss analysis
  const misses = results.filter(r => !r.hitAt10);
  if (misses.length > 0 && misses.length <= 30) {
    console.log(`\nMisses at R@10 (${misses.length}):`);
    for (const m of misses) {
      console.log(`  ${m.questionId} [${m.questionType}] "${m.question.slice(0, 80)}..."`);
    }
  }

  // Write JSONL
  const dir = dirname(opts.outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(opts.outputPath, results.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  console.log(`\nResults written to: ${opts.outputPath}`);
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
