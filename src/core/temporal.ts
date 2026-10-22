/**
 * E1（2026-10-22）：轻双时态与生命周期字段的**读取侧**工具。
 *
 * 背景：LeafMem 过去只有 createdAt/updatedAt（"时钟"），没有"日历"——
 * 审计实测 46.9% 的条目正文日期 ≠ 记录月（批量导入把 created_at 写成了导入时刻），
 * 问"8 月那次断链的根因"只能靠词法撞运气。
 *
 * 设计约束（见 plans/记忆结构v2-分层与轻双时态-20261022.md）：
 * - **零 DDL**：全部字段放 metadata（JSON），旧读者无感、可随时回退；
 * - **零 LLM**：eventTime 由规则抽取（B2 落地写入侧），本文件只负责读；
 * - 字段一律 camelCase，与既有 `supersededBy` / `lastRecalledAt` 保持一致——
 *   同族字段出现两套命名会导致读取端各查一半（本项目 08-31 事故同族）。
 *
 * 语义边界（易混，必须记清）：
 * - `eventTime`    ：事实在世界上**为真**的时间（正文说"8 月"，就是 8 月）
 * - `createdAt`    ：记录**写入**时间（导入时刻，可能远晚于 eventTime）
 * - `invalidAt`    ：事实**失效**时刻（过期即不再为真）
 * - `supersededBy` ：被**替代**（有后继记录），与 invalidAt 是两件事，过滤用 OR
 */

/** 记忆生命周期状态。缺省视为 active。 */
export type MemoryStatus = "active" | "procedural" | "superseded" | "archived";

const STATUS_VALUES: ReadonlySet<string> = new Set([
  "active",
  "procedural",
  "superseded",
  "archived",
]);

/** 读取记录状态；无法识别的一律按 active 处理（宁多召回，不误杀）。 */
export function statusOf(record: { metadata?: Record<string, unknown> }): MemoryStatus {
  const raw = record.metadata?.status;
  if (typeof raw !== "string") return "active";
  const normalized = raw.trim().toLowerCase();
  return (STATUS_VALUES.has(normalized) ? normalized : "active") as MemoryStatus;
}

/**
 * 是否已退出"当前事实"集合。
 *
 * 注意与 `procedural` 的区别：procedural（历史待办/过程态）**不在**此处过滤——
 * 是否排除过程态由调用方按场景决定（B2 打标后才启用），且需窄口径（审计宽口径 480 条
 * 里有 363 条是"旧版/已废弃"这类合法技术引用，误杀会丢知识）。
 */
export function isInactive(record: { metadata?: Record<string, unknown> }): boolean {
  const status = statusOf(record);
  if (status === "superseded" || status === "archived") return true;
  // 兼容 08-31 起的既有约定：`supersededBy` 表示"已有后继记录"（可能没写 status）。
  // 值可能是单个 id 字符串，也可能是 id 数组（E1 允许一节拆多块 → 多后继），
  // 读取端必须两种都认（设计文档 §11.6：统一 Array.isArray 归一）。
  const supersededBy = record.metadata?.supersededBy;
  if (Array.isArray(supersededBy)) return supersededBy.length > 0;
  if (typeof supersededBy === "string") return supersededBy.trim().length > 0;
  return false;
}

/** 事实为真的时间（ISO）。缺失返回 null —— 缺失不等于"未来"，见 isVisibleAt。 */
export function eventTimeOf(record: { metadata?: Record<string, unknown> }): string | null {
  const raw = record.metadata?.eventTime;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * as-of 可见性：在该时点上，这条记忆描述的事实是否已经成立。
 *
 * 🔴 缺失 eventTime 时必须**视为可见**：否则一次 as_of 查询会把 12.5% 无时间戳的
 * 记忆整体排除（B0.7 之前的审计口径：5018 条里仅 87.5% 可抽取 eventTime）。
 * "未知时间"按"不知道它是不是未来"处理，宁可多给一条也不能凭空删掉。
 */
export function isVisibleAt(
  record: { metadata?: Record<string, unknown> },
  asOf: string,
): boolean {
  const eventTime = eventTimeOf(record);
  if (!eventTime) return true;
  const asOfMs = Date.parse(asOf);
  const eventMs = Date.parse(eventTime);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(eventMs)) return true;
  return eventMs <= asOfMs;
}

/** 时间排序键：优先 eventTime，缺失退回 createdAt。 */
export function temporalSortKey(record: {
  metadata?: Record<string, unknown>;
  createdAt: string;
}): number {
  const eventTime = eventTimeOf(record);
  const ms = Date.parse(eventTime ?? record.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** 默认检索可见性判据（B1）：未显式要求时排除 superseded/archived，并按 asOf 切片。 */
export function isSearchable(
  record: { metadata?: Record<string, unknown> },
  options: { includeInactive?: boolean; asOf?: string } = {},
): boolean {
  if (!options.includeInactive && isInactive(record)) return false;
  if (options.asOf && !isVisibleAt(record, options.asOf)) return false;
  return true;
}
