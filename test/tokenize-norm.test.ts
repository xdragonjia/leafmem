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
