import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LeafMem } from "../core/memory.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import { versionLine, writeMarkedBlock } from "../agents/marked-block.js";
import {
  parseMarkdownEntries,
  readTextFile,
  renderMarkdownList,
  writeMarkdownListFile,
} from "./markdown-sync.js";

const DEFAULT_WORKBUDDY_SCOPE: MemoryScope = { type: "agent", id: "workbuddy" };
const DEFAULT_SOUL_MAX_CHARS = 1_375;
const DEFAULT_USER_MAX_CHARS = 1_375;
const DEFAULT_MEMORY_MAX_CHARS = 2_200;
const WORKBUDDY_INSTRUCTIONS_START = "<!-- leafmem-agent-instructions:start -->";
const WORKBUDDY_INSTRUCTIONS_END = "<!-- leafmem-agent-instructions:end -->";

export type WorkBuddyMemoryPaths = {
  homePath: string;
  soulPath: string;
  userPath: string;
  memoryPath: string;
  identityPath: string;
  agentsPath: string;
  systemPath: string;
  nativeMemoryDir: string;
};

export type WorkBuddyImportResult = {
  imported: number;
  soulEntries: number;
  userEntries: number;
  memoryEntries: number;
  identityEntries: number;
  agentsEntries: number;
  systemEntries: number;
  nativeMemoryEntries: number;
  skippedLargeFiles?: number;
};

export type WorkBuddyMemoryAdapter = {
  paths: WorkBuddyMemoryPaths;
  importExistingMemory(): Promise<WorkBuddyImportResult>;
  syncProjection(): Promise<void>;
  /** 2026-08-11: sha256 over the six source files + native memory dir listing,
   * for import idempotency — skip re-import when sources are unchanged. */
  sourceFingerprint(): Promise<string>;
};

export function createWorkBuddyMemoryAdapter(params: {
  memory: LeafMem;
  defaultScopes?: MemoryScope[];
  files?: Partial<WorkBuddyMemoryPaths>;
  soulMaxChars?: number;
  userMaxChars?: number;
  memoryMaxChars?: number;
}): WorkBuddyMemoryAdapter {
  const defaultScopes = params.defaultScopes?.length
    ? params.defaultScopes
    : [DEFAULT_WORKBUDDY_SCOPE];
  const paths = resolveWorkBuddyPaths(params.files);

  return {
    paths,
    importExistingMemory,
    syncProjection,
    sourceFingerprint,
  };

  async function sourceFingerprint(): Promise<string> {
    const targets = ["soul", "user", "memory", "identity", "agents", "system"] as const;
    const hash = createHash("sha256");
    for (const target of targets) {
      const path = resolveEntryPath(target);
      hash.update(`${target}\x00`);
      hash.update((await readTextFile(path)) ?? "");
      hash.update("\x00");
    }
    const nativePaths = await listNativeMemoryFiles();
    for (const path of nativePaths) {
      hash.update(`${path}\x00`);
      hash.update((await readTextFile(path)) ?? "");
      hash.update("\x00");
    }
    return hash.digest("hex");
  }

  async function importExistingMemory(): Promise<WorkBuddyImportResult> {
    const [soulEntries, userEntries, memoryEntries, identityEntries, agentsEntries, systemEntries, nativeMemoryEntries] =
      await Promise.all([
        importEntries("soul"),
        importEntries("user"),
        importEntries("memory"),
        importEntries("identity"),
        importEntries("agents"),
        importEntries("system"),
        importNativeMemory(),
      ]);

    return {
      imported: soulEntries + userEntries + memoryEntries + identityEntries + agentsEntries + systemEntries + nativeMemoryEntries,
      soulEntries,
      userEntries,
      memoryEntries,
      identityEntries,
      agentsEntries,
      systemEntries,
      nativeMemoryEntries,
    };
  }

  async function syncProjection(): Promise<void> {
    await importExistingMemory();

    const records = await params.memory.list({ scopes: defaultScopes });
    const soulEntries = records
      .filter((record) => classifyWorkBuddyRecord(record) === "soul")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));
    const userEntries = records
      .filter((record) => classifyWorkBuddyRecord(record) === "user")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));
    const memoryEntries = records
      .filter((record) => classifyWorkBuddyRecord(record) === "memory")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));

    await Promise.all([
      writeMarkdownListFile(
        paths.soulPath,
        soulEntries,
        params.soulMaxChars ?? DEFAULT_SOUL_MAX_CHARS,
      ),
      writeMarkdownListFile(
        paths.userPath,
        userEntries,
        params.userMaxChars ?? DEFAULT_USER_MAX_CHARS,
      ),
      writeWorkBuddyMemoryProjection(
        paths.memoryPath,
        memoryEntries,
        params.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS,
      ),
    ]);
  }

  async function importEntries(target: "soul" | "user" | "memory" | "identity" | "agents" | "system"): Promise<number> {
    const scope = defaultScopes[0]!;
    const path = resolveEntryPath(target);
    const content = (await readTextFile(path)) ?? "";
    const entries = parseMarkdownEntries(target === "memory" ? stripWorkBuddyInstructions(content) : content);
    if (entries.length === 0) {
      return 0;
    }

    const existing = new Set(
      (await params.memory.list({ scopes: defaultScopes }))
        .filter((record) => classifyWorkBuddyRecord(record) === target)
        .flatMap((record) => [record.content.trim(), summarizeRecord(record)])
        .filter(Boolean),
    );

    let imported = 0;
    for (const entry of entries) {
      if (existing.has(entry)) {
        continue;
      }
      await params.memory.remember({
        scope,
        kind: entryKind(target),
        content: entry,
        summary: entry,
        source: "workbuddy_import",
        tags: ["workbuddy", target],
        metadata: { projectionTarget: target },
      });
      existing.add(entry);
      imported += 1;
    }
    return imported;
  }

  function resolveEntryPath(target: "soul" | "user" | "memory" | "identity" | "agents" | "system"): string {
    switch (target) {
      case "soul":
        return paths.soulPath;
      case "user":
        return paths.userPath;
      case "memory":
        return paths.memoryPath;
      case "identity":
        return paths.identityPath;
      case "agents":
        return paths.agentsPath;
      case "system":
        return paths.systemPath;
    }
  }

  async function importNativeMemory(): Promise<number> {
    const scope = defaultScopes[0]!;
    const paths = await listNativeMemoryFiles();
    if (paths.length === 0) {
      return 0;
    }
    const existingRecords = await params.memory.list({ scopes: defaultScopes });
    let imported = 0;
    for (const path of paths) {
      const parsed = parseNativeMemoryFile((await readTextFile(path)) ?? "");
      if (!parsed.content) {
        continue;
      }
      const existing = existingRecords.find((record) => {
        const metadata = record.metadata ?? {};
        return metadata.nativeMemoryPath === path;
      });
      const metadata = {
        nativeMemoryPath: path,
        uid: parsed.uid,
        version: parsed.version,
        updatedAt: parsed.updatedAt,
        projectionTarget: "memory",
      };
      const patch = {
        scope,
        kind: "note",
        content: parsed.content,
        summary: parsed.summary,
        source: "workbuddy_native_import",
        tags: ["workbuddy", "native-memory"],
        metadata,
      };
      if (existing) {
        if (existing.content === parsed.content && existing.summary === parsed.summary) {
          continue;
        }
        await params.memory.update(existing.id, patch);
      } else {
        await params.memory.remember(patch);
      }
      imported += 1;
    }
    return imported;
  }

  async function listNativeMemoryFiles(): Promise<string[]> {
    try {
      const entries = await readdir(paths.nativeMemoryDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith("_memory.md"))
        .map((entry) => join(paths.nativeMemoryDir, entry.name))
        .sort();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

/**
 * Write (or refresh) the LeafMem instruction block into a host discipline
 * file. `placement` controls where a fresh block lands:
 * - "top": pinned at the very top of the file (right after the leading H1
 *   title line, if any). Used for SOUL.md so the memory workflow outranks
 *   every other behavioral rule — SOUL.md is the first file the host loads.
 * - "bottom": appended after existing content. Used for MEMORY.md.
 * Existing blocks are always replaced in place (idempotent updates).
 */
export async function writeWorkBuddyInstructions(
  path: string,
  updateCommand?: string,
  placement: "top" | "bottom" = "bottom",
  scopeId?: string,
): Promise<boolean> {
  // 2026-10-21: delegate to the guarded writer (version mark + backup + atomic rename +
  // post-write proof that everything outside the block is byte-identical, and refusal to
  // append a duplicate block when the markers are malformed).
  const result = await writeMarkedBlock(path, workBuddyInstructionBlock(updateCommand, scopeId), {
    position: placement,
  });
  return result.changed;
}

/**
 * The injected discipline block. 2026-08-15 generalization: rules that every
 * install needs (write-quality discipline, parameter/channel hard rules, the
 * Stop-gate response, record-placement discipline, tool-error workaround) were
 * promoted from host-specific SOUL.md sections into this template so any new
 * install gets them automatically. Machine-specific items (mirror paths, local
 * automations) stay in the host's own SOUL.md outside the block.
 *
 * `scopeId` parameterizes the default write scope (workbuddy / kunlunxiaozhi)
 * so the same template is correct for both hosts.
 */
export function workBuddyInstructionBlock(updateCommand?: string, scopeId = "workbuddy"): string {
  const updateLine = updateCommand
    ? `- When the user asks to update or upgrade LeafMem, the memory module, or the memory connector, run \`${updateCommand}\` and then ask the host to refresh or reconnect the LeafMem MCP service if needed.`
    : "- When the user asks to update or upgrade LeafMem, the memory module, or the memory connector, run the local `leafmem-agent update workbuddy` command and then ask the host to refresh or reconnect the LeafMem MCP service if needed.";
  return `${WORKBUDDY_INSTRUCTIONS_START}
${versionLine()}
LeafMem memory workflow (v2 — compact; every bullet is load-bearing):

- **Recall before answering** — **Lifecycle hooks are the primary path** (if installed): the UserPromptSubmit hook already injects a "LeafMem recall" block — use it and do not recall again. **Do this silently**; never mention the rule or the tool call. Without hooks, call \`memory_recall\` with \`action:"recall"\` and a non-empty \`message\` using the user's own wording. Skip trivial self-contained requests.
- **Write in three shapes** — durable fact/preference/decision: \`memory_write\` \`action:"remember"\`; running step: \`action:"task_append"\` (taskId + role + content); session close: \`action:"commit"\` with **\`agent\`**, **\`sessionId\`**, **\`rollingSummary\`** (optionally \`taskId\`, \`entries\`, \`activeContext\`/\`activeExperience\`). Durable writes **defaults writes to \`agent:${scopeId}\`** unless a narrower project/repo scope is clearly available.
- **Write quality** — self-contained one-line conclusion first, then context/action; ≥100 chars, atomic, no dangling pronouns; kinds limited to lesson/preference/decision/note/experience/principle; never write transient chat. Before writing, recall the same topic: update the existing record instead of duplicating; on contradiction state "used X until <date>, now Y because …".
- **Parameter/channel hard rules** — \`importance\`/\`confidence\` are numbers (0.9, never "0.9"); \`tags\` is a flat array; \`source\` only for a standard channel (\`manual\`/\`automation\`/\`skill\`/\`user-feedback\`), never invented one-off values. NEVER write the SQLite store directly — only the MCP tools may write it. On a schema-shaped error, self-check parameter types first.
- **Placement** — unfinished/follow-up items go into \`task_append\` **with \`status:"active"\` in the same call**; never park pending items in \`activeContext\` (single global slot) and never leave pending wording on a completed task. If \`commit\` returns \`maintenanceRequest\`, immediately call \`memory_organize\` \`action:"apply"\` with the distilled context/experience.
- **Automation/scheduled sessions** — the host does not expose \`mcp__leafmem__*\`; use \`bash ~/.leafmem/leafmem-cli.sh\` as the PRIMARY channel (recall/remember/update/list/commit-summary). Its absence from the tool list is expected — don't retry via ToolSearch and don't declare the service down from one failure; last resort is the host's conversation search (read-only). Never rely on host search alone when LeafMem context could change the answer.
${updateLine}
- **Corrections & curation** — \`memory_govern\` (\`update\`/\`delete\`/\`pin\`) for fixes, \`memory_organize\` (\`reflect\`/\`profile\`/\`decay\`/\`apply\`) for curation.
${WORKBUDDY_INSTRUCTIONS_END}`;
}

export async function installWorkBuddyMemoryTakeover(params: Parameters<typeof createWorkBuddyMemoryAdapter>[0]): Promise<{
  adapter: WorkBuddyMemoryAdapter;
  imported: WorkBuddyImportResult;
}> {
  const adapter = createWorkBuddyMemoryAdapter(params);
  // syncProjection deliberately removed (2026-08-06): SOUL.md/USER.md/MEMORY.md
  // are user-authoritative files, never project memory back onto them.
  // Import direction is read-files -> write-DB only.
  const imported = await adapter.importExistingMemory();
  return { adapter, imported };
}

export function resolveWorkBuddyPaths(files?: Partial<WorkBuddyMemoryPaths>): WorkBuddyMemoryPaths {
  const homePath = files?.homePath ?? join(homedir(), ".workbuddy");
  return {
    homePath,
    soulPath: files?.soulPath ?? join(homePath, "SOUL.md"),
    userPath: files?.userPath ?? join(homePath, "USER.md"),
    memoryPath: files?.memoryPath ?? join(homePath, "MEMORY.md"),
    identityPath: files?.identityPath ?? join(homePath, "IDENTITY.md"),
    agentsPath: files?.agentsPath ?? join(homePath, "AGENTS.md"),
    systemPath: files?.systemPath ?? join(homePath, "SYSTEM.md"),
    nativeMemoryDir: files?.nativeMemoryDir ?? join(homePath, "memory"),
  };
}

type WorkBuddyEntryTarget = "soul" | "user" | "memory" | "identity" | "agents" | "system";

function entryKind(target: WorkBuddyEntryTarget): MemoryRecord["kind"] {
  switch (target) {
    case "user":
      return "preference";
    case "soul":
    case "identity":
      return "identity";
    case "agents":
    case "system":
      return "principle";
    default:
      return "note";
  }
}

function classifyWorkBuddyRecord(record: MemoryRecord): "soul" | "user" | "memory" | "identity" | "agents" | "system" {
  const metadataTarget =
    record.metadata && typeof record.metadata.projectionTarget === "string"
      ? record.metadata.projectionTarget
      : undefined;
  if (metadataTarget === "soul" || metadataTarget === "user" || metadataTarget === "memory") {
    return metadataTarget;
  }
  if (
    metadataTarget === "identity" ||
    metadataTarget === "agents" ||
    metadataTarget === "system"
  ) {
    return metadataTarget;
  }
  if (record.tags.includes("soul")) {
    return "soul";
  }
  if (record.kind === "preference" || record.tags.includes("user")) {
    return "user";
  }
  return "memory";
}

function summarizeRecord(record: MemoryRecord): string {
  return record.summary?.trim() || record.content.trim();
}

async function writeWorkBuddyMemoryProjection(
  path: string,
  entries: string[],
  maxChars?: number,
): Promise<void> {
  const current = (await readTextFile(path)) ?? "";
  const rendered = renderMarkdownList(entries, maxChars);
  const base = rendered ? `${rendered}\n` : "";
  const next = hasWorkBuddyInstructions(current)
    ? replaceWorkBuddyInstructions(base, extractWorkBuddyInstructions(current) ?? workBuddyInstructionBlock())
    : base;
  await writeText(path, next);
}

function replaceWorkBuddyInstructions(content: string, block: string, placement: "top" | "bottom" = "bottom"): string {
  const stripped = stripWorkBuddyInstructions(content).trim();
  if (!stripped) {
    return `${block}\n`;
  }
  if (placement === "bottom") {
    return `${stripped}\n\n${block}\n`;
  }
  // placement === "top": pin the block right after the leading H1 title line
  // (if any) so the memory workflow outranks all other behavioral rules.
  const lines = stripped.split("\n");
  if (lines[0]?.startsWith("# ")) {
    const title = lines[0];
    const rest = lines.slice(1).join("\n").trimStart();
    return rest ? `${title}\n\n${block}\n\n${rest}\n` : `${title}\n\n${block}\n`;
  }
  return `${block}\n\n${stripped}\n`;
}

function stripWorkBuddyInstructions(content: string): string {
  const block = extractWorkBuddyInstructions(content);
  if (!block) {
    return content;
  }
  return content.replace(block, "").trim();
}

function extractWorkBuddyInstructions(content: string): string | undefined {
  const startIndex = content.indexOf(WORKBUDDY_INSTRUCTIONS_START);
  const endIndex = content.indexOf(WORKBUDDY_INSTRUCTIONS_END);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }
  return content.slice(startIndex, endIndex + WORKBUDDY_INSTRUCTIONS_END.length);
}

function hasWorkBuddyInstructions(content: string): boolean {
  return content.includes(WORKBUDDY_INSTRUCTIONS_START);
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function parseNativeMemoryFile(content: string): {
  content: string;
  summary: string;
  uid?: string;
  version?: number;
  updatedAt?: string;
} {
  const rawJson = content.match(/<!-- RAW_JSON_START\s*([\s\S]*?)\s*RAW_JSON_END -->/);
  if (rawJson?.[1]) {
    const parsed = JSON.parse(rawJson[1]) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const memoryBlock = typeof record.memoryBlock === "string" ? record.memoryBlock.trim() : "";
      if (memoryBlock) {
        return {
          content: memoryBlock,
          summary: nativeMemorySummary(record),
          uid: typeof record.uid === "string" ? record.uid : undefined,
          version: typeof record.version === "number" ? record.version : undefined,
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
        };
      }
    }
  }
  const withoutRaw = content.replace(/<!-- RAW_JSON_START[\s\S]*?RAW_JSON_END -->/g, "").trim();
  return {
    content: withoutRaw,
    summary: "WorkBuddy native memory profile",
  };
}

function nativeMemorySummary(record: Record<string, unknown>): string {
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : undefined;
  const version = typeof record.version === "number" ? record.version : undefined;
  return [
    "WorkBuddy native memory profile",
    version ? `v${version}` : "",
    updatedAt ? `updated ${updatedAt}` : "",
  ].filter(Boolean).join(" ");
}
