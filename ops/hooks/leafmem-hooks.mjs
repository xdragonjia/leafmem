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

import { readFile, appendFile } from "node:fs/promises";
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
    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
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
    const { userMessage, assistantMessage } = await extractTurn(payload);
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
