/**
 * E1/B2（2026-10-22）：写入侧的轻量 enrichment —— eventTime 抽取 + procedural 判定。
 *
 * 为什么放在核心而不是摄入脚本：写入通道有 4 条（MCP memory_write / CLI / HTTP / 摄入脚本），
 * 任何一条漏掉就等于字段覆盖率漏一块。放在 `remember()` 里最内层，所有通道自动覆盖。
 *
 * 三条硬约束：
 * 1. **不覆盖显式值**：调用方给了 metadata.eventTime / status，一律尊重，本模块只填空。
 * 2. **不改变检索行为**：`status=procedural` 当前**不参与过滤**（过滤只认 superseded/archived），
 *    eventTime 也不进打分。B2 是"只补数据、不动排序"，这样基线可以保持零 diff。
 * 3. **纯函数、零 LLM、可离线复算**：所有判定都能用同一份语料重跑，覆盖率必须可复现。
 */

/** eventTime 的取值来源，用于回溯与抽检。 */
export type EventTimeSource = "manual" | "body" | "filename" | "docDate";

export type EventTimeResult = { eventTime: string; source: EventTimeSource };

/** 匹配并规范化成 YYYY-MM-DD；非法日期（月 13、2 月 30）返回 null。 */
function normalizeDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // 反向校验：2 月 30 会被 Date 顺延到 3 月，必须比对回来
  if (parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return null;
  return iso;
}

// 正文/文件名里的日期形态：2026-10-21 / 2026/10/21 / 2026年10月21日 / 2026.10.21
const DATE_PATTERNS: RegExp[] = [
  /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/,
  /(20\d{2})年(\d{1,2})月(\d{1,2})日/,
  /\b(20\d{2})\.(\d{1,2})\.(\d{1,2})\b/,
];

function firstDate(text: string): string | null {
  for (const pattern of DATE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const normalized = normalizeDate(Number(match[1]), Number(match[2]), Number(match[3]));
      if (normalized) return normalized;
    }
  }
  return null;
}

function filenameDate(name: string): string | null {
  return firstDate(name.replace(/\\/g, "/").split("/").pop() ?? "");
}

/**
 * 抽取"事实在世界上为真的时间"。
 *
 * 优先级（前三级来自设计文档 §10.2 的三级回退，另加 explicit 最高优先）：
 *   1. `metadata.eventTime`（人工/上游已给）—— 原样返回，不覆盖
 *   2. **正文**：优先取 daily 面包屑 `[2026-10-21·...]`，否则取正文第一个日期
 *   3. `metadata.docDate`（文档日期）
 *   4. `metadata.source_file` 的文件名日期（`2026-10-21.md`）
 *
 * 🔴 为什么"正文优先于文件名"：正文里的日期是**事件**日期（"8 月那次断链"），
 * 文件名日期是**归档**日期（导入当天）；审计实测 46.9% 的记录两者月份不同，
 * 取文件名会把事件时间整体推后到导入时刻，双时态就白做了。
 *
 * 抽不到返回 null —— 留空仍可见（`isVisibleAt` 对缺失值 fail-open），不阻塞召回。
 */
export function extractEventTime(input: {
  content: string;
  metadata?: Record<string, unknown>;
}): EventTimeResult | null {
  const explicit = input.metadata?.eventTime;
  if (typeof explicit === "string" && explicit.trim()) {
    const src = input.metadata?.eventTimeSrc;
    const allowed: EventTimeSource[] = ["manual", "body", "filename", "docDate"];
    return {
      eventTime: explicit.trim(),
      source: (typeof src === "string" && (allowed as string[]).includes(src)
        ? src
        : "manual") as EventTimeSource,
    };
  }

  const content = input.content ?? "";

  // 2a. daily 面包屑：[2026-10-21·节标题·2/7]（分块器写入的确定性标记，优先于自由文本）
  const crumb = /\[(20\d{2}-\d{2}-\d{2})[·\]]/.exec(content);
  if (crumb) {
    const normalized = firstDate(crumb[1]!);
    if (normalized) return { eventTime: normalized, source: "body" };
  }

  // 2b. 正文第一个日期
  const bodyDate = firstDate(content);
  if (bodyDate) return { eventTime: bodyDate, source: "body" };

  // 3. docDate
  const docDate = input.metadata?.docDate;
  if (typeof docDate === "string") {
    const normalized = firstDate(docDate);
    if (normalized) return { eventTime: normalized, source: "docDate" };
  }

  // 4. 文件名日期
  const sourceFile = input.metadata?.source_file ?? input.metadata?.sourceFile;
  if (typeof sourceFile === "string") {
    const fromName = filenameDate(sourceFile);
    if (fromName) return { eventTime: fromName, source: "filename" };
  }

  return null;
}

/**
 * 过程态标记词（窄口径）。
 *
 * 🔴 为什么不复用审计的宽口径：审计宽口径 13 个词命中 480 条，其中 363 条是
 * "旧版/已废弃/不再适用"这类**合法的技术引用**（例："旧版条例 2017 版已过期，引用前必核"
 * 是纪律，不是过程态）。按宽口径打 procedural 会把有效知识踢出召回。
 * 这里只保留"明确表示此事尚未有结论"的词。
 */
const PROCEDURAL_HINTS = ["待办", "TODO", "todo", "下一步", "待确认", "待定", "未完成"];

/** 结论词：出现任一即说明这条记录已经产出结论，不能判为过程态。 */
const CONCLUSION_HINTS = [
  "已完成",
  "已验",
  "已验证",
  "已修复",
  "已闭环",
  "已确认",
  "已解决",
  "结论",
  "根因",
  "结果：",
];

/**
 * 判定是否为"过程态"（历史待办、未收口的下一步）。
 *
 * 判据＝**含待办词 且 不含结论词**。返回 undefined 表示不判定（保持缺省 active）。
 * 注意：本函数只产出标记，**不参与检索过滤**（procedural 仍在召回范围内），
 * 是否过滤由调用方按场景决定——避免一处打标把知识静默踢出。
 */
export function classifyStatus(input: {
  content: string;
  summary?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}): "procedural" | undefined {
  // 显式指定优先
  if (typeof input.metadata?.status === "string" && input.metadata.status.trim()) return undefined;
  // 蒸馏产物（principle）与用户画像类不是过程态；它们本身就是结论
  if (input.kind === "principle" || input.kind === "preference") return undefined;

  const text = `${input.content ?? ""}\n${input.summary ?? ""}`;
  const hasHint = PROCEDURAL_HINTS.some((word) => text.includes(word));
  if (!hasHint) return undefined;
  const hasConclusion = CONCLUSION_HINTS.some((word) => text.includes(word));
  return hasConclusion ? undefined : "procedural";
}

/**
 * 给一条待写入记录算 enrichment。返回需要合并进 metadata 的字段（可能为空对象）。
 * 只填空：已存在的 eventTime / status 一律保留。
 */
export function buildEnrichment(input: {
  content: string;
  summary?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const metadata = input.metadata ?? {};
  if (metadata.eventTime === undefined) {
    const extracted = extractEventTime({ content: input.content, metadata });
    if (extracted) {
      patch.eventTime = extracted.eventTime;
      patch.eventTimeSrc = extracted.source;
    }
  }
  if (metadata.status === undefined) {
    const status = classifyStatus(input);
    if (status) patch.status = status;
  }
  return patch;
}
