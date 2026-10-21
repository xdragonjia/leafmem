/**
 * Contract test for the injected discipline block.
 *
 * The block is the product's behavioural contract with every host. It is also the
 * single biggest thing we inject into SOUL.md, so we compress it — and compression
 * is exactly where a load-bearing rule silently disappears (2026-10-21: three rounds
 * of SOUL compression dropped 9 rules before the red-team pass caught them).
 *
 * This test is the mechanical judge: every token below has been manually verified as
 * "if this disappears, the agent misbehaves". Adding a bullet is cheap; deleting one
 * without updating this list should fail CI.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { workBuddyInstructionBlock } from "../src/adapters/workbuddy.js";
import { BLOCK_END, BLOCK_START, BLOCK_VERSION, detectVersion } from "../src/agents/marked-block.js";

const block = workBuddyInstructionBlock("node /path/leafmem-agent.js update workbuddy", "workbuddy");

/** Tool names: without them the agent invents calls that do not exist. */
const TOOL_TOKENS = ["memory_recall", "memory_write", "memory_govern", "memory_organize"];

/** Actions / required params: dropping one produces a rejected or useless call. */
const CALL_TOKENS = [
  'action:"recall"',
  "action:\"remember\"",
  'action:"task_append"',
  'action:"commit"',
  'action:"apply"',
  "`agent`",
  "`sessionId`",
  "`rollingSummary`",
  "status:\"active\"",
  "maintenanceRequest",
];

/** Hard rules that prevent data corruption / provenance rot. */
const DISCIPLINE_TOKENS = [
  "SQLite", // never write the store directly
  "`tags`", // must be a flat array
  "`importance`", // must be a number
  "`source`", // no invented one-off sources
  "leafmem-cli.sh", // automation sessions have no MCP tools
];

test("block: 版本标记与唯一标记成对", () => {
  assert.equal(block.split(BLOCK_START).length - 1, 1);
  assert.equal(block.split(BLOCK_END).length - 1, 1);
  assert.equal(detectVersion(block), BLOCK_VERSION);
});

test("block: 压缩后仍包含全部承重 token", () => {
  for (const token of [...TOOL_TOKENS, ...CALL_TOKENS, ...DISCIPLINE_TOKENS]) {
    assert.ok(block.includes(token), `注入块缺少承重 token: ${token}`);
  }
});

test("block: 体积预算（<3200 字符，为 SOUL 32KiB 硬线留余量）", () => {
  assert.ok(
    block.length < 3200,
    `注入块 ${block.length} 字符，超出 3,200 预算 —— 请合并条目而不是删除规则`,
  );
});

test("block: 自动化通道写成「首选」而非「兜底」", () => {
  assert.ok(/PRIMARY channel/i.test(block), "CLI 必须是自动化会话的首选通道");
  assert.ok(/ToolSearch/.test(block), "必须写明不要用 ToolSearch 重试");
});
