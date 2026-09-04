/**
 * Host-hook bridge installer (2026-08-11 hook architecture).
 *
 * Deterministically wires LeafMem into the host lifecycle via the WorkBuddy /
 * 昆仑小智 hook mechanism, so recall and commit no longer depend on the model
 * remembering to call the MCP tools:
 *
 *   - UserPromptSubmit -> recall relevant memory and inject it into context
 *   - Stop             -> capture the turn (durable facts/preferences + task ctx)
 *
 * The installer:
 *   1. Copies ops/hooks/leafmem-hooks.mjs to ~/.leafmem/hooks/leafmem-hooks.mjs
 *      (a stable, host-independent location).
 *   2. Merges a `hooks` block into the host's settings.json (creates the file /
 *      the hooks field if absent; replaces an existing leafmem-managed block).
 *
 * The bridge script is fail-safe: any error is a silent no-op that never blocks
 * the host. If the host does not actually fire hooks (older builds), the block
 * is inert and the MEMORY.md/SOUL.md rules remain the fallback path.
 */

import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId } from "./manager.js";

const LEAFMEM_HOOK_MARKER = "leafmem-hooks.mjs";

export type HookInstallResult = {
  agent: AgentId;
  scriptPath: string;
  settingsPath: string;
  events: string[];
  written: boolean;
};

/** Stable location of the bridge script (host-independent). */
export function hookScriptPath(home = homedir()): string {
  return join(home, ".leafmem", "hooks", "leafmem-hooks.mjs");
}

/** Resolve the bundled source script (ops/hooks/leafmem-hooks.mjs). */
function bundledHookSource(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  // From dist/agents/hooks.js (or src/agents/hooks.ts) the repo root is two
  // levels up; the script lives at <root>/ops/hooks/leafmem-hooks.mjs.
  return join(current, "..", "..", "ops", "hooks", "leafmem-hooks.mjs");
}

/**
 * Stable location of the leafmem-cli active-loading channel script.
 * (2026-09-04, v0.3.21) WorkBuddy 5.5.1 ignored defer_loading:false for custom
 * MCP servers and dropped the leafmem tools from the deferred index, leaving
 * automation sessions with no mcp__leafmem__* tools even though the stdio
 * connection succeeded. leafmem-cli wraps the launchd-managed agent service
 * HTTP API (127.0.0.1:3377) as a host-independent fallback channel that
 * automations can invoke directly, immune to host MCP registration regressions.
 */
export function leafmemCliPath(home = homedir()): string {
  return join(home, ".leafmem", "leafmem-cli.sh");
}

function bundledCliSource(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  return join(current, "..", "..", "ops", "leafmem-cli.sh");
}

/** Copy leafmem-cli.sh to its stable home (idempotent, best-effort). */
async function installLeafmemCli(home: string): Promise<void> {
  const dest = leafmemCliPath(home);
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(bundledCliSource(), dest);
    await chmod(dest, 0o755);
  } catch {
    // Best-effort: if the bundled source is missing, leave any existing copy.
  }
}

function hostSettingsPath(agent: AgentId, home = homedir()): string {
  const dir = agent === "workbuddy" ? ".workbuddy" : ".kunlunxiaozhi";
  return join(home, dir, "settings.json");
}

/**
 * Install the hook bridge for a host. Idempotent: safe to re-run on upgrade.
 * Returns the result (written=false when nothing changed).
 */
export async function installHostHooks(
  agent: AgentId,
  options: { home?: string; scopeId?: string } = {},
): Promise<HookInstallResult> {
  const home = options.home ?? homedir();
  const scopeId = options.scopeId ?? (agent === "workbuddy" ? "workbuddy" : "kunlunxiaozhi");
  const scriptPath = hookScriptPath(home);
  const settingsPath = hostSettingsPath(agent, home);

  // 1. Copy the bridge script to its stable home.
  await mkdir(dirname(scriptPath), { recursive: true });
  try {
    await copyFile(bundledHookSource(), scriptPath);
  } catch {
    // If the bundled source is missing (e.g. running from an unexpected layout),
    // leave any existing script in place and only reconcile the settings entry.
  }

  // 1b. Deploy the leafmem-cli active-loading channel (v0.3.21).
  await installLeafmemCli(home);

  // 2. Build the hooks block for this host.
  // 2026-08-12 (v0.3.12): SessionStart added for task warm-up injection
  // (workbuddy-buddy research P0-1); non-blocking like UPS.
  const events = ["SessionStart", "UserPromptSubmit", "Stop"];
  const block = buildHooksBlock(scriptPath, scopeId);

  // 3. Merge into settings.json.
  const settings = await readJson(settingsPath);
  const existingHooks = isObject(settings.hooks) ? (settings.hooks as Record<string, unknown>) : {};
  const nextHooks = mergeHooks(existingHooks, block);
  const changed = JSON.stringify(nextHooks) !== JSON.stringify(existingHooks);
  if (changed) {
    settings.hooks = nextHooks;
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  return { agent, scriptPath, settingsPath, events, written: changed };
}

/** Build the leafmem hooks block (UserPromptSubmit + Stop) for one host. */
function buildHooksBlock(scriptPath: string, scopeId: string): Record<string, unknown[]> {
  const command = (event: string) =>
    `node ${shellQuote(scriptPath)} ${event} --agent ${scopeId}`;
  return {
    SessionStart: [
      { hooks: [{ type: "command", command: command("SessionStart"), timeout: 10 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: command("UserPromptSubmit"), timeout: 10 }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: command("Stop"), timeout: 15 }] }],
  };
}

/**
 * Merge leafmem's hook entries into the host's existing hooks config without
 * clobbering unrelated hooks. For each managed event we drop any entry whose
 * command references leafmem-hooks.mjs (stale / relocated), then append the
 * fresh one.
 */
function mergeHooks(
  existing: Record<string, unknown>,
  leafmemBlock: Record<string, unknown[]>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const [event, entries] of Object.entries(leafmemBlock)) {
    const prior = Array.isArray(next[event]) ? [...(next[event] as unknown[])] : [];
    const withoutLeafmem = prior.filter((entry) => !entryReferencesLeafmem(entry));
    next[event] = [...withoutLeafmem, ...entries];
  }
  return next;
}

function entryReferencesLeafmem(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  const hooks = isObject(entry.hooks) || Array.isArray(entry.hooks) ? entry.hooks : undefined;
  if (Array.isArray(hooks)) {
    return hooks.some((h) => {
      const cmd = isObject(h) ? h.command : undefined;
      return typeof cmd === "string" && cmd.includes(LEAFMEM_HOOK_MARKER);
    });
  }
  const cmd = entry.command;
  return typeof cmd === "string" && cmd.includes(LEAFMEM_HOOK_MARKER);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_/:=.,+-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    return isObject(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
