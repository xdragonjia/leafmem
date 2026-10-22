import test from "node:test";
import assert from "node:assert/strict";
import { createLeafMem, InMemoryStore } from "../src/core/index.js";
import { buildEnrichment, classifyStatus, extractEventTime } from "../src/core/enrich.js";

// ---------------------------------------------------------------------------
// B2（2026-10-22）：写入侧 enrichment —— eventTime 抽取与 procedural 判定
// ---------------------------------------------------------------------------

test("eventTime: 显式 metadata 优先且不被覆盖，来源保持", () => {
  const out = extractEventTime({
    content: "正文里写着 2026-09-01，但调用方已指定 eventTime。",
    metadata: { eventTime: "2026-08-15", eventTimeSrc: "manual" },
  });
  assert.equal(out?.eventTime, "2026-08-15");
  assert.equal(out?.source, "manual");
});

test("eventTime: daily 面包屑优先于正文其他日期（分块器写入的确定性标记）", () => {
  const out = extractEventTime({
    content: "[2026-10-21·收口补正·2/7] 上次 2026-08-12 那次断链的根因是 state 未留存。",
  });
  assert.equal(out?.eventTime, "2026-10-21", "面包屑日期才是本条的归档/事件日");
  assert.equal(out?.source, "body");
});

test("eventTime: 支持 年-月-日 / 斜杠 / 中文 / 点分 四种形态", () => {
  const cases: Array<[string, string]> = [
    ["2026-10-21 完成巡检", "2026-10-21"],
    ["2026/3/7 部署", "2026-03-07"],
    ["2026年10月5日 复盘", "2026-10-05"],
    ["2026.07.09 上线", "2026-07-09"],
  ];
  for (const [text, want] of cases) {
    assert.equal(extractEventTime({ content: text })?.eventTime, want, text);
  }
});

test("eventTime: 非法日期不采信（2 月 30 会被 Date 顺延，必须回验）", () => {
  const out = extractEventTime({
    content: "2026-02-30 明显是笔误的一天。",
    metadata: { docDate: "2026-03-02" },
  });
  assert.equal(out?.eventTime, "2026-03-02", "正文非法日期应回退到 docDate");
  assert.equal(out?.source, "docDate");
});

test("eventTime: 正文优先于文件名（文件名是归档日，不是事件日）", () => {
  const out = extractEventTime({
    content: "8 月那次断链发生在 2026-08-12。",
    metadata: { source_file: "/x/memory/2026-10-21.md" },
  });
  assert.equal(out?.eventTime, "2026-08-12");
  assert.equal(out?.source, "body");
});

test("eventTime: 正文无日期时回退到文件名；都没有则留空（不猜）", () => {
  const fromName = extractEventTime({
    content: "今天把镜像清理了一轮。",
    metadata: { source_file: "/x/memory/2026-10-21.md" },
  });
  assert.equal(fromName?.eventTime, "2026-10-21");
  assert.equal(fromName?.source, "filename");

  assert.equal(extractEventTime({ content: "完全没有日期的记录。" }), null);
});

test("procedural: 有待办词且无结论词 → procedural；有结论词 → 不判定", () => {
  assert.equal(
    classifyStatus({ content: "下一步：明天继续排查备份断链。", kind: "experience" }),
    "procedural",
  );
  assert.equal(
    classifyStatus({ content: "待办：明天继续排查。已经验证根因是 state 未留存。", kind: "experience" }),
    undefined,
    "有结论词说明已收口，不能判为过程态",
  );
});

test("procedural: 蒸馏产物与用户偏好不打标；显式 status 优先", () => {
  assert.equal(classifyStatus({ content: "待办：补充判据。", kind: "principle" }), undefined);
  assert.equal(classifyStatus({ content: "待办：补充判据。", kind: "preference" }), undefined);
  assert.equal(
    classifyStatus({ content: "待办：补充判据。", kind: "note", metadata: { status: "active" } }),
    undefined,
    "调用方显式指定 status 时不覆盖",
  );
});

test("buildEnrichment: 只填空，不覆盖既有字段", () => {
  const patch = buildEnrichment({
    content: "2026-10-20 的巡检结论：全部正常。",
    kind: "experience",
    metadata: { eventTime: "2026-10-19", status: "archived", source_file: "2026-10-21.md" },
  });
  assert.deepEqual(patch, {}, "既有 eventTime/status 都不应被改写");
});

test("remember 集成：新建记录自动带 eventTime，且不改动检索排序", async () => {
  const memory = createLeafMem({ store: new InMemoryStore() });
  const scope = { type: "agent" as const, id: "workbuddy" };
  const rec = await memory.remember({
    scope,
    kind: "experience",
    content: "2026-09-30 完成一次全量备份校验，结论是全部可读。",
    dedupe: false,
  });
  assert.equal(rec.metadata?.eventTime, "2026-09-30");
  assert.equal(rec.metadata?.eventTimeSrc, "body");

  const open = await memory.remember({
    scope,
    kind: "experience",
    content: "下一步：下周把备份脚本的 state 文件补齐。",
    dedupe: false,
  });
  assert.equal(open.metadata?.status, "procedural");
  // procedural 仍在召回范围内（只打标不过滤）——避免一处打标把知识静默踢出
  const hits = await memory.search("备份脚本 state 文件补齐", { scopes: [scope] });
  assert.ok(hits.some((hit) => hit.record.id === open.id), "procedural 不应被默认过滤");
});
