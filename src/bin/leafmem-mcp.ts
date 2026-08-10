#!/usr/bin/env node

import { parseMemoryScopeType, type MemoryScope } from "../core/types.js";
import { defaultMemoryMcpStoragePath, runMemoryMcpStdioServer } from "../mcp/stdio.js";
import { createLeafMem, type LeafMemOptions } from "../core/memory.js";
import { createWorkBuddyMemoryAdapter } from "../adapters/workbuddy.js";
import { createOpenClawInferencer } from "../adapters/openclaw.js";
import { ConservativeDedupeEvaluator } from "../core/evaluator.js";
import { SqliteEntityStore, RuleBasedEntityExtractor } from "../entity/index.js";
import { leafmemEnv } from "../system/env-compat.js";

type CliConfig = {
  defaultScopes?: MemoryScope[];
  retrieval?: LeafMemOptions["retrieval"];
  storagePath?: string;
  workbuddyHome?: string;
};

type RetrievalConfig = NonNullable<LeafMemOptions["retrieval"]>;
type RetrievalBackend = NonNullable<RetrievalConfig["backend"]>;
type EmbeddingsConfig = NonNullable<RetrievalConfig["embeddings"]>;

const HELP = `leafmem-mcp

Local stdio MCP server for LeafMem.

Options:
  --storage-path <path>          Override the SQLite database path
  --scope-type <type>            Set a default scope type for all tools
  --scope-id <id>                Set a default scope id for all tools
  --retrieval-backend <name>     builtin | qmd
  --embeddings-provider <name>   openai | gemini | voyage | script | auto
  --embeddings-model <name>      Override the remote embeddings model
  --embeddings-base-url <url>    Override the remote embeddings base URL
  --qmd-command <command>        Override the qmd command when backend=qmd
  --help                         Show this message

Environment:
  LEAFMEM_STORAGE_PATH
  LEAFMEM_SCOPE_TYPE
  LEAFMEM_SCOPE_ID
  LEAFMEM_RETRIEVAL_BACKEND
  LEAFMEM_EMBEDDINGS_PROVIDER
  LEAFMEM_EMBEDDINGS_MODEL
  LEAFMEM_EMBEDDINGS_BASE_URL
  LEAFMEM_QMD_COMMAND
  LEAFMEM_WORKBUDDY_HOME

Defaults:
  storage path: ${defaultMemoryMcpStoragePath()}
`;

async function main(): Promise<void> {
  const config = parseCliConfig(process.argv.slice(2), process.env);
  const defaultScope = config.defaultScopes?.[0];
  if (defaultScope?.type === "agent" && defaultScope.id === "workbuddy") {
    // 2026-08-10: inferencer is optional (paid path). The free path is the
    // leafmem-maintenance skill (host-model distillation via MCP). Only build
    // an inferencer when a key is actually present — otherwise leave it
    // undefined so reflect/profile degrade to no_inferencer explicitly
    // instead of constructing a client with an undefined key.
    const inferencer = process.env.DEEPSEEK_API_KEY
      ? createOpenClawInferencer({
          api: "openai-completions",
          model: "deepseek-v4-flash",
          baseUrl: "https://api.deepseek.com",
          apiKey: process.env.DEEPSEEK_API_KEY,
        })
      : undefined;
    const sqlitePath = config.storagePath ?? defaultMemoryMcpStoragePath();
    const memory = createLeafMem({
      storage: {
        backend: "sqlite",
        path: sqlitePath,
      },
      retrieval: config.retrieval,
      inferencer,
      // Custom: conservative write-time gate. Only ignores near-duplicates;
      // never overwrites/merges existing records (keeps all data intact).
      evaluator: new ConservativeDedupeEvaluator(),
      // Custom (2026-08-07 P0-1): wire the already-built-but-never-connected
      // entity subsystem. Strict rule-based extractor + controlled vocab keeps
      // this zero-LLM. Enables ENTITY_MATCH_BOOST (+0.18) and graph context.
      entityStore: new SqliteEntityStore(sqlitePath),
      entityExtractor: new RuleBasedEntityExtractor({ strict: true }),
    });
    const adapter = createWorkBuddyMemoryAdapter({
      memory,
      defaultScopes: config.defaultScopes,
      files: config.workbuddyHome ? { homePath: config.workbuddyHome } : undefined,
    });
    // syncProjection disabled: SOUL.md/USER.md/MEMORY.md are user-authoritative files,
    // not leafmem projections. Only import on first install, never overwrite afterwards.
    // await adapter.syncProjection();
    await runMemoryMcpStdioServer({
      ...config,
      memory,
      // onMemoryChanged disabled to prevent syncProjection from overwriting user files
      // onMemoryChanged: async () => {
      //   await adapter.syncProjection();
      // },
    });
    return;
  }
  await runMemoryMcpStdioServer(config);
}

function parseCliConfig(argv: string[], env: NodeJS.ProcessEnv): CliConfig {
  let storagePath = leafmemEnv("STORAGE_PATH", env);
  let scopeType = leafmemEnv("SCOPE_TYPE", env);
  let scopeId = leafmemEnv("SCOPE_ID", env);
  let retrievalBackend = leafmemEnv("RETRIEVAL_BACKEND", env);
  let embeddingsProvider = leafmemEnv("EMBEDDINGS_PROVIDER", env);
  let embeddingsModel = leafmemEnv("EMBEDDINGS_MODEL", env);
  let embeddingsBaseUrl = leafmemEnv("EMBEDDINGS_BASE_URL", env);
  let qmdCommand = leafmemEnv("QMD_COMMAND", env);
  let workbuddyHome = leafmemEnv("WORKBUDDY_HOME", env);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    if (arg === "--storage-path") {
      storagePath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--scope-type") {
      scopeType = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--scope-id") {
      scopeId = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--retrieval-backend") {
      retrievalBackend = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--embeddings-provider") {
      embeddingsProvider = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--embeddings-model") {
      embeddingsModel = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--embeddings-base-url") {
      embeddingsBaseUrl = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--qmd-command") {
      qmdCommand = readFlagValue(argv, ++index, arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if ((scopeType && !scopeId) || (!scopeType && scopeId)) {
    throw new Error("Default scope requires both --scope-type and --scope-id");
  }

  const defaultScopes = scopeType && scopeId ? [{ type: parseMemoryScopeType(scopeType), id: scopeId }] : undefined;
  const retrieval = buildRetrievalConfig({
    retrievalBackend,
    embeddingsProvider,
    embeddingsModel,
    embeddingsBaseUrl,
    qmdCommand,
  });

  return {
    defaultScopes,
    retrieval,
    storagePath,
    workbuddyHome,
  };
}

function buildRetrievalConfig(input: {
  retrievalBackend?: string;
  embeddingsProvider?: string;
  embeddingsModel?: string;
  embeddingsBaseUrl?: string;
  qmdCommand?: string;
}): LeafMemOptions["retrieval"] | undefined {
  const backend = input.retrievalBackend?.trim();
  const provider = input.embeddingsProvider?.trim();
  const model = input.embeddingsModel?.trim();
  const baseUrl = input.embeddingsBaseUrl?.trim();
  const qmdCommand = input.qmdCommand?.trim();

  if (!backend && !provider && !qmdCommand) {
    return undefined;
  }

  if (backend && backend !== "builtin" && backend !== "qmd") {
    throw new Error(`Unsupported retrieval backend: ${backend}`);
  }

  if (
    provider &&
    provider !== "openai" &&
    provider !== "gemini" &&
    provider !== "voyage" &&
    provider !== "script" &&
    provider !== "auto"
  ) {
    throw new Error(`Unsupported embeddings provider: ${provider}`);
  }

  return {
    backend: (backend ?? (provider ? "builtin" : undefined)) as RetrievalBackend | undefined,
    embeddings: provider
      ? {
          provider: provider as EmbeddingsConfig["provider"],
          model,
          remote: baseUrl
            ? {
                baseUrl,
              }
            : undefined,
        }
      : undefined,
    qmd:
      backend === "qmd" || qmdCommand
        ? {
            enabled: true,
            command: qmdCommand,
          }
        : undefined,
  };
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
