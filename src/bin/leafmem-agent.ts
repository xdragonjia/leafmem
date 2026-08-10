#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  AGENT_IDS,
  defaultAgentMcpPath,
  getAgentStatuses,
  importSessions,
  installAgent,
  isAgentId,
  parseAgentTarget,
  resolveAgentOptions,
  type AgentId,
  type AgentInstallOptions,
} from "../agents/manager.js";
import { createLeafMem } from "../core/index.js";
import type { LeafMemOptions } from "../core/memory.js";
import { createLeafMemServer } from "../http/server.js";
import { SqliteInspectEventStore } from "../inspect/sqlite-store.js";
import { defaultMemoryMcpStoragePath } from "../mcp/stdio.js";
import { LeafMemPlatformService } from "../platform/service.js";
import { ProjectStore } from "../auth/project.js";
import { SqliteEntityStore, RuleBasedEntityExtractor } from "../entity/index.js";
import { startAgentImportScheduler } from "../agents/import-scheduler.js";
import { leafmemEnv } from "../system/env-compat.js";
import {
  ensureAgentServiceConfig,
  getAgentServiceStatus,
  installAgentService,
  projectFromAgentServiceConfig,
  serviceUrl,
  startAgentService,
  stopAgentService,
  uninstallAgentService,
  type AgentServiceOptions,
} from "../agents/service.js";

const HELP = `leafmem-agent

Install LeafMem globally for coding agents, or launch the local setup UI.

Usage:
  leafmem-agent install <workbuddy|kunlunxiaozhi|all>
  leafmem-agent update <workbuddy|kunlunxiaozhi|all>
  leafmem-agent service <install|start|stop|restart|status|uninstall|url>
  leafmem-agent serve
  leafmem-agent ui
  leafmem-agent tui

Options:
  --storage-path <path>  Shared SQLite database path (default: ${defaultMemoryMcpStoragePath()})
  --mcp-path <path>      leafmem-mcp script path (default: sibling dist/bin/leafmem-mcp.js)
  --sessions-root <path> Override session root for a single agent import
  --home <path>          Home directory for agent config paths (default: current user home)
  --memory <shared|isolated>  WorkBuddy/KunlunXiaoZhi memory topology:
                              shared = one pooled memory across hosts (recommended),
                              isolated = per-host separate scopes
  --skip-mcp             Do not install MCP configuration
  --skip-import          Do not import existing sessions
  --skip-instructions    Do not update agent instruction files
  --skip-service         Do not install the local LaunchAgent service (install all only)
  --no-service-start     Write the LaunchAgent but do not start it
  --once                 Print TUI status once and exit (tui only)
  --port <number>        UI server port (ui only, default: 3377)
  --host <host>          UI server host (ui only, default: 127.0.0.1)
  --config <path>        Service config path (serve only)
  --help                 Show this message
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (argv[0] === "install") {
    const { agents, options, serviceOptions, skipService } = parseInstallArgs(argv.slice(1));
    const ask = (options as { _askShared?: () => Promise<boolean> })._askShared;
    if (ask) options.sharedMemory = await ask();
    const results = [];
    for (const agent of agents) {
      results.push(await installAgent(agent, options));
    }
    const service = agents.length === AGENT_IDS.length && !skipService ? await installAgentService(serviceOptions) : undefined;
    process.stdout.write(`${JSON.stringify({ storagePath: options.storagePath, service, results }, null, 2)}\n`);
    // Custom (LeafMem B5, 2026-08-08): point the user at the API-key guide so
    // free vectorization (SiliconFlow) and optional inferencer (DeepSeek) get
    // configured right after install. Written to stderr so stdout stays pure
    // JSON for machine parsing (tests and the console UI parse stdout).
    process.stderr.write(
      [
        "",
        "Next: configure model API keys to enable vectorized recall and reflection.",
        "  - SiliconFlow (free embeddings/rerank) + optional DeepSeek inferencer:",
        "    see docs/GETTING_STARTED.md",
        "",
      ].join("\n"),
    );
    return;
  }

  if (argv[0] === "update") {
    await runUpdate(argv.slice(1));
    return;
  }

  if (argv[0] === "service") {
    await runService(parseServiceArgs(argv.slice(1)));
    return;
  }

  if (argv[0] === "serve") {
    await runServe(parseServeArgs(argv.slice(1)));
    return;
  }

  if (argv[0] === "ui") {
    await runUi(parseUiArgs(argv.slice(1)));
    return;
  }

  if (argv[0] === "tui") {
    await runTui(parseTuiArgs(argv.slice(1)));
    return;
  }

  throw new Error("Expected command: install, update, service, serve, ui, or tui");
}

function parseInstallArgs(argv: string[]) {
  const target = argv[0];
  if (!target) {
    throw new Error("Missing agent target");
  }

  const agents = parseAgentTarget(target);
  const parsed = parseSharedAgentOptions(argv, 1);
  const options = resolveAgentOptions(parsed.agentOptions);
  // Memory topology dual-config (2026-08-08): --memory shared|isolated, or an
  // interactive prompt on TTY when installing WorkBuddy-family hosts.
  const memFlag = argv.find((a) => a === "--memory") ? argv[argv.indexOf("--memory") + 1] : undefined;
  if (memFlag === "shared") options.sharedMemory = true;
  else if (memFlag === "isolated") options.sharedMemory = false;
  else if (
    memFlag === undefined &&
    process.stdin.isTTY &&
    agents.some((a) => a === "workbuddy" || a === "kunlunxiaozhi")
  ) {
    process.stdout.write(
      [
        "",
        "Memory topology for WorkBuddy / KunlunXiaoZhi hosts:",
        "  1) shared   - both hosts write into ONE shared memory pool (agent:workbuddy)",
        "  2) isolated - each host keeps its own separate memory scope",
        "Choose [1/2, default 1]: ",
      ].join("\n"),
    );
    // Synchronous-ish read is overkill; defer decision to caller via env-free answer:
    // resolve with readline promise below in the async wrapper.
    options.sharedMemory = true; // provisional; refined in async prompt below
    const askShared = async () => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = (await rl.question("")).trim();
        return ans === "2" ? false : true;
      } finally {
        rl.close();
      }
    };
    (options as { _askShared?: () => Promise<boolean> })._askShared = askShared;
  }
  if (options.sessionsRoot && agents.length !== 1) {
    throw new Error("--sessions-root can only be used with a single agent");
  }
  return {
    agents,
    options,
    serviceOptions: {
      ...options,
      host: parsed.serviceOptions.host,
      port: parsed.serviceOptions.port,
      start: parsed.serviceOptions.start,
    },
    skipService: parsed.skipService,
  };
}

async function runUpdate(argv: string[]): Promise<void> {
  parseInstallArgs(argv);
  await runCommand("git", ["pull", "--ff-only"]);
  await runCommand("npm", ["install"]);
  await runCommand("npm", ["run", "build"]);
  await runCommand(process.execPath, [fileURLToPath(import.meta.url), "install", ...argv]);
  process.stdout.write("LeafMem code, dependencies, MCP config, instructions, and service entries are updated.\n");
  process.stdout.write(`${defaultMemoryMcpStoragePath()} was not deleted.\n`);
}

function parseUiArgs(argv: string[]) {
  let port = 3377;
  let host = "127.0.0.1";
  const agentOptions: AgentInstallOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      port = Number.parseInt(readFlagValue(argv, ++index, arg), 10);
      continue;
    }
    if (arg === "--host") {
      host = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--storage-path") {
      agentOptions.storagePath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--mcp-path") {
      agentOptions.mcpPath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--home") {
      agentOptions.home = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Invalid --port value");
  }

  return { port, host, options: resolveAgentOptions(agentOptions) };
}

function parseTuiArgs(argv: string[]) {
  let once = false;
  const agentOptions: AgentInstallOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--storage-path") {
      agentOptions.storagePath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--mcp-path") {
      agentOptions.mcpPath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--home") {
      agentOptions.home = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { once, options: resolveAgentOptions(agentOptions) };
}

function parseSharedAgentOptions(
  argv: string[],
  startIndex: number,
): { agentOptions: AgentInstallOptions; serviceOptions: AgentServiceOptions; skipService: boolean } {
  const agentOptions: AgentInstallOptions = {};
  const serviceOptions: AgentServiceOptions = {};
  let skipService = false;

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--storage-path") {
      const value = readFlagValue(argv, ++index, arg);
      agentOptions.storagePath = value;
      serviceOptions.storagePath = value;
      continue;
    }
    if (arg === "--mcp-path") {
      const value = readFlagValue(argv, ++index, arg);
      agentOptions.mcpPath = value;
      serviceOptions.mcpPath = value;
      continue;
    }
    if (arg === "--sessions-root") {
      agentOptions.sessionsRoot = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--home") {
      const value = readFlagValue(argv, ++index, arg);
      agentOptions.home = value;
      serviceOptions.home = value;
      continue;
    }
    if (arg === "--skip-mcp") {
      agentOptions.skipMcp = true;
      continue;
    }
    if (arg === "--skip-import") {
      agentOptions.skipImport = true;
      continue;
    }
    if (arg === "--skip-instructions") {
      agentOptions.skipInstructions = true;
      continue;
    }
    if (arg === "--skip-service") {
      skipService = true;
      continue;
    }
    if (arg === "--no-service-start") {
      serviceOptions.start = false;
      continue;
    }
    if (arg === "--service-port") {
      serviceOptions.port = Number.parseInt(readFlagValue(argv, ++index, arg), 10);
      continue;
    }
    if (arg === "--service-host") {
      serviceOptions.host = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { agentOptions, serviceOptions, skipService };
}

function parseServeArgs(argv: string[]): AgentServiceOptions {
  const options: AgentServiceOptions = { start: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      options.configPath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--home") {
      options.home = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseServiceArgs(argv: string[]) {
  const command = argv[0];
  if (!command) {
    throw new Error("Missing service command");
  }
  const options: AgentServiceOptions = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--storage-path") {
      options.storagePath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--mcp-path") {
      options.mcpPath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--home") {
      options.home = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--host") {
      options.host = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--port") {
      options.port = Number.parseInt(readFlagValue(argv, ++index, arg), 10);
      continue;
    }
    if (arg === "--config") {
      options.configPath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--no-start") {
      options.start = false;
      continue;
    }
    if (arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { command, options };
}

async function runUi(input: {
  port: number;
  host: string;
  options: ReturnType<typeof resolveAgentOptions>;
}): Promise<void> {
  const memory = createLeafMem({
    storage: {
      backend: "sqlite",
      path: input.options.storagePath,
    },
  });
  const events = new SqliteInspectEventStore(input.options.storagePath);
  const platform = new LeafMemPlatformService({ memory, events });
  const projects = new ProjectStore();
  const { apiKey, project } = projects.create("Local LeafMem");
  const server = createLeafMemServer({
    platform,
    projects,
    events,
    port: input.port,
    host: input.host,
    consolePath: defaultConsolePath(),
    consoleApiKey: apiKey,
    agents: {
      home: input.options.home,
      storagePath: input.options.storagePath,
      mcpPath: input.options.mcpPath,
    },
  });

  await server.listen();

  process.stdout.write(
    [
      "LeafMem agent setup UI",
      `Console: ${server.address}/console#agents`,
      `API Key: ${apiKey}`,
      `Project ID: ${project.id}`,
      `Storage: ${input.options.storagePath}`,
      `MCP Path: ${input.options.mcpPath || defaultAgentMcpPath()}`,
      "",
    ].join("\n"),
  );
}

/**
 * Custom: build retrieval config from env vars so the agent serve (console)
 * path uses the same semantic retrieval as the production MCP path.
 * Reads LEAFMEM_EMBEDDINGS_PROVIDER / _MODEL / _BASE_URL; returns undefined
 * when unconfigured (falls back to builtin lexical search).
 */
function buildServeRetrievalConfig(env: NodeJS.ProcessEnv): LeafMemOptions["retrieval"] | undefined {
  const provider = leafmemEnv("EMBEDDINGS_PROVIDER", env)?.trim();
  if (!provider) {
    return undefined;
  }
  const embeddingsBaseUrl = leafmemEnv("EMBEDDINGS_BASE_URL", env)?.trim();
  return {
    backend: "builtin",
    embeddings: {
      provider: provider as "openai" | "gemini" | "voyage" | "auto",
      model: leafmemEnv("EMBEDDINGS_MODEL", env)?.trim() || undefined,
      remote: embeddingsBaseUrl
        ? { baseUrl: embeddingsBaseUrl }
        : undefined,
    },
  };
}

async function runServe(input: AgentServiceOptions): Promise<void> {
  const config = await ensureAgentServiceConfig(input);
  const memory = createLeafMem({
    storage: {
      backend: "sqlite",
      path: config.storagePath,
    },
    // Custom: wire retrieval config from env so the console recall path uses
    // the same semantic retrieval (+ cross-encoder rerank) as production MCP.
    retrieval: buildServeRetrievalConfig(process.env),
    // Custom (2026-08-07 P0-1): entity subsystem (strict vocab, zero LLM).
    entityStore: new SqliteEntityStore(config.storagePath),
    entityExtractor: new RuleBasedEntityExtractor({ strict: true }),
  });
  const events = new SqliteInspectEventStore(config.storagePath);
  const platform = new LeafMemPlatformService({ memory, events });
  const projects = new ProjectStore();
  projects.register(projectFromAgentServiceConfig(config));
  const server = createLeafMemServer({
    platform,
    projects,
    events,
    port: config.port,
    host: config.host,
    consolePath: defaultConsolePath(),
    consoleApiKey: config.apiKey,
    agents: {
      home: input.home,
      storagePath: config.storagePath,
      mcpPath: config.mcpPath,
    },
  });

  await server.listen();
  startAgentImportScheduler({
    agentOptions: {
      home: input.home,
      storagePath: config.storagePath,
      mcpPath: config.mcpPath,
    },
    runOnStart: true,
    onError(error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Agent session import failed: ${message}\n`);
    },
  });
  process.stdout.write(
    [
      "LeafMem agent service",
      `Console: ${serviceUrl(config)}`,
      `Storage: ${config.storagePath}`,
      `MCP Path: ${config.mcpPath}`,
      "",
    ].join("\n"),
  );
}

async function runService(input: { command: string; options: AgentServiceOptions }): Promise<void> {
  if (input.command === "install") {
    const result = await installAgentService(input.options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (input.command === "start") {
    await installAgentService({ ...input.options, start: false });
    await startAgentService(input.options);
    process.stdout.write(`${JSON.stringify(await getAgentServiceStatus(input.options), null, 2)}\n`);
    return;
  }
  if (input.command === "stop") {
    await stopAgentService(input.options);
    process.stdout.write(`${JSON.stringify(await getAgentServiceStatus(input.options), null, 2)}\n`);
    return;
  }
  if (input.command === "restart") {
    await stopAgentService(input.options);
    const result = await installAgentService(input.options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (input.command === "status") {
    process.stdout.write(`${JSON.stringify(await getAgentServiceStatus(input.options), null, 2)}\n`);
    return;
  }
  if (input.command === "uninstall") {
    await uninstallAgentService(input.options);
    process.stdout.write(`${JSON.stringify(await getAgentServiceStatus(input.options), null, 2)}\n`);
    return;
  }
  if (input.command === "url") {
    const config = await ensureAgentServiceConfig({ ...input.options, start: false });
    process.stdout.write(`${serviceUrl(config)}\n`);
    return;
  }
  throw new Error(`Unknown service command: ${input.command}`);
}

async function runTui(input: {
  once: boolean;
  options: ReturnType<typeof resolveAgentOptions>;
}): Promise<void> {
  if (input.once) {
    process.stdout.write(await renderTuiStatus(input.options));
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[2J\x1b[H");
      }
      process.stdout.write(await renderTuiStatus(input.options));
      process.stdout.write("\nActions\n");
      process.stdout.write("  1) Install all\n");
      process.stdout.write("  2) Import all\n");
      process.stdout.write("  3) Install agent\n");
      process.stdout.write("  4) Import agent\n");
      process.stdout.write("  r) Refresh\n");
      process.stdout.write("  q) Quit\n\n");

      const choice = (await rl.question("Select action: ")).trim().toLowerCase();
      if (choice === "q" || choice === "quit") {
        break;
      }
      if (choice === "r" || choice === "refresh" || choice === "") {
        continue;
      }

      try {
        if (choice === "1") {
          for (const agent of AGENT_IDS) {
            await installAgent(agent, input.options);
          }
          await pause(rl, "Installed all agents.");
          continue;
        }
        if (choice === "2") {
          for (const agent of AGENT_IDS) {
            await importSessions(agent, input.options);
          }
          await pause(rl, "Imported all agents.");
          continue;
        }
        if (choice === "3") {
          const agent = await askAgent(rl);
          if (agent) {
            await installAgent(agent, input.options);
            await pause(rl, `Installed ${agent}.`);
          }
          continue;
        }
        if (choice === "4") {
          const agent = await askAgent(rl);
          if (agent) {
            await importSessions(agent, input.options);
            await pause(rl, `Imported ${agent}.`);
          }
          continue;
        }
        await pause(rl, `Unknown action: ${choice}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await pause(rl, `Operation failed: ${message}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function renderTuiStatus(options: ReturnType<typeof resolveAgentOptions>): Promise<string> {
  const statuses = await getAgentStatuses(options);
  const rows = statuses.map((status, index) => [
    String(index + 1),
    status.label,
    status.mcp.configured && status.mcp.storagePathMatches ? "ready" : status.mcp.configured ? "wrong-db" : "missing",
    status.instructions.supported ? (status.instructions.installed ? "installed" : "missing") : "n/a",
    status.sessions.rootExists ? "found" : "missing",
    `${status.imported.memories}/${status.imported.tasks}`,
  ]);

  return [
    "LeafMem Agent TUI",
    `Storage: ${options.storagePath}`,
    `MCP:     ${options.mcpPath}`,
    "",
    formatTable([
      ["#", "Agent", "MCP", "Instructions", "Sessions", "Imported M/T"],
      ...rows,
    ]),
    "",
  ].join("\n");
}

function formatTable(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row, index) => {
      const line = row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ");
      return index === 0 ? `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}` : line;
    })
    .join("\n");
}

async function askAgent(rl: ReturnType<typeof createInterface>): Promise<AgentId | null> {
  process.stdout.write("\nAgents\n");
  AGENT_IDS.forEach((agent, index) => {
    process.stdout.write(`  ${index + 1}) ${agent}\n`);
  });
  const answer = (await rl.question("\nSelect agent: ")).trim().toLowerCase();
  const byIndex = Number.parseInt(answer, 10);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= AGENT_IDS.length) {
    return AGENT_IDS[byIndex - 1]!;
  }
  return isAgentId(answer) ? answer : null;
}

async function pause(rl: ReturnType<typeof createInterface>, message: string): Promise<void> {
  await rl.question(`\n${message}\nPress Enter to continue.`);
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot(),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

function repoRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function defaultConsolePath(): string {
  const current = fileURLToPath(import.meta.url);
  return join(dirname(dirname(current)), "console");
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
