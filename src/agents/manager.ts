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
   */
  sharedMemory?: boolean;
  skipInstructions?: boolean;
};

export type ResolvedAgentInstallOptions = {
  home: string;
  storagePath: string;
  mcpPath: string;
  sessionsRoot?: string;
  skipMcp: boolean;
  skipImport: boolean;
  skipInstructions: boolean;
  sharedMemory?: boolean;
};

export type AgentInstallResult = {
  agent: AgentId;
  mcp: "installed" | "skipped";
  import: "imported" | "skipped";
  instructions: "updated" | "skipped";
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
  instructionsPath?(home: string): string;
};

export const AGENTS: Record<AgentId, AgentDefinition> = {
  workbuddy: {
    label: "WorkBuddy",
    scopeId: "workbuddy",
    defaultSessionsRoot: (home) => join(home, ".workbuddy"),
    configPath: (home) => join(home, ".workbuddy", "mcp.json"),
    instructionsPath: (home) => join(home, ".workbuddy", "MEMORY.md"),
  },
  kunlunxiaozhi: {
    label: "昆仑小智",
    scopeId: "kunlunxiaozhi",
    defaultSessionsRoot: (home) => join(home, ".kunlunxiaozhi"),
    configPath: (home) => join(home, ".kunlunxiaozhi", "mcp.json"),
    instructionsPath: (home) => join(home, ".kunlunxiaozhi", "MEMORY.md"),
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
    return await writeWorkBuddyInstructions(path, workBuddyUpdateCommand(agent));
  }
  return await writeMarkedBlock(path, instructionBlock(agent));
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
  // sharedMemory → single agent:workbuddy pool (memories + graph + profile + active).
  const coreEnv = {
    LEAFMEM_STORAGE_PATH: options.storagePath,
    LEAFMEM_SCOPE_TYPE: "agent",
    LEAFMEM_SCOPE_ID: options.sharedMemory ? "workbuddy" : AGENTS[format].scopeId,
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

async function installWorkBuddyTakeover(
  options: ResolvedAgentInstallOptions,
  agent: AgentId = "workbuddy",
): Promise<Record<string, unknown>> {
  const memory = createLeafMem({ storagePath: options.storagePath });
  const adapter = createWorkBuddyMemoryAdapter({
    memory,
    defaultScopes: [{ type: "agent", id: AGENTS[agent].scopeId }],
    files: { homePath: AGENTS[agent].defaultSessionsRoot(options.home) },
  });
  // syncProjection disabled: SOUL.md/USER.md/MEMORY.md are user-authoritative files,
  // not leafmem projections. Only import existing memory (read files -> write DB);
  // never project memory back onto user files from the install path.
  const imported = await adapter.importExistingMemory();
  return imported;
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
