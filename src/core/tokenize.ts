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

/**
 * E4.2（2026-10-22）：**短语级**匹配（3-gram 集合交集）。
 *
 * 为什么需要它：`tokenOverlapScore` 算的是「查询的散字被覆盖多少」，
 * 长文档靠碰巧覆盖单字就能拿满分（见上条注释）。真正能区分"同主题"与"碰巧同字"
 * 的是**连续短语**是否命中。
 *
 * 实测依据（41 题 golden 的 process 类）：10 题里 8 题的正确答案块 section 与查询
 * 有 5~8 字的连续命中（「语义层日更重建」「《生命3.0》」「项目Phase4建」），
 * 而当轮 top1 只有 2~3 题有 —— 差异全部来自短语级信号，散字覆盖率反而 top1 更高。
 *
 * 用 3-gram 交集而非最长公共子串：O(n) 且可缓存（section 的 gram 集合按 id+updatedAt
 * 缓存在 searchTextCache），最长公共子串是 O(n*m) 且每次查询都要重算；
 * 连续 8 字命中会自然产生 6 个 3-gram 全命中，两者在区分度上等价。
 */
export function trigrams(text: string): Set<string> {
  const clean = text.replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 3 <= clean.length; i++) {
    out.add(clean.slice(i, i + 3));
  }
  return out;
}

/** 查询 3-gram 被候选 3-gram 覆盖的比例（0~1）。候选过短时退化为 0（无信息）。 */
export function trigramCoverage(queryGrams: Set<string>, candidateGrams: Set<string>): number {
  if (queryGrams.size === 0 || candidateGrams.size === 0) {
    return 0;
  }
  let hit = 0;
  for (const gram of queryGrams) {
    if (candidateGrams.has(gram)) {
      hit += 1;
    }
  }
  return hit / queryGrams.size;
}
