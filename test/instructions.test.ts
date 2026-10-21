import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveIdentityFile, resolveIdentityTarget } from "../src/agents/identity-path.js";
import {
  BLOCK_END,
  BLOCK_START,
  BLOCK_VERSION,
  detectVersion,
  verifySingleBlock,
  versionLine,
  writeMarkedBlock,
} from "../src/agents/marked-block.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "leafmem-blk-"));
}

const block = (body = "RULES") =>
  `${BLOCK_START}\n${versionLine()}\n${body}\n${BLOCK_END}`;

test("append: 首次写入保留原有内容并追加块", async () => {
  const dir = await tmp();
  const file = join(dir, "SOUL.md");
  await writeFile(file, "# SOUL\n\n原有规则 A\n", "utf8");
  const r = await writeMarkedBlock(file, block(), { backupRoot: join(dir, "bk") });
  assert.equal(r.changed, true);
  const text = await readFile(file, "utf8");
  assert.ok(text.startsWith("# SOUL\n\n原有规则 A"), "原有内容必须在前");
  assert.equal(detectVersion(text), BLOCK_VERSION);
  verifySingleBlock(text);
});

test("replace: 替换块且块外内容逐字不变，并生成备份", async () => {
  const dir = await tmp();
  const file = join(dir, "SOUL.md");
  await writeFile(file, `头部\n\n${block("旧规则")}\n\n尾部\n`, "utf8");
  const r = await writeMarkedBlock(file, block("新规则"), { backupRoot: join(dir, "bk") });
  assert.equal(r.changed, true);
  assert.ok(r.backupPath, "必须产生备份");
  const backup = await readFile(r.backupPath!, "utf8");
  assert.ok(backup.includes("旧规则"));
  const text = await readFile(file, "utf8");
  assert.ok(text.startsWith("头部"));
  assert.ok(text.trimEnd().endsWith("尾部"));
  assert.ok(text.includes("新规则"));
  assert.ok(!text.includes("旧规则"));
  verifySingleBlock(text);
});

test("idempotent: 内容相同则不改写", async () => {
  const dir = await tmp();
  const file = join(dir, "SOUL.md");
  await writeMarkedBlock(file, block(), { backupRoot: join(dir, "bk") });
  const second = await writeMarkedBlock(file, block(), { backupRoot: join(dir, "bk") });
  assert.equal(second.changed, false);
});

test("malformed: 只有 start 标记时拒绝写入而不追加第二个块", async () => {
  const dir = await tmp();
  const file = join(dir, "SOUL.md");
  await writeFile(file, `头部\n${BLOCK_START}\n半截\n`, "utf8");
  await assert.rejects(
    () => writeMarkedBlock(file, block(), { backupRoot: join(dir, "bk") }),
    /malformed instruction markers/,
  );
  const text = await readFile(file, "utf8");
  assert.equal(text.split(BLOCK_START).length - 1, 1, "不得追加第二个块");
});

test("empty file: 直接写入块，无备份", async () => {
  const dir = await tmp();
  const file = join(dir, "SOUL.md");
  const r = await writeMarkedBlock(file, block(), { backupRoot: join(dir, "bk") });
  assert.equal(r.changed, true);
  assert.equal(r.backupPath, undefined);
  assert.equal((await readFile(file, "utf8")).trim(), block());
});

test("identity path: 识别 scoped persona 目录并回退", async () => {
  const home = await tmp();
  const base = join(home, ".workbuddy");
  await mkdir(base, { recursive: true });
  // 无 scoped 目录 → 回退
  assert.equal(resolveIdentityFile(home, ".workbuddy", "SOUL.md"), join(base, "SOUL.md"));
  // 建 scoped 目录 + workspace-state.json → 命中
  const scoped = join(base, "user-uuid-personal");
  await mkdir(scoped, { recursive: true });
  await writeFile(join(scoped, "workspace-state.json"), "{}", "utf8");
  await writeFile(join(scoped, "SOUL.md"), "# scoped", "utf8");
  const t = resolveIdentityTarget(home, ".workbuddy", "SOUL.md");
  assert.equal(t.scoped, true);
  assert.equal(t.dir, scoped);
  assert.equal(resolveIdentityFile(home, ".workbuddy", "SOUL.md"), join(scoped, "SOUL.md"));
});

test("identity path: 软链目标存在时写到真实文件（不破坏软链）", async () => {
  const home = await tmp();
  const scoped = join(home, ".workbuddy", "user-x-personal");
  await mkdir(scoped, { recursive: true });
  await writeFile(join(scoped, "SOUL.md"), "# real\n", "utf8");
  const top = join(home, ".workbuddy", "SOUL.md");
  await symlink(join(scoped, "SOUL.md"), top);
  // 写入 via 软链
  const r = await writeMarkedBlock(top, block(), { backupRoot: join(home, "bk") });
  assert.equal(r.changed, true);
  const real = await readFile(join(scoped, "SOUL.md"), "utf8");
  assert.ok(real.includes("RULES"), "必须写到软链指向的真实文件");
});

test("placement=top: 无块时钉在文件顶部（安装器要求块优先于其余规则）", async () => {
  const dir = await tmp();
  const file = join(dir, "SOUL.md");
  await writeFile(file, "# SOUL\n\n- 业务规则\n", "utf8");
  await writeMarkedBlock(file, block("RULES"), { position: "top", backupRoot: join(dir, "bk") });
  const text = await readFile(file, "utf8");
  assert.ok(text.startsWith(BLOCK_START), "块必须位于文件顶部");
  assert.ok(text.trimEnd().endsWith("- 业务规则"), "原有内容必须完整保留在块后");
});
