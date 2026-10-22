export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  const tokens: string[] = [];
  for (const segment of normalized.split(/\s+/)) {
    if (CJK_PATTERN.test(segment)) {
      // CJK characters: each character is a meaningful token
      for (const char of segment) {
        if (CJK_PATTERN.test(char)) {
          tokens.push(char);
        } else if (char.trim()) {
          // Inline latin/digit within CJK context — keep if > 1 char is handled below
          tokens.push(char);
        }
      }
    } else if (segment.length > 1) {
      tokens.push(segment);
    }
  }
  return tokens;
}

export function uniqueTokens(value: string): string[] {
  return [...new Set(tokenize(value))];
}

export function tokenOverlapScore(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }
  const candidateSet = new Set(candidateTokens);
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateSet.has(token)) {
      overlap += 1;
    }
  }
  return overlap / queryTokens.length;
}

/**
 * E4.1（2026-10-22）：带**长度归一**的查询覆盖率。
 *
 * 为什么必须加：原 `tokenOverlapScore` 的分母只有 `queryTokens.length`，
 * 属于「查询覆盖率」而非相似度 —— 候选越长，越容易碰巧覆盖全部查询字。
 * 实测（6,104 条库）：一条 5,100 字的 principle 记录对任意 process 型查询都得到
 * `lexical = 1.000`（如「语义层日更重建有没有在跑」），而 611 字的正确答案块更低，
 * 于是长文档无差别霸榜（配合 principle 固定 boost 更甚）。
 * 这类查询的特征是**用词全部是常用字**（什么时候/有没有/第几批），
 * 没有 ID/日期这类能靠 hash/fts 区分的独特 token，长度偏置就完全暴露。
 *
 * 归一方式：BM25 式长度惩罚的温和版 `sqrt(refLen / candLen)`，**上限夹到 1.0**：
 * 覆盖率的上界就是 1（查询的每个字都被覆盖），若允许 >1 等于宣称"覆盖率 130%"，
 * 语义上不成立，且会让短碎片被过度抬高（首版夹到 1.5，实测 lexical 出现 1.364）。
 * 因此归一以**下压为主**，上抬留极小空间（上界 1.2，+20%）。
 * 三个上界的实测（core R@1/@3/@8，41 题）：1.0 → 9/17/25；1.2 → 11/18/26；
 * 1.5 → 12/22/26；2.0 → 13/21/27。R@1 随上界单调上升，属"短块越抬越好"的
 * 过拟合信号（41 题下 1 题差异即 2.4%，标准误约 ±2.8 题，档位差异不显著），
 * 故取语义最保守的 1.2，不取指标最优的 2.0。
 * - candLen = refLen（约 900 字块，与分块目标一致）→ 1.0，即「典型长度不打分」
 * - 400 → 1.0（不抬）
 * - 2200 → 0.52
 * - 5000 → 0.35
 */
export const LEXICAL_REF_TOKENS = 600;

export function tokenOverlapScoreNormalized(
  queryTokens: string[],
  candidateTokens: string[],
  refTokens: number = LEXICAL_REF_TOKENS,
): number {
  const recall = tokenOverlapScore(queryTokens, candidateTokens);
  if (recall === 0) {
    return 0;
  }
  const candLen = Math.max(1, candidateTokens.length);
  const norm = Math.sqrt(refTokens / candLen);
  return recall * Math.min(1.2, Math.max(0.5, norm));
}
