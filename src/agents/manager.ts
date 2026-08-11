import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultMemoryMcpStoragePath } from "../mcp/stdio.js";
import { createLeafMem } from "../core/memory.js";
import { createWorkBuddyMemoryAdapter, writeWorkBuddyInstructions } from "../adapters/workbuddy.js";
import { openSqliteDatabase } from "../system/sqlite.js";
import { leafmemEnv } from "../system/env-compat.js";

// Phase 9 (2026-08-10): product positioned for WorkBuddy + 昆仑小智 only.
// Codex/Claude/Cursor/Copilot/Antigravity/TRAE removed per user decision.
export const AGENT_IDS = ["workbuddy", "kunlunxiaozhi"] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export type AgentInstallOptions = {
  home?: string;
  storagePath?: string;
  mcpPath?: string;
  sessionsRoot?: string;
  skipMcp?: boolean;
  skipImport?: boolean;
  /**
   * Memory topology (2026-08-08 dual-config per user request):
   * shared   = all WorkBuddy-family hosts write into the canonical
   *            agent:workbuddy scope (one memory pool, shared profile/recall)
   * isolated = each host keeps its own scope (agent:kunlunxiaozhi etc.)
   * Defaults to isolated so existing single-host installs are unaffected.
   *
   * 2026-08-11: when left undefined on an EXISTING install (upgrade path),
   * the already-configured LEAFMEM_SCOPE_ID is preserved instead of being
   * reset to the host's own scope.
   */
  sharedMemory?: boolean;
  skipInstructions?: boolean;
  /** 2026-08-11 hook architecture: skip registering host lifecycle hooks. */
  skipHooks?: boolean;
};

export type ResolvedAgentInstallOptions = {
  home: string;
  storagePath: string;
  mcpPath: string;
  sessionsRoot?: string;
  skipMcp: boolean;
  skipImport: boolean;
  skipInstructions: boolean;
  skipHooks: boolean;
  sharedMemory?: boolean;
};

export type AgentInstallResult = {
  agent: AgentId;
  mcp: "installed" | "skipped";
  import: "imported" | "skipped";
  instructions: "updated" | "skipped";
  hooks: "installed" | "skipped";
  importSummary?: Record<string, unknown>;
};

export type AgentStatus = {
  agent: AgentId;
  label: string;
  scopeId: string;
  paths: {
    configPath: string;
    instructionsPath?: string;
    sessionsRoot: string;
    storagePath: string;
    mcpPath: string;
  };
  mcp: {
    configured: boolean;
    storagePathMatches: boolean;
    command?: string;
    args?: string[];
  };
  instructions: {
    supported: boolean;
    installed: boolean;
  };
  sessions: {
    rootExists: boolean;
  };
  imported: {
    memories: number;
    tasks: number;
    source: string;
  };
};

type AgentDefinition = {
  label: string;
  scopeId: string;
  importBin?: string;
  defaultSessionsRoot(home: string): string;
  configPath(home: string): string;
  /**
   * Discipline file for the memory-workflow instruction block.
   * Pinned to the TOP of this file (right after its H1 title). We use
   * SOUL.md rather than MEMORY.md because SOUL.md is the host's primary
   * behavioral file and is loaded first — the memory workflow must outrank
   * every other rule. MEMORY.md stays a pure memory-content store.
   */
  instructionsPath?(home: string): string;
};

export const AGENTS: Record<AgentId, AgentDefinition> = {
  workbuddy: {
    label: "WorkBuddy",
    scopeId: "workbuddy",
    defaultSessionsRoot: (home) => join(home, ".workbuddy"),
    configPath: (home) => join(home, ".workbuddy", "mcp.json"),
    instructionsPath: (home) => join(home, ".workbuddy", "SOUL.md"),
  },
  kunlunxiaozhi: {
    label: "昆仑小智",
    scopeId: "kunlunxiaozhi",
    defaultSessionsRoot: (home) => join(home, ".kunlunxiaozhi"),
    configPath: (home) => join(home, ".kunlunxiaozhi", "mcp.json"),
    instructionsPath: (home) => join(home, ".kunlunxiaozhi", "SOUL.md"),
  },
};

export function resolveAgentOptions(options: AgentInstallOptions = {}): ResolvedAgentInstallOptions {
  return {
    home: options.home ?? leafmemEnv("AGENT_HOME") ?? homedir(),
    storagePath: options.storagePath ?? leafmemEnv("STORAGE_PATH") ?? defaultMemoryMcpStoragePath(),
    mcpPath: options.mcpPath ?? defaultAgentMcpPath(),
    sessionsRoot: options.sessionsRoot,
    skipMcp: options.skipMcp ?? false,
    skipImport: options.skipImport ?? false,
    skipInstructions: options.skipInstructions ?? false,
    skipHooks: options.skipHooks ?? false,
    sharedMemory: options.sharedMemory,
  };
}

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export function parseAgentTarget(target: string): AgentId[] {
  if (target === "all") {
    return [...AGENT_IDS];
  }
  if (isAgentId(target)) {
    return [target];
  }
  throw new Error(`Unsupported agent: ${target}`);
}

export function defaultAgentMcpPath(): string {
  return agentBinPath("leafmem-mcp");
}

export function agentBinPath(name: string): string {
  const current = fileURLToPath(import.meta.url);
  const dir = dirname(current);
  const rootDir = basename(dir) === "agents" ? dirname(dir) : dir;
  return join(rootDir, "bin", `${name}${extname(current)}`);
}

export async function installAgent(
  agent: AgentId,
  input: AgentInstallOptions | ResolvedAgentInstallOptions = {},
): Promise<AgentInstallResult> {
  const options = resolveAgentOptions(input);
  const result: AgentInstallResult = {
    agent,
    mcp: "skipped",
    import: "skipped",
    instructions: "skipped",
    hooks: "skipped",
  };

  if (!options.skipMcp) {
    await installMcp(agent, options);
    result.mcp = "installed";
  }
  if (!options.skipImport && AGENTS[agent].importBin) {
    result.importSummary = await importSessions(agent, options);
    result.import = "imported";
  }
  if (!options.skipImport && isWorkBuddyFamily(agent)) {
    result.importSummary = await installWorkBuddyTakeover(options, agent);
    result.import = "imported";
  }
  if (!options.skipInstructions) {
    const changed = await installInstructions(agent, options);
    result.instructions = changed ? "updated" : "skipped";
  }
  // 2026-08-11 hook architecture: register deterministic lifecycle hooks.
  // The hook bridge must recall/commit against the scope this host ACTUALLY
  // writes to (shared topology -> primary scope), so read it back from the
  // just-written mcp.json instead of assuming the host's own scope.
  if (!options.skipHooks && isWorkBuddyFamily(agent)) {
    try {
      const cfg = await readJsonObject(AGENTS[agent].configPath(options.home));
      const env = asObject(asObject(asObject(cfg.mcpServers).leafmem).env);
      const hookScopeId = stringValue(env.LEAFMEM_SCOPE_ID) ?? AGENTS[agent].scopeId;
      const { installHostHooks } = await import("./hooks.js");
      await installHostHooks(agent, { home: options.home, scopeId: hookScopeId });
      result.hooks = "installed";
    } catch {
      // Hook registration is best-effort; the SOUL.md rules remain the
      // fallback recall/commit path on hosts that cannot run hooks.
      result.hooks = "skipped";
    }
  }

  return result;
}

export async function importSessions(
  agent: AgentId,
  input: AgentInstallOptions | ResolvedAgentInstallOptions = {},
): Promise<Record<string, unknown>> {
  const options = resolveAgentOptions(input);
  const config = AGENTS[agent];
  if (!config.importBin) {
    return { skipped: true, reason: "session import is not supported for this agent" };
  }
  const importerPath = agentBinPath(config.importBin);
  const args = nodeScriptArgs(importerPath);
  args.push(options.sessionsRoot ?? config.defaultSessionsRoot(options.home));
  args.push("--storage-path", options.storagePath, "--scope-type", "agent", "--scope-id", config.scopeId);
  const output = await execFileAsync(process.execPath, args);
  return parseJsonOutput(output.stdout);
}

export async function installInstructions(
  agent: AgentId,
  input: AgentInstallOptions | ResolvedAgentInstallOptions = {},
): Promise<boolean> {
  const options = resolveAgentOptions(input);
  const path = AGENTS[agent].instructionsPath?.(options.home);
  if (!path) {
    return false;
  }
  if (isWorkBuddyFamily(agent)) {
    // Pin the memory workflow to the TOP of SOUL.md — the host loads SOUL.md
    // first, so the workflow outranks every other behavioral rule.
    const changed = await writeWorkBuddyInstructions(path, workBuddyUpdateCommand(agent), "top");
    // Migration (0.3.0): pre-0.3.0 installs wrote the discipline block into
    // MEMORY.md. Now that it lives in SOUL.md, strip any stale block from
    // MEMORY.md so the two files never disagree.
    await migrateInstructionsOutOfMemoryMd(agent, options.home);
    return changed;
  }
  return await writeMarkedBlock(path, instructionBlock(agent));
}

/** Remove a legacy leafmem discipline block from MEMORY.md (pre-0.3.0 location). */
async function migrateInstructionsOutOfMemoryMd(agent: AgentId, home: string): Promise<void> {
  const start = "<!-- leafmem-agent-instructions:start -->";
  const end = "<!-- leafmem-agent-instructions:end -->";
  const memoryPath = join(AGENTS[agent].defaultSessionsRoot(home), "MEMORY.md");
  const current = await readText(memoryPath);
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return; // no legacy block, nothing to migrate
  }
  const before = current.slice(0, startIndex).trimEnd();
  const after = current.slice(endIndex + end.length).trimStart();
  const next = [before, after].filter(Boolean).join("\n\n");
  await writeText(memoryPath, next ? `${next}\n` : "");
}

export async function getAgentStatuses(
  input: AgentInstallOptions | ResolvedAgentInstallOptions = {},
): Promise<AgentStatus[]> {
  return await Promise.all(AGENT_IDS.map((agent) => getAgentStatus(agent, input)));
}

export async function getAgentStatus(
  agent: AgentId,
  input: AgentInstallOptions | ResolvedAgentInstallOptions = {},
): Promise<AgentStatus> {
  const options = resolveAgentOptions(input);
  const config = AGENTS[agent];
  const sessionsRoot = options.sessionsRoot ?? config.defaultSessionsRoot(options.home);
  const instructionsPath = config.instructionsPath?.(options.home);
  const mcp = await inspectMcpConfig(agent, options);
  const installedInstructions = instructionsPath
    ? await textIncludes(instructionsPath, "leafmem-agent-instructions:start")
    : false;

  return {
    agent,
    label: config.label,
    scopeId: config.scopeId,
    paths: {
      configPath: config.configPath(options.home),
      instructionsPath,
      sessionsRoot,
      storagePath: options.storagePath,
      mcpPath: options.mcpPath,
    },
    mcp,
    instructions: {
      supported: Boolean(instructionsPath),
      installed: installedInstructions,
    },
    sessions: {
      rootExists: await pathExists(sessionsRoot),
    },
    imported: await countImported(agent, options.storagePath),
  };
}

async function installMcp(agent: AgentId, options: ResolvedAgentInstallOptions): Promise<void> {
  await writeJsonMcpConfig(AGENTS[agent].configPath(options.home), agent, options);
}

async function inspectMcpConfig(
  agent: AgentId,
  options: ResolvedAgentInstallOptions,
): Promise<AgentStatus["mcp"]> {
  const config = await readJsonObject(AGENTS[agent].configPath(options.home));
  const server = asObject(asObject(config.mcpServers).leafmem);
  const env = asObject(server.env);
  const args = stringArray(server.args);
  return {
    configured: Object.keys(server).length > 0,
    storagePathMatches: leafmemEnv("STORAGE_PATH", env) === options.storagePath,
    command: stringValue(server.command),
    args,
  };
}

async function countImported(agent: AgentId, storagePath: string): Promise<AgentStatus["imported"]> {
  const source = agent === "workbuddy" ? "workbuddy_import" : `${agent}_session_import`;
  if (!(await pathExists(storagePath))) {
    return { memories: 0, tasks: 0, source };
  }

  const db = openSqliteDatabase(storagePath);
  try {
    const memories = agent === "workbuddy"
      ? (
          db.prepare(
            "SELECT COUNT(*) AS count FROM memory_items WHERE source IN ('workbuddy_import', 'workbuddy_native_import')",
          ).get() as { count?: number } | undefined
        )?.count ?? 0
      : (
          db.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE source = ?").get(source) as
            | { count?: number }
            | undefined
        )?.count ?? 0;
    const tasks =
      (
        db.prepare("SELECT COUNT(*) AS count FROM task_context WHERE task_id LIKE ?").get(`${agent}:%`) as
          | { count?: number }
          | undefined
      )?.count ?? 0;
    return { memories, tasks, source };
  } finally {
    db.close();
  }
}



async function writeJsonMcpConfig(
  configPath: string,
  format: AgentId,
  options: ResolvedAgentInstallOptions,
): Promise<void> {
  const config = await readJsonObject(configPath);
  const servers = asObject(config.mcpServers);
  // Merge instead of overwrite (2026-08-06): keep user-customized env entries
  // (reranker/embedding/api keys) and an existing absolute node command intact;
  // only set/update the core leafmem fields. Overwriting would silently drop
  // LEAFMEM_RERANK_*, LEAFMEM_EMBEDDINGS_*, OPENAI_API_KEY, DEEPSEEK_API_KEY
  // and replace the absolute node path with a PATH-dependent bare "node".
  const existing = asObject(servers.leafmem);
  const existingEnv = asObject(existing.env);
  // Phase 9: both remaining hosts are WorkBuddy-family (workbuddy/kunlunxiaozhi).
  // sharedMemory → single pool at the primary scope (the first configured
  // host's own scope; workbuddy-first installs → agent:workbuddy,
  // 昆仑小智-only installs → agent:kunlunxiaozhi). Memories + graph + profile
  // + active all share it. Upgrade-safety (2026-08-11): when sharedMemory is
  // unspecified (upgrade / repair path), preserve the already-configured
  // LEAFMEM_SCOPE_ID instead of resetting it to the host's own scope.
  // NOTE: the file-import path (installWorkBuddyTakeover) resolves its scope
  // through this same function — the two must never disagree.
  const scopeId = await resolveEffectiveScopeId(format, options);
  const coreEnv = {
    LEAFMEM_STORAGE_PATH: options.storagePath,
    LEAFMEM_SCOPE_TYPE: "agent",
    LEAFMEM_SCOPE_ID: scopeId,
    LEAFMEM_WORKBUDDY_HOME: AGENTS[format].defaultSessionsRoot(options.home),
  };
  const env = { ...existingEnv, ...coreEnv };
  const command =
    typeof existing.command === "string" && existing.command.trim() !== ""
      ? existing.command
      : "node";
  servers.leafmem = { command, args: [options.mcpPath], env };
  config.mcpServers = servers;
  await writeJson(configPath, config);
}

/**
 * The scope this host's LeafMem connector actually writes to. Shared by the
 * MCP env writer and the file-import path so the two can never disagree.
 *
 * 2026-08-11 incident: the import path hardcoded the host's own scope while
 * installMcp honored the shared topology, so a shared kunlunxiaozhi install
 * wrote 167 duplicate six-file import records into agent:kunlunxiaozhi even
 * though the pool (and the identical workbuddy-scope copies) already held them.
 */
async function resolveEffectiveScopeId(
  format: AgentId,
  options: ResolvedAgentInstallOptions,
): Promise<string> {
  const config = await readJsonObject(AGENTS[format].configPath(options.home));
  const existingEnv = asObject(asObject(asObject(config.mcpServers).leafmem).env);
  const existingScopeId = stringValue(existingEnv.LEAFMEM_SCOPE_ID);
  const { primaryScopeId } = await getMemoryTopology({ home: options.home });
  return options.sharedMemory === undefined && existingScopeId
    ? existingScopeId
    : options.sharedMemory
      ? primaryScopeId
      : AGENTS[format].scopeId;
}

async function installWorkBuddyTakeover(
  options: ResolvedAgentInstallOptions,
  agent: AgentId = "workbuddy",
): Promise<Record<string, unknown>> {
  // 2026-08-11 import redesign: mechanical per-line import produced hundreds
  // of fragmented records (isolated headings, structural symbols, split list
  // items, even literal credentials). The install path no longer shards the
  // six discipline files. Instead it records a *pending distillation* state;
  // the host agent (which has an LLM and reads these files anyway in the
  // install guide's profile step) distills each file into a few coherent
  // paragraph-unit memories and writes them via memory_write. See
  // INSTALL-*.md step 7.5.
  const scopeId = await resolveEffectiveScopeId(agent, options);
  const adapter = createWorkBuddyMemoryAdapter({
    memory: createLeafMem({ storagePath: options.storagePath }),
    defaultScopes: [{ type: "agent", id: scopeId }],
    files: { homePath: AGENTS[agent].defaultSessionsRoot(options.home) },
  });
  const fingerprint = await adapter.sourceFingerprint();
  const statePath = join(dirname(options.storagePath), "import-state.json");
  const state = asObject(await readJsonObject(statePath));
  const perHost = asObject(state[agent]);
  const previousPending = perHost.pending === true;
  const changed = stringValue(perHost.fingerprint) !== fingerprint;
  if (!changed && !previousPending) {
    return { imported: 0, skippedAsUnchanged: true, pendingDistillation: false };
  }
  // Mark pending so the console/install guide can surface "distillation not
  // yet done by the host agent". Cleared by the host after distillation.
  await writeJson(statePath, {
    ...state,
    [agent]: { ...perHost, fingerprint, pending: true, pendingAt: new Date().toISOString() },
  });
  return { imported: 0, pendingDistillation: true, fingerprint };
}

function workBuddyUpdateCommand(agent: AgentId = "workbuddy"): string {
  return `node ${shellQuote(agentBinPath("leafmem-agent"))} update ${agent}`;
}

/** Hosts that share the WorkBuddy-family adapter/takeover/instructions format. */
function isWorkBuddyFamily(agent: AgentId): boolean {
  return agent === "workbuddy" || agent === "kunlunxiaozhi";
}

function instructionBlock(agent: AgentId): string {
  const scopeId = AGENTS[agent].scopeId;
  return `<!-- leafmem-agent-instructions:start -->
Memory lookup:

- If a task may depend on user-specific preferences, prior project decisions, repo conventions, or earlier troubleshooting history, query LeafMem before answering or editing. Prefer a lightweight \`memory_recall\` call with \`action: "recall"\` using the current request. For cross-agent continuity, omit scope first so LeafMem can search the shared user memory store; for narrow lookups or durable writes, use \`agent:${scopeId}\`. Skip this for trivial, fully self-contained requests.
- During long-running or multi-step tasks, call \`memory_write\` with \`action: "task_append"\` at each key sub-step completion or decision (taskId + role + content), so later sessions can restore progress via \`memory_recall\` \`action: "task_window"\`.
- After substantial work or when closing a session, distill the session with the current host model and call \`memory_write\` with \`action: "commit"\`, the rolling summary, any new transcript entries, and durable facts/preferences/decisions. Use \`agent:${scopeId}\` for the session memory unless a narrower project/repo scope is clearly available.
<!-- leafmem-agent-instructions:end -->`;
}






async function writeMarkedBlock(path: string, block: string): Promise<boolean> {
  const current = await readText(path);
  const start = "<!-- leafmem-agent-instructions:start -->";
  const end = "<!-- leafmem-agent-instructions:end -->";
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = current.slice(0, startIndex).trimEnd();
    const after = current.slice(endIndex + end.length).trimStart();
    const next = [before, block, after].filter(Boolean).join("\n\n");
    if (`${next}\n` === current) {
      return false;
    }
    await writeText(path, `${next}\n`);
    return true;
  }
  const next = current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`;
  await writeText(path, next);
  return true;
}

function nodeScriptArgs(path: string): string[] {
  return extname(path) === ".ts" ? ["--import", "tsx", path] : [path];
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeTextIfChanged(path: string, content: string): Promise<boolean> {
  if (await readText(path) === content) {
    return false;
  }
  await writeText(path, content);
  return true;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const text = await readText(path);
  if (!text.trim()) {
    return {};
  }
  return asObject(JSON.parse(text));
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}



function shellQuote(value: string): string {
  return /^[A-Za-z0-9_/:=.,+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

async function textIncludes(path: string, needle: string): Promise<boolean> {
  return (await readText(path)).includes(needle);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout || "{}") as unknown;
  return asObject(parsed);
}


function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Phase 9: memory topology = whether the two hosts share one scope pool.
 * shared  → both mcp.json LEAFMEM_SCOPE_ID === "workbuddy"
 * isolated → each host keeps its own scopeId */
export type MemoryTopology = {
  shared: boolean;
  /** per-host observed scope id from mcp.json env (undefined if host not configured) */
  scopes: Partial<Record<AgentId, string>>;
  /**
   * Canonical primary scope (the first configured host's own scope, in AGENT_IDS
   * order). Shared topology = every configured host lands here. Never assume
   * "workbuddy": a 昆仑小智-only install has primary = kunlunxiaozhi.
   */
  primaryScopeId: string;
  /** number of configured hosts */
  configuredCount: number;
};

export async function getMemoryTopology(
  input: AgentInstallOptions = {},
): Promise<MemoryTopology> {
  const options = resolveAgentOptions(input);
  const scopes: Partial<Record<AgentId, string>> = {};
  for (const agent of AGENT_IDS) {
    const cfg = await readJsonObject(AGENTS[agent].configPath(options.home));
    const env = asObject(asObject(asObject(cfg.mcpServers).leafmem).env);
    const id = stringValue(env.LEAFMEM_SCOPE_ID);
    if (typeof id === "string" && id.trim() !== "") scopes[agent] = id;
  }
  const values = Object.values(scopes);
  // Primary scope = the first configured host's own scope (AGENT_IDS order).
  // Shared = all configured hosts (1+) landed in that primary scope.
  // Single-host installs are trivially "shared" (nothing to split from).
  const firstAgent = AGENT_IDS.find((agent) => scopes[agent] !== undefined);
  const primaryScopeId = firstAgent ? AGENTS[firstAgent].scopeId : AGENTS[AGENT_IDS[0]!].scopeId;
  const shared = values.length > 0 && values.every((v) => v === primaryScopeId);
  return { shared, scopes, primaryScopeId, configuredCount: values.length };
}

export async function setMemoryTopology(
  shared: boolean,
  input: AgentInstallOptions = {},
): Promise<MemoryTopology> {
  const options = resolveAgentOptions(input);
  const { primaryScopeId } = await getMemoryTopology(options);
  for (const agent of AGENT_IDS) {
    const path = AGENTS[agent].configPath(options.home);
    const cfg = await readJsonObject(path);
    const servers = asObject(cfg.mcpServers);
    const server = asObject(servers.leafmem);
    if (Object.keys(server).length === 0) continue; // host not configured
    const env = asObject(server.env);
    env.LEAFMEM_SCOPE_TYPE = "agent";
    env.LEAFMEM_SCOPE_ID = shared ? primaryScopeId : AGENTS[agent].scopeId;
    server.env = env;
    servers.leafmem = server;
    cfg.mcpServers = servers;
    await writeJson(path, cfg);
  }
  return await getMemoryTopology(options);
}

function execFileAsync(
  file: string,
  args: string[],
  timeout = 0,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(`${file} ${args.join(" ")} failed: ${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
