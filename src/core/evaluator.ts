import type { MemoryInferencer } from "../system/types.js";
import { normalizeText, tokenOverlapScore, uniqueTokens } from "./tokenize.js";

// ---------------------------------------------------------------------------
// Evaluation decision types
// ---------------------------------------------------------------------------

export type EvaluationDecision =
  | { action: "add" }
  | { action: "update"; targetId: string; merged: string }
  | { action: "ignore"; reason: string }
  | { action: "contradict"; targetId: string; resolution: string };

export type EvaluationCandidate = {
  id: string;
  content: string;
  kind: string;
  similarity: number;
};

export type EvaluationInput = {
  incoming: { content: string; kind: string; tags: string[] };
  candidates: EvaluationCandidate[];
};

// ---------------------------------------------------------------------------
// Evaluator interface
// ---------------------------------------------------------------------------

export interface MemoryEvaluator {
  evaluate(input: EvaluationInput): Promise<EvaluationDecision>;
}

// ---------------------------------------------------------------------------
// Conservative dedupe evaluator (custom addition, zero LLM dependency)
// ---------------------------------------------------------------------------

/**
 * Conservative write-time gate: rejects near-duplicate writes only.
 *
 * Unlike RuleBasedEvaluator this NEVER overwrites or merges existing records
 * (no update / contradict actions) — it only ignores incoming content that
 * duplicates an existing memory. This prevents garbage accumulation from
 * repeated session commits while keeping every existing record intact.
 *
 * Two signals:
 * 1. Token-overlap similarity >= ignoreThreshold (0.95) → near-identical.
 * 2. Structural prefix match: the 2026-06 playbook imports produced clusters
 *    of records sharing an identical YAML front-matter prefix (e.g.
 *    "---\ndate: ...\ntype: 踩坑\ntags: [未分类") — records whose first 80
 *    characters match an existing record AND share the same kind are treated
 *    as duplicates of that cluster, since the distinguishing body content
 *    belongs in the existing record, not a new one.
 */
export class ConservativeDedupeEvaluator implements MemoryEvaluator {
  private readonly ignoreThreshold: number;
  private readonly prefixLength: number;

  constructor(options?: { ignoreThreshold?: number; prefixLength?: number }) {
    this.ignoreThreshold = options?.ignoreThreshold ?? 0.95;
    this.prefixLength = options?.prefixLength ?? 80;
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationDecision> {
    if (input.candidates.length === 0) {
      return { action: "add" };
    }
    const best = input.candidates.reduce((a, b) =>
      a.similarity > b.similarity ? a : b,
    );
    if (best.similarity >= this.ignoreThreshold) {
      return {
        action: "ignore",
        reason: `Near-duplicate of existing memory (similarity: ${best.similarity.toFixed(2)})`,
      };
    }
    if (this.hasStructuralDuplicate(input.incoming, input.candidates)) {
      return {
        action: "ignore",
        reason: `Structural duplicate: shares front-matter prefix with memory ${best.id}`,
      };
    }
    return { action: "add" };
  }

  private hasStructuralDuplicate(
    incoming: EvaluationInput["incoming"],
    candidates: EvaluationCandidate[],
  ): boolean {
    const incomingPrefix = normalizeText(incoming.content).slice(0, this.prefixLength);
    // Only apply the prefix rule to records that actually have a repeated
    // structural header (starts with "---" front-matter); free-form notes
    // rarely share 80-char prefixes by accident.
    if (!incoming.content.trimStart().startsWith("---") || incomingPrefix.length < this.prefixLength) {
      return false;
    }
    return candidates.some(
      (candidate) =>
        candidate.kind === incoming.kind &&
        normalizeText(candidate.content).slice(0, this.prefixLength) === incomingPrefix,
    );
  }
}

// ---------------------------------------------------------------------------
// Rule-based evaluator (zero LLM dependency)
// ---------------------------------------------------------------------------

const TEMPORAL_MARKERS =
  /\b(now|currently|changed to|switched to|no longer|instead|现在|改成|不再|换成|更换|已经|已改)\b/iu;

/**
 * Rule-based evaluator that handles common cases without LLM:
 * - Near-identical content → ignore (dedupe)
 * - Similar content → update (merge)
 * - Temporal contradiction → contradict (replace)
 * - Otherwise → add
 */
export class RuleBasedEvaluator implements MemoryEvaluator {
  private readonly ignoreThreshold: number;
  private readonly updateThreshold: number;

  constructor(options?: { ignoreThreshold?: number; updateThreshold?: number }) {
    this.ignoreThreshold = options?.ignoreThreshold ?? 0.95;
    this.updateThreshold = options?.updateThreshold ?? 0.75;
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationDecision> {
    if (input.candidates.length === 0) {
      return { action: "add" };
    }

    // Find the best candidate
    const best = input.candidates.reduce((a, b) =>
      a.similarity > b.similarity ? a : b,
    );

    // Near-identical → ignore
    if (best.similarity >= this.ignoreThreshold) {
      return { action: "ignore", reason: `Near-identical to existing memory (similarity: ${best.similarity.toFixed(2)})` };
    }

    // Check for temporal contradiction
    if (best.similarity >= this.updateThreshold && hasTemporalContradiction(input.incoming.content, best.content)) {
      return {
        action: "contradict",
        targetId: best.id,
        resolution: input.incoming.content,
      };
    }

    // Similar enough to merge → update
    if (best.similarity >= this.updateThreshold) {
      return {
        action: "update",
        targetId: best.id,
        merged: input.incoming.content,
      };
    }

    // Different enough → add as new
    return { action: "add" };
  }
}

// ---------------------------------------------------------------------------
// LLM-based evaluator
// ---------------------------------------------------------------------------

const EVALUATION_SYSTEM_PROMPT = `You are a memory evaluation system. Given a NEW memory and EXISTING candidates, decide the action:
- ADD: The new memory is genuinely new information. No existing memory covers this.
- UPDATE <id>: The new memory refines or adds detail to an existing one. Provide the merged content.
- CONTRADICT <id>: The new memory contradicts an existing one (e.g., user changed preference). The new one should replace the old.
- IGNORE: The new memory is a near-duplicate of an existing one.

Respond in JSON: {"action": "add|update|contradict|ignore", "targetId": "<id if update/contradict>", "merged": "<merged content if update>", "resolution": "<new content if contradict>", "reason": "<brief explanation>"}`;

export class LlmEvaluator implements MemoryEvaluator {
  private readonly inferencer: MemoryInferencer;

  constructor(inferencer: MemoryInferencer) {
    this.inferencer = inferencer;
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationDecision> {
    if (input.candidates.length === 0) {
      return { action: "add" };
    }

    const candidateList = input.candidates
      .map((c, i) => `[${i}] id=${c.id} (similarity=${c.similarity.toFixed(2)}): ${c.content}`)
      .join("\n");

    const prompt = `NEW MEMORY (kind: ${input.incoming.kind}, tags: ${input.incoming.tags.join(", ")}):
${input.incoming.content}

EXISTING CANDIDATES:
${candidateList}

Decide the action. Respond in JSON only.`;

    const result = await this.inferencer({
      kind: "evaluation",
      system: EVALUATION_SYSTEM_PROMPT,
      prompt,
      maxChars: 1000,
    });

    if (!result.ok) {
      // Fallback to rule-based on LLM failure
      return new RuleBasedEvaluator().evaluate(input);
    }

    try {
      const parsed = JSON.parse(extractJson(result.text));
      return mapLlmDecision(parsed, input.candidates);
    } catch {
      return new RuleBasedEvaluator().evaluate(input);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasTemporalContradiction(incoming: string, existing: string): boolean {
  // If the incoming content has temporal markers and covers similar topic
  if (!TEMPORAL_MARKERS.test(incoming)) {
    return false;
  }
  // Check if they share significant token overlap (same topic, different state)
  const incomingTokens = uniqueTokens(incoming);
  const existingTokens = uniqueTokens(existing);
  const overlap = tokenOverlapScore(incomingTokens, existingTokens);
  return overlap >= 0.3;
}

function extractJson(text: string): string {
  // Try to extract JSON from markdown code blocks or raw text
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1]!.trim();
  const braces = text.match(/\{[\s\S]*\}/);
  if (braces) return braces[0];
  return text.trim();
}

function mapLlmDecision(
  parsed: Record<string, unknown>,
  candidates: EvaluationCandidate[],
): EvaluationDecision {
  const action = String(parsed.action ?? "add").toLowerCase();
  const targetId = String(parsed.targetId ?? parsed.target_id ?? "");

  if (action === "ignore") {
    return { action: "ignore", reason: String(parsed.reason ?? "LLM decided duplicate") };
  }
  if (action === "update" && targetId) {
    const exists = candidates.some((c) => c.id === targetId);
    if (exists) {
      return {
        action: "update",
        targetId,
        merged: String(parsed.merged ?? parsed.resolution ?? ""),
      };
    }
  }
  if (action === "contradict" && targetId) {
    const exists = candidates.some((c) => c.id === targetId);
    if (exists) {
      return {
        action: "contradict",
        targetId,
        resolution: String(parsed.resolution ?? parsed.merged ?? ""),
      };
    }
  }
  return { action: "add" };
}
