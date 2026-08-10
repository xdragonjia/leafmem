import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { apiKeyPrefix, generateApiKey, hashApiKey } from "../auth/keys.js";
import type { Project } from "../auth/types.js";
import { defaultMemoryMcpStoragePath } from "../mcp/stdio.js";
import { agentBinPath, defaultAgentMcpPath, resolveAgentOptions, type AgentInstallOptions, type ResolvedAgentInstallOptions } from "./manager.js";

export const AGENT_SERVICE_LABEL = "com.leafmem.agent";
const DEFAULT_AGENT_SERVICE_HOST = "127.0.0.1";
const DEFAULT_AGENT_SERVICE_PORT = 3377;
/** Phase 9 (Win11 support): launchd-based resident service is macOS-only.
 *  Core memory/MCP/console paths are fully cross-platform (node:sqlite has
 *  no native deps); only the LaunchAgent persistence layer is darwin-only. */
export const IS_MACOS = process.platform === "darwin";
export const IS_WINDOWS = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";
const WIN_TASK_NAME = "LeafMemAgent";

export type AgentServiceConfig = {
  host: string;
  port: number;
  storagePath: string;
  mcpPath: string;
  apiKey: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentServiceOptions = AgentInstallOptions & {
  host?: string;
  port?: number;
  configPath?: string;
  start?: boolean;
};

export type ResolvedAgentServiceOptions = ResolvedAgentInstallOptions & {
  host: string;
  port: number;
  configPath: string;
  plistPath: string;
  logPath: string;
  errorLogPath: string;
  cliPath: string;
  start: boolean;
};

export type AgentServiceInstallResult = {
  configPath: string;
  plistPath: string;
  url: string;
  apiKeyPrefix: string;
  started: boolean;
  /** Present when the resident service cannot be installed on this platform. */
  serviceUnsupported?: string;
};

export type AgentServiceStatus = {
  configured: boolean;
  installed: boolean;
  running: boolean;
  configPath: string;
  plistPath: string;
  url?: string;
};

export function resolveAgentServiceOptions(input: AgentServiceOptions = {}): ResolvedAgentServiceOptions {
  const agentOptions = resolveAgentOptions(input);
  const home = agentOptions.home;
  const host = input.host ?? DEFAULT_AGENT_SERVICE_HOST;
  const port = input.port ?? DEFAULT_AGENT_SERVICE_PORT;
  if (!host.trim()) {
    throw new Error("Invalid service host");
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Invalid service port");
  }
  return {
    ...agentOptions,
    host,
    port,
    configPath: input.configPath ?? defaultAgentServiceConfigPath(home),
    plistPath: defaultAgentServiceArtifactPath(home),
    logPath: join(home, ".leafmem", "agent-service.out.log"),
    errorLogPath: join(home, ".leafmem", "agent-service.err.log"),
    cliPath: agentBinPath("leafmem-agent"),
    start: input.start ?? true,
  };
}

export function defaultAgentServiceConfigPath(home = homedir()): string {
  return join(home, ".leafmem", "agent-service.json");
}

export function defaultAgentServicePlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${AGENT_SERVICE_LABEL}.plist`);
}

/** On-disk autostart artifact per platform. Windows uses Task Scheduler (no file). */
export function defaultAgentServiceArtifactPath(home = homedir()): string {
  if (IS_MACOS) return defaultAgentServicePlistPath(home);
  if (IS_LINUX) return join(home, ".config", "systemd", "user", "leafmem-agent.service");
  return "";
}

export async function installAgentService(input: AgentServiceOptions = {}): Promise<AgentServiceInstallResult> {
  const options = resolveAgentServiceOptions(input);
  const config = await ensureAgentServiceConfig(input);
  await writeAgentServiceArtifact(options);
  if (options.start) {
    await startAgentService(options);
  }
  return {
    configPath: options.configPath,
    plistPath: options.plistPath,
    url: serviceUrl(config),
    apiKeyPrefix: apiKeyPrefix(config.apiKey),
    started: options.start,
  };
}

export async function ensureAgentServiceConfig(input: AgentServiceOptions | ResolvedAgentServiceOptions = {}): Promise<AgentServiceConfig> {
  const options = "configPath" in input && "plistPath" in input ? input : resolveAgentServiceOptions(input);
  const existing = await readAgentServiceConfig(options.configPath);
  const now = new Date().toISOString();
  const config: AgentServiceConfig = existing
    ? {
        ...existing,
        host: hasOwn(input, "host") ? options.host : existing.host,
        port: hasOwn(input, "port") ? options.port : existing.port,
        storagePath: hasOwn(input, "storagePath") ? options.storagePath : existing.storagePath,
        mcpPath: hasOwn(input, "mcpPath") ? options.mcpPath || defaultAgentMcpPath() : existing.mcpPath,
        updatedAt: now,
      }
    : {
        host: options.host,
        port: options.port,
        storagePath: options.storagePath || defaultMemoryMcpStoragePath(),
        mcpPath: options.mcpPath || defaultAgentMcpPath(),
        apiKey: generateApiKey(),
        projectId: `proj_local_${Date.now().toString(36)}`,
        createdAt: now,
        updatedAt: now,
      };
  await writeAgentServiceConfig(options.configPath, config);
  return config;
}

function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export async function readAgentServiceConfig(path: string): Promise<AgentServiceConfig | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as AgentServiceConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function projectFromAgentServiceConfig(config: AgentServiceConfig): Project {
  return {
    id: config.projectId,
    name: "Local LeafMem",
    apiKeyHash: hashApiKey(config.apiKey),
    createdAt: config.createdAt,
  };
}

export async function getAgentServiceStatus(input: AgentServiceOptions = {}): Promise<AgentServiceStatus> {
  const options = resolveAgentServiceOptions({ ...input, start: false });
  const config = await readAgentServiceConfig(options.configPath);
  const installed = await isServiceInstalled(options);
  return {
    configured: Boolean(config),
    installed,
    running: config ? await isServiceHealthy(config) : false,
    configPath: options.configPath,
    plistPath: options.plistPath,
    url: config ? serviceUrl(config) : undefined,
  };
}

export async function startAgentService(input: AgentServiceOptions | ResolvedAgentServiceOptions = {}): Promise<void> {
  const options = "configPath" in input && "plistPath" in input ? input : resolveAgentServiceOptions(input);
  if (IS_MACOS) {
    await execLaunchctl(["bootstrap", launchctlDomain(), options.plistPath], true);
    await execLaunchctl(["enable", `${launchctlDomain()}/${AGENT_SERVICE_LABEL}`], true);
    await execLaunchctl(["kickstart", "-k", `${launchctlDomain()}/${AGENT_SERVICE_LABEL}`]);
    return;
  }
  if (IS_LINUX) {
    // systemd user session may be absent on headless/CI hosts; degrade gracefully.
    await execCmd("systemctl", ["--user", "daemon-reload"], true);
    await execCmd("systemctl", ["--user", "enable", "--now", "leafmem-agent.service"], true);
    return;
  }
  if (IS_WINDOWS) {
    await execCmd("schtasks", ["/Run", "/TN", WIN_TASK_NAME], true);
  }
}

export async function stopAgentService(input: AgentServiceOptions = {}): Promise<void> {
  const options = resolveAgentServiceOptions({ ...input, start: false });
  if (IS_MACOS) {
    await execLaunchctl(["bootout", launchctlDomain(), options.plistPath], true);
    return;
  }
  if (IS_LINUX) {
    await execCmd("systemctl", ["--user", "disable", "--now", "leafmem-agent.service"], true);
    return;
  }
  if (IS_WINDOWS) {
    await execCmd("schtasks", ["/End", "/TN", WIN_TASK_NAME], true);
  }
}

export async function uninstallAgentService(input: AgentServiceOptions = {}): Promise<void> {
  const options = resolveAgentServiceOptions({ ...input, start: false });
  await stopAgentService(options);
  if (IS_WINDOWS) {
    await execCmd("schtasks", ["/Delete", "/TN", WIN_TASK_NAME, "/F"], true);
    return;
  }
  await rm(options.plistPath, { force: true });
  if (IS_LINUX) await execCmd("systemctl", ["--user", "daemon-reload"], true);
}

export function serviceUrl(config: AgentServiceConfig): string {
  return `http://${config.host}:${config.port}/console?apiKey=${encodeURIComponent(config.apiKey)}#dashboard`;
}

async function writeAgentServiceConfig(path: string, config: AgentServiceConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeAgentServiceArtifact(options: ResolvedAgentServiceOptions): Promise<void> {
  if (IS_WINDOWS) {
    await execCmd("schtasks", [
      "/Create", "/TN", WIN_TASK_NAME, "/TR", windowsTaskCommand(options),
      "/SC", "ONLOGON", "/RL", "LIMITED", "/F",
    ], true);
    return;
  }
  if (IS_LINUX) {
    await writeLinuxUnit(options);
    return;
  }
  await writeAgentServicePlist(options);
}

function windowsTaskCommand(options: ResolvedAgentServiceOptions): string {
  return `"${process.execPath}" "${options.cliPath}" serve --config "${options.configPath}"`;
}

async function writeLinuxUnit(options: ResolvedAgentServiceOptions): Promise<void> {
  await mkdir(dirname(options.plistPath), { recursive: true });
  const unit = [
    "[Unit]",
    "Description=LeafMem resident console service",
    "After=network.target",
    "",
    "[Service]",
    `ExecStart="${process.execPath}" "${options.cliPath}" serve --config "${options.configPath}"`,
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  await writeFile(options.plistPath, unit);
}

async function isServiceInstalled(options: ResolvedAgentServiceOptions): Promise<boolean> {
  if (IS_WINDOWS) {
    try {
      await execCmd("schtasks", ["/Query", "/TN", WIN_TASK_NAME]);
      return true;
    } catch {
      return false;
    }
  }
  return await fileExists(options.plistPath);
}

async function execCmd(file: string, args: string[], ignoreError = false): Promise<void> {
  try {
    await execFileAsync(file, args);
  } catch (error) {
    if (ignoreError) return;
    throw error;
  }
}

async function writeAgentServicePlist(options: ResolvedAgentServiceOptions): Promise<void> {
  await mkdir(dirname(options.plistPath), { recursive: true });
  // Custom (LeafMem B6, 2026-08-08): preserve an existing EnvironmentVariables
  // block when rewriting the plist. The reranker/embedding/API-key variables
  // live in the service environment; a plain rewrite would silently drop them
  // and degrade the service to builtin lexical search (the pre-rename plist
  // had these added manually, so reinstall must not lose them).
  const envBlock = await readExistingEnvBlock(options.plistPath);
  const content = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${AGENT_SERVICE_LABEL}</string>`,
    ...(envBlock ? envBlock : []),
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${escapeXml(process.execPath)}</string>`,
    `    <string>${escapeXml(options.cliPath)}</string>`,
    `    <string>serve</string>`,
    `    <string>--config</string>`,
    `    <string>${escapeXml(options.configPath)}</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(options.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(options.errorLogPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
  await writeFile(options.plistPath, content);
}

/**
 * Custom (LeafMem B6, 2026-08-08): extract the EnvironmentVariables block from
 * an existing plist so a rewrite does not drop service environment (reranker,
 * embeddings, API keys). Returns undefined when the file or block is absent.
 */
async function readExistingEnvBlock(plistPath: string): Promise<string[] | undefined> {
  let existing: string;
  try {
    existing = await readFile(plistPath, "utf8");
  } catch {
    return undefined;
  }
  const start = existing.indexOf("<key>EnvironmentVariables</key>");
  if (start === -1) {
    return undefined;
  }
  // Capture from the key through the closing </dict> of its value dictionary.
  const dictStart = existing.indexOf("<dict>", start);
  const dictEnd = existing.indexOf("</dict>", dictStart);
  if (dictStart === -1 || dictEnd === -1) {
    return undefined;
  }
  const block = existing.slice(start, dictEnd + "</dict>".length);
  return block
    .split("\n")
    .map((line) => line.replace(/^\s{0,2}/, "  ").trimEnd())
    .filter((line) => line.trim() !== "");
}

async function isServiceHealthy(config: AgentServiceConfig): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/v1/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function launchctlDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("LaunchAgent services are only supported on Unix-like systems");
  }
  return `gui/${uid}`;
}

async function execLaunchctl(args: string[], ignoreAlreadyDone = false): Promise<void> {
  try {
    await execFileAsync("launchctl", args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ignoreAlreadyDone && /already|service.*not.*found|No such process|Input\/output error/i.test(message)) {
      return;
    }
    throw error;
  }
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve();
    });
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
