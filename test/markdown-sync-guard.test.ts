/**
 * Guard tests for the destructive markdown-list primitive.
 *
 * 2026-10-21: SOUL.md/USER.md/MEMORY.md are user-authoritative. The projection
 * primitive overwrites a whole file from a rendered list capped at 1,375/2,200 chars,
 * so calling it on a 30KB identity file silently destroys content. These tests pin the
 * refusal behaviour.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeMarkdownListFile } from "../src/adapters/markdown-sync.js";

async function tmpFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "leafmem-md-"));
  const file = join(dir, "SOUL.md");
  await writeFile(file, content, "utf8");
  return file;
}

test("guard: 拒绝把 30KB 身份文件截断成 1.4KB", async () => {
  const big = `# SOUL\n\n${"- 规则条目，占位用于放大文件。\n".repeat(600)}`;
  const file = await tmpFile(big);
  await assert.rejects(
    () => writeMarkdownListFile(file, ["- 只保留这一条"], 1375),
    /refusing to shrink/,
  );
  assert.equal((await readFile(file, "utf8")).length, big.length, "原文件必须保持不变");
});

test("guard: 拒绝把非空文件清空", async () => {
  const file = await tmpFile("# SOUL\n\n- 规则\n");
  await assert.rejects(() => writeMarkdownListFile(file, [], 1375), /refusing to blank/);
});

test("guard: 显式 allowShrink 才允许大幅缩小", async () => {
  const big = "# SOUL\n" + "- 条目\n".repeat(400);
  const file = await tmpFile(big);
  await writeMarkdownListFile(file, ["- 唯一保留项"], 1375, { allowShrink: true });
  assert.match(await readFile(file, "utf8"), /唯一保留项/);
});

test("guard: 正常扩容/首次写入不受影响", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leafmem-md-new-"));
  const file = join(dir, "MEMORY.md");
  await writeMarkdownListFile(file, ["- 第一条"], 1375);
  assert.match(await readFile(file, "utf8"), /第一条/);
});
