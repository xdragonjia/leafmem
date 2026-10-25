import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeLlmEntities, type RawLlmEntity } from "../src/entity/extractor.ts";

const vocab = [
  { name: "贾小龙", kind: "person" as const },
  { name: "韩丽敏", kind: "person" as const },
  { name: "丁楠", kind: "person" as const },
  { name: "昆仑数智科技有限责任公司", kind: "org" as const },
];

const P = (name: string): RawLlmEntity => ({ name, kind: "person" });

test("sanitize: 拒绝实测 person 噪声（周日/keyframes/master/lark/格式/用户名/栏目名）", () => {
  const noisy = [
    "周日", "keyframes", "master", "lark", "path", "page", "mavis",
    "格式", "名称", "用户名", "通知给", "基层动态", "通知公告", "合规风控",
  ];
  const out = sanitizeLlmEntities(noisy.map(P), vocab);
  assert.deepEqual(out, []);
});

test("sanitize: 保留真人（含少数民族名/首字母大写英文名/词表命中）", () => {
  const out = sanitizeLlmEntities(
    [P("贾小龙"), P("韩丽敏"), P("图尔荪江·麦麦提"), P("Alice Smith"), P("丁楠")],
    vocab,
  );
  assert.deepEqual(out.map((e) => e.name).sort(), ["Alice Smith", "丁楠", "图尔荪江·麦麦提", "韩丽敏", "贾小龙"].sort());
});

test("sanitize: 词表覆盖 LLM 类型判断（丁楠 被判断为 project → person）", () => {
  const out = sanitizeLlmEntities([{ name: "丁楠", kind: "project" }], vocab);
  assert.equal(out[0]?.kind, "person");
});

test("sanitize: org 拒绝域名/文件名，保留真实机构", () => {
  const out = sanitizeLlmEntities(
    [
      { name: "qq.com", kind: "org" },
      { name: "2026-05-17.md", kind: "org" },
      { name: "modal.clustered", kind: "org" },
      { name: "昆仑数智科技有限责任公司", kind: "org" },
    ],
    vocab,
  );
  assert.deepEqual(out.map((e) => e.name), ["昆仑数智科技有限责任公司"]);
});

test("sanitize: 去重且保留 aliases", () => {
  const out = sanitizeLlmEntities(
    [{ name: "贾小龙", kind: "person", aliases: ["dragonjia"] }, P("贾小龙")],
    vocab,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].aliases, ["dragonjia"]);
});

test("sanitize: 未知 kind / 空名 / 超长名 一律丢弃", () => {
  const out = sanitizeLlmEntities(
    [{ name: "", kind: "person" }, { name: "x", kind: "person" }, { name: "张三丰", kind: "weird" }, { name: "一".repeat(41), kind: "project" }],
    vocab,
  );
  assert.deepEqual(out, []);
});
