#!/usr/bin/env node
/**
 * LeafMem host-hook bridge (self-contained, zero external deps).
 *
 * Bridges the WorkBuddy / 昆仑小智 hook lifecycle into the LeafMem local HTTP
 * API so that recall and commit happen DETERMINISTICALLY instead of relying on
 * the model to remember to call the MCP tools:
 *
 *   - UserPromptSubmit -> POST /v1/recall, inject recalled memory into context
 *   - Stop             -> POST /v1/turns/capture, auto-commit the turn
 *
 * Design rules:
 *   - NEVER break the host. Any error, missing config, offline service, or
 *     timeout resolves to a silent no-op (exit 0, empty/continue output).
 *   - Fast: recall uses a short timeout so prompt submission is never delayed
 *     noticeably.
 *   - Reads { host, port, apiKey } from ~/.leafmem/agent-service.json (written
 *     by `leafmem-agent service install`). No API key on the command line.
 *
 * Usage (invoked by the host hook runner, payload on stdin):
 *   node leafmem-hooks.mjs <HookEventName> [--agent <scopeId>]
 */

import { readFile, appendFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Semantic recall = one remote embedding call + one remote rerank call, so the
// UserPromptSubmit hook can add a few seconds of latency per prompt on slow
// networks. Both timeouts are env-tunable so a deployment can trade freshness
// for responsiveness (or set LEAFMEM_HOOK_RECALL_TIMEOUT_MS=0 to make recall
// near-instant at the cost of skipping slow results).
const RECALL_TIMEOUT_MS = intEnv("LEAFMEM_HOOK_RECALL_TIMEOUT_MS", 8000);
const CAPTURE_TIMEOUT_MS = intEnv("LEAFMEM_HOOK_CAPTURE_TIMEOUT_MS", 6000);
const HOOK_LOG_PATH = join(homedir(), ".leafmem", "hooks.log");
const CAPTURE_STATE_PATH = join(homedir(), ".leafmem", "capture-state.json");

// 2026-08-11 agent-driven capture. The keyword heuristic extractor only matches
// 记住/偏好/决定/我是 patterns, so complex work turns stored nothing (real
// incident: a full day of bug-fixing produced zero commits). When a session did
// substantive work but never wrote to LeafMem, the Stop hook now returns
// decision:"block" to pull the agent back with an explicit instruction to
// summarize via memory_write (+ task_append for running tasks).
// Disable with LEAFMEM_HOOK_STOP_DRIVE=0.
const STOP_DRIVE_ENABLED = process.env.LEAFMEM_HOOK_STOP_DRIVE !== "0";
// Greetings / one-liner sessions never trigger a block.
const MIN_WORK_CHARS = intEnv("LEAFMEM_HOOK_STOP_DRIVE_MIN_CHARS", 15);

const DRIVE_INSTRUCTION =
  "⏳ LeafMem 收尾写入门禁：本会话有实质工作，但记忆库尚无本次写入。结束前请静默完成（不必向用户描述此过程）：" +
  "① 用 1-3 条记忆提炼本次工作的经验/决策/教训，每条为完整段落（≥100字、原子自足、实体明确），" +
  "kind 取 lesson/decision/experience/preference，通过 memory_write(action=remember) 写入 LeafMem" +
  "（不传 scope，默认 agent:workbuddy；必须给 tags）。" +
  "② 若存在进行中的任务，用 memory_write(action=task_append, 传 taskId、role、content) 记录当前进度，" +
  "并同传 rollingSummary 参数（一句话任务总览，供任务页展示与下一会话恢复），否则任务会只有 transcript 没有 summary。" +
  "③ 任务生命周期：该任务若已全部完成，同传 status=\"completed\" 关闭它（任务不会自动关闭，不传 status 将永远停在 active）；仍在进行则不传或传 active。" +
  "完成后可结束对话。";

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function heartbeat(line) {
  try {
    await appendFile(HOOK_LOG_PATH, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // logging must never break the host
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const event = argv[0] ?? "";
  const agent = flagValue(argv, "--agent") ?? "workbuddy";

  // Cross-platform self-test (install guide step 9): simulate a recall event
  // without any host. Usage: node leafmem-hooks.mjs self-test --agent <scope>
  if (event === "self-test") {
    const cfg = await readServiceConfig();
    if (!cfg) {
      process.stdout.write("self-test FAIL: ~/.leafmem/agent-service.json 不存在（先运行 leafmem-agent service install）\n");
      process.exit(1);
    }
    const base = `http://${cfg.host ?? "127.0.0.1"}:${cfg.port ?? 3377}`;
    const data = await postJson(
      base,
      { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      "/v1/recall",
      { message: "leafmem hook self-test", context: { agentId: agent } },
      RECALL_TIMEOUT_MS,
    );
    const ctx = extractRecallContext(data);
    process.stdout.write(
      ctx
        ? `self-test OK: 服务连通，召回注入 ${ctx.length} 字符（agent=${agent}）\n`
        : "self-test OK: 服务连通，本次无可注入上下文（记忆库可能为空）\n",
    );
    process.exit(0);
  }

  const payload = await readStdinJson();
  const cfg = await readServiceConfig();
  if (!cfg) {
    await heartbeat(`${event} skip: agent-service.json missing`);
    return done(event, null); // service not installed -> silent no-op
  }

  const base = `http://${cfg.host ?? "127.0.0.1"}:${cfg.port ?? 3377}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };

  if (event === "UserPromptSubmit") {
    const prompt = sanitizeCapturedText(typeof payload.prompt === "string" ? payload.prompt : "");
    if (!prompt) return done(event, null);
    const data = await postJson(
      base,
      headers,
      "/v1/recall",
      {
        message: prompt,
        recentMessages: payload.recentMessages,
        maxChars: 3000,
        context: { agentId: agent },
      },
      RECALL_TIMEOUT_MS,
    );
    const ctx = extractRecallContext(data);
    if (!ctx) {
      await heartbeat(`${event} recall: no context`);
      return done(event, null);
    }
    await heartbeat(`${event} recall: injected ${ctx.length} chars`);
    return done(event, {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: ctx,
      },
    });
  }

  if (event === "Stop" || event === "SessionEnd") {
    const raw = await extractTurn(payload);
    const userMessage = sanitizeCapturedText(raw.userMessage ?? "");
    const assistantMessage = sanitizeCapturedText(raw.assistantMessage ?? "");
    if (!userMessage) {
      await heartbeat(`${event} capture: no user message, skipped`);
      return done(event, null); // nothing reliable to commit
    }
    const captured = await postJson(
      base,
      headers,
      "/v1/turns/capture",
      {
        userMessage,
        assistantMessage,
        context: { agentId: agent, sessionId: payload.session_id },
      },
      CAPTURE_TIMEOUT_MS,
    );
    const stored = captured && typeof captured === "object" ? (captured.stored ?? captured.proposals ?? 0) : 0;
    await heartbeat(`${event} capture: stored=${typeof stored === "number" ? stored : "?"}`);

    // 2026-08-11 agent-driven capture: the heuristic above only catches
    // 记住/偏好/决定/我是 phrasings. When a substantive session ends with
    // nothing stored, pull the agent back ONCE so it summarizes in its own
    // words (and appends task context for running tasks).
    if (event === "Stop" && STOP_DRIVE_ENABLED) {
      const sessionId = typeof payload.session_id === "string" && payload.session_id.trim()
        ? payload.session_id.trim()
        : "no-session";
      // Loop guard 1 (protocol): the host re-fires Stop with stop_hook_active
      // while the agent is answering a previous block — never block again.
      if (payload.stop_hook_active === true) {
        await heartbeat(`${event} drive: stop_hook_active, allow`);
        return done(event, null);
      }
      // Loop guard 2 (state): at most one drive per session.
      const state = await readCaptureState();
      const sess = state[sessionId];
      if (sess && sess.drivenAt) {
        await heartbeat(`${event} drive: already driven this session, allow`);
        return done(event, null);
      }
      const storedCount = typeof stored === "number" ? stored : 0;
      const workChars = userMessage.length + assistantMessage.length;
      if (storedCount === 0 && workChars >= MIN_WORK_CHARS) {
        await writeCaptureState({
          ...state,
          [sessionId]: {
            drivenAt: new Date().toISOString(),
            agent,
            workChars,
          },
        });
        await heartbeat(`${event} drive: BLOCK (workChars=${workChars}, stored=0)`);
        return done(event, { decision: "block", reason: DRIVE_INSTRUCTION });
      }
    }
    return done(event, { continue: true });
  }

  return done(event, null);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function done(event, output) {
  if (output) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } else {
    // Empty output = allow continuation, inject nothing.
    process.stdout.write("{}\n");
  }
  process.exit(0);
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}

async function readStdinJson() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function readServiceConfig() {
  try {
    const path = join(homedir(), ".leafmem", "agent-service.json");
    const text = await readFile(path, "utf8");
    const cfg = JSON.parse(text);
    if (!cfg || !cfg.apiKey || !cfg.port) return null;
    return cfg;
  } catch {
    return null;
  }
}

// Per-session "already driven once" ledger for the Stop drive loop-guard.
// Read/write failures degrade to an empty object / silent no-op — a broken
// state file must never break the host.
async function readCaptureState() {
  try {
    const text = await readFile(CAPTURE_STATE_PATH, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeCaptureState(state) {
  try {
    await writeFile(CAPTURE_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // best-effort; loop guard 1 (stop_hook_active) still protects the host
  }
}

async function postJson(base, headers, path, body, timeoutMs) {
  if (timeoutMs <= 0) return null; // timeout=0 -> feature disabled
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractRecallContext(data) {
  if (!data || typeof data !== "object") return null;
  // buildRecall returns { injectedContext | dynamicContext | layers... }.
  const text =
    data.injectedContext ||
    data.dynamicContext ||
    (data.layers && (data.layers.palace || data.layers.retrieval)) ||
    "";
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed || null;
}

/**
 * Sanitize text captured from the host before it enters the memory store.
 *
 * Host transcripts embed system-injected boilerplate (SOUL.md, identity files,
 * <system-reminder> / <additional_data> / <memory_and_skills_reminder> blocks,
 * connector status lists) verbatim. If captured raw, the rule extractor stores
 * system boilerplate as durable "preferences" (real incident 2026-08-11: two
 * turn_inference records containing raw <system-reminder> markup had to be
 * deleted). Rules here:
 *   1. When a <user_query> tag is present, keep only its body (the human's
 *      actual message).
 *   2. Strip system-injected blocks and XML scaffolding wholesale.
 *   3. Return trimmed plain text, or "" when nothing human-authored remains.
 */
function sanitizeCapturedText(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  let out = text;

  // 1. Prefer the <user_query> body when the host wraps the human message.
  const uq = out.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (uq?.[1] && uq[1].trim()) {
    out = uq[1];
  }

  // 2. Strip system-injected blocks (balanced and self-closing forms).
  out = out
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<system-reminder[^>]*>(?![\s\S]*<\/system-reminder>)[\s\S]*/gi, " ")
    .replace(/<additional_data>[\s\S]*?<\/additional_data>/gi, " ")
    .replace(/<connector-status>[\s\S]*?<\/connector-status>/gi, " ")
    .replace(/<memory_and_skills_reminder>[\s\S]*?<\/memory_and_skills_reminder>/gi, " ")
    .replace(/<identity_context>[\s\S]*?<\/identity_context>/gi, " ")
    .replace(/<project_context>[\s\S]*?<\/project_context>/gi, " ")
    .replace(/<product_identity>[\s\S]*?<\/product_identity>/gi, " ")
    .replace(/<tone_and_style>[\s\S]*?<\/tone_and_style>/gi, " ")
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, " ")
    .replace(/<image[^>]*>[\s\S]*?<\/image>/gi, " ")
    .replace(/<image_local_path>[\s\S]*?<\/image_local_path>/gi, " ");

  const trimmed = out.trim();
  // Nothing human-authored left (pure injection) -> skip.
  if (!trimmed) return "";
  // Guard: if the remainder still smells like injection scaffolding, skip.
  if (/^(#|##)\s*(SOUL\.md|IDENTITY\.md|USER\.md)/i.test(trimmed)) return "";
  if (/<(hook|user-context|memory\b)/i.test(trimmed.slice(0, 60))) return "";
  return trimmed;
}

/**
 * Best-effort extraction of the last user/assistant turn from the Stop payload.
 * Prefers explicit fields; falls back to parsing transcript_path (JSONL). On any
 * failure returns empty so we never commit garbage.
 */
async function extractTurn(payload) {
  const assistantMessage =
    typeof payload.last_assistant_message === "string"
      ? payload.last_assistant_message.trim()
      : undefined;

  if (typeof payload.prompt === "string" && payload.prompt.trim()) {
    return { userMessage: payload.prompt.trim(), assistantMessage };
  }

  if (typeof payload.transcript_path === "string") {
    try {
      const text = await readFile(payload.transcript_path, "utf8");
      const lines = text.split("\n").filter((l) => l.trim());
      let lastUser;
      let lastAssistant = assistantMessage;
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          const role = rec.role ?? rec.type;
          const content =
            typeof rec.content === "string"
              ? rec.content
              : Array.isArray(rec.content)
                ? rec.content
                    .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
                    .join(" ")
                : "";
          if (role === "user" && content.trim()) lastUser = content.trim();
          if (role === "assistant" && content.trim()) lastAssistant = content.trim();
        } catch {
          // skip non-JSON lines
        }
      }
      return { userMessage: lastUser, assistantMessage: lastAssistant };
    } catch {
      return { userMessage: undefined, assistantMessage };
    }
  }

  return { userMessage: undefined, assistantMessage };
}

main().catch(() => process.exit(0));
