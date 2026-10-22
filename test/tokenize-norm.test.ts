import test from "node:test";
import assert from "node:assert/strict";

import {
  tokenOverlapScore,
  tokenOverlapScoreNormalized,
  LEXICAL_REF_TOKENS,
} from "../src/core/tokenize.js";

test("E4.1: 长度归一压制长文档（同一查询，长文档覆盖率虚高被纠正）", () => {
  const query = ["备", "份", "断", "链"];
  // 短文档：覆盖 3/4
  const short = ["备", "份", "断", "x", "y"];
  // 长文档：覆盖 4/4，但有 2000 个 token（真实库里 5,100 字的 principle 记录就是这样拿到 lexical=1.0 的）
  const long = [...query, ...Array.from({ length: 2000 }, (_, i) => `t${i}`)];

  const rawShort = tokenOverlapScore(query, short);
  const rawLong = tokenOverlapScore(query, long);
  assert.equal(rawShort, 0.75);
  assert.equal(rawLong, 1, "原实现：长文档覆盖率恒为 1（纯长度偏置）");

  const normShort = tokenOverlapScoreNormalized(query, short);
  const normLong = tokenOverlapScoreNormalized(query, long);
  assert.ok(
    normShort > normLong,
    `归一后短文档应高于长文档（实际 ${normShort.toFixed(3)} vs ${normLong.toFixed(3)}）`,
  );
  // sqrt(600/2004) ≈ 0.547 ⇒ 2000 token 的文档覆盖率从 1.0 压到 ≈0.55（-45%）。
  // 不是压到地板 0.5 —— 「显著」的量化含义就是这 -45%，足够让 0.45 权重下的
  // 贡献从 0.45 降到 0.25（实测该幅度足以翻转被无关长文档占住的席位）。
  assert.ok(normLong < 0.6, `2000 token 文档应被压到 0.6 以下（实际 ${normLong.toFixed(3)}）`);
});

test("E4.1: 长度归一只压不抬（上界 1.2，不出现覆盖率 >100% 的语义错误）", () => {
  const query = ["a", "b"];
  // 极短文档：两个 token 全覆盖，长度远小于参考长度
  const tiny = ["a", "b"];
  const score = tokenOverlapScoreNormalized(query, tiny);
  assert.ok(score <= 1.2, `上抬必须有界（实际 ${score}）`);
  assert.ok(score >= 1, "参考长度以下的文档允许微抬，但不超过 1.2");
});

test("E4.1: 归一不改变零重叠与空输入的结果", () => {
  assert.equal(tokenOverlapScoreNormalized(["a"], ["b"]), 0);
  assert.equal(tokenOverlapScoreNormalized([], ["a"]), 0);
  assert.equal(tokenOverlapScoreNormalized(["a"], []), 0);
  assert.equal(LEXICAL_REF_TOKENS, 600);
});

test("E4.1: 参考长度的文档归一因子为 1（典型块不打分）", () => {
  const query = ["a", "b", "c", "d"];
  const typical = [...query, ...Array.from({ length: LEXICAL_REF_TOKENS - query.length }, (_, i) => `z${i}`)];
  const score = tokenOverlapScoreNormalized(query, typical);
  assert.equal(score, 1, "candLen == refLen 时归一因子应为 1.0，不改变原值");
});

// ---------------------------------------------------------------------------
// E4.2（2026-10-22）：短语级匹配（3-gram）
// ---------------------------------------------------------------------------

test("E4.2: trigrams 忽略空白并产出连续 3-gram", async () => {
  const { trigrams } = await import("../src/core/tokenize.js");
  assert.deepEqual([...trigrams("abc")], ["abc"]);
  assert.deepEqual([...trigrams("a b c")], ["abc"], "空白应被剔除");
  assert.equal(trigrams("ab").size, 0, "短于 3 字无 gram");
  // n 个字共有 n-2 个连续 3-gram：「语义层日更重建」7 字 → 5 个
  assert.equal(trigrams("语义层日更重建").size, 5);
  assert.equal(trigrams("本体语义层项目").size, 5);
  // 8 字 → 6 个（题注里「连续 8 字命中产生 6 个 3-gram」即此）
  assert.equal(trigrams("本体语义层项目Phase".slice(0, 8)).size, 6);
});

test("E4.2: 短语连续命中 > 散字碰巧覆盖（这正是该信号的存在理由）", async () => {
  const { trigrams, trigramCoverage, tokenOverlapScoreNormalized } = await import("../src/core/tokenize.js");
  const query = "语义层日更重建有没有在跑";
  // A：真实同主题块（section 含「语义层日更重建」）
  const relevant = "04:30 语义层日更重建（automation 4fe71397）";
  // B：长原则文档，散字覆盖但无该短语（真实库里 5,100 字记录的情况）
  const irrelevant =
    "重建判断标准时必须先自审口径，语义是否一致取决于层级，日更与周更不可混谈" + "无关填充".repeat(300);

  const covRelevant = trigramCoverage(trigrams(query), trigrams(relevant));
  const covIrrelevant = trigramCoverage(trigrams(query), trigrams(irrelevant));
  assert.ok(
    covRelevant > covIrrelevant * 2,
    `短语覆盖率应显著区分（relevant=${covRelevant.toFixed(3)} vs irrelevant=${covIrrelevant.toFixed(3)}）`,
  );
  // 对照：散字覆盖率对两者都不低（说明单靠 lexical 分不开）
  const lexRelevant = tokenOverlapScoreNormalized([...query], [...new Set(relevant)]);
  const lexIrrelevant = tokenOverlapScoreNormalized([...query], [...new Set(irrelevant)]);
  assert.ok(lexIrrelevant > 0.5, "长文档的散字覆盖率本就很高——这是需要短语信号的证据");
});
