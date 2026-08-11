import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownEntries } from "../src/adapters/markdown-sync.js";

// 2026-08-11: import sharding incident — structural symbols and orphan
// headings were imported as fragments; nested bullets were split into
// incomplete shards; literal credentials entered the DB.

test("structural dividers are never imported", () => {
  const entries = parseMarkdownEntries("# T\n\npara one\n\n---\n\npara two\n\n***\n");
  assert.deepEqual(entries, ["para one", "para two"]);
});

test("orphan bold headings prefix the next entry instead of standing alone", () => {
  const entries = parseMarkdownEntries(
    "**发布能力**\n订阅号无法通过 API 发布，只能存草稿，需小龙手动发布\n",
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0], "**发布能力** 订阅号无法通过 API 发布，只能存草稿，需小龙手动发布");
});

test("orphan heading ending with colon prefixes the next bullet", () => {
  const entries = parseMarkdownEntries("**硬规则**：\n- 正文≥100字\n- 至少1个主题标签\n");
  assert.deepEqual(entries, ["**硬规则**： 正文≥100字", "**硬规则**： 至少1个主题标签"]);
});

test("trailing orphan heading with no following entry is dropped", () => {
  const entries = parseMarkdownEntries("para\n\n**封面图**\n");
  assert.deepEqual(entries, ["para"]);
});

test("nested bullets merge into their parent entry (no sharding)", () => {
  const md = [
    "- 每次开始新会话时，按顺序执行：",
    "  1. recall",
    "  2. read MEMORY.md",
    "- top level two",
  ].join("\n");
  const entries = parseMarkdownEntries(md);
  assert.deepEqual(entries, [
    "每次开始新会话时，按顺序执行： 1. recall 2. read MEMORY.md",
    "top level two",
  ]);
});

test("bullet lines keep top-level bullets as separate entries", () => {
  const entries = parseMarkdownEntries("- a\n- b\n");
  assert.deepEqual(entries, ["a", "b"]);
});

test("bullet wrapping a structural symbol is dropped (\"- ---\")", () => {
  const entries = parseMarkdownEntries("- fact one\n- ---\n- fact two\n");
  assert.deepEqual(entries, ["fact one", "fact two"]);
});

test("bare-word lead line becomes a prefix, not an entry (\"Notes:\")", () => {
  const entries = parseMarkdownEntries("Notes:\n- keep the scope discipline\n");
  assert.deepEqual(entries, ["Notes: keep the scope discipline"]);
});

test("colon-ended lead line prefixes its bullets", () => {
  const entries = parseMarkdownEntries("主动服务分为两类：\n- 事件驱动\n- 周期巡检\n");
  assert.deepEqual(entries, ["主动服务分为两类： 事件驱动", "主动服务分为两类： 周期巡检"]);
});

test("sub-headings (##) prefix following entries for self-containment", () => {
  const entries = parseMarkdownEntries("## 形象规范\n\n**对外介绍语**\n我是小虾。\n");
  assert.deepEqual(entries, ["**对外介绍语** 我是小虾。"]);
});

test("frontmatter at file top is still skipped", () => {
  const entries = parseMarkdownEntries("---\nsummary: x\nread_when:\n  - y\n---\n\nfirst fact\n");
  assert.deepEqual(entries, ["first fact"]);
});

test("literal local credentials are kept as-is (single-machine library)", () => {
  // 2026-08-11: the memory library is local-only; the user's own discipline
  // files legitimately carry credentials they chose to record. No masking.
  const entries = parseMarkdownEntries("**sudo 密码**：`0000`\n");
  assert.deepEqual(entries, ["**sudo 密码**：`0000`"]);
});

test("full discipline-file sample yields no sub-20-char fragments", () => {
  const md = [
    "---",
    "summary: agent identity",
    "---",
    "",
    "## 工作风格",
    "",
    "**严谨直接** — 输出准确有据可查。",
    "",
    "### 能力边界",
    "",
    "**字数限制**",
    "JSON 总大小限制约 21000 字符",
    "",
    "**sudo 密码**：`0000`",
  ].join("\n");
  const entries = parseMarkdownEntries(md);
  // No structural-symbol or orphan-heading fragments.
  assert.ok(entries.every((e) => !/^(-{3,}|\*{3,}|_{3,})$/.test(e)), JSON.stringify(entries));
  assert.ok(entries.every((e) => !/^(\*\*|__)[^*_]+(\*\*|__)[：:]?$/.test(e)), JSON.stringify(entries));
  // The credential line stays verbatim (local-only library, no masking).
  assert.ok(entries.includes("**sudo 密码**：`0000`"));
  // The heading + its fact merged into one self-contained entry.
  assert.ok(entries.includes("**字数限制** JSON 总大小限制约 21000 字符"));
});
