import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLeafMem, type LeafMem, type LeafMemOptions } from "../core/index.js";
import type { MemoryScope } from "../core/types.js";
import { createMemoryMcpHandler } from "./handler.js";
import { SqliteInspectEventStore } from "../inspect/sqlite-store.js";
import type { InspectEventStore } from "../inspect/types.js";

export type MemoryMcpStdioServerOptions = {
  memory?: LeafMem;
  defaultScopes?: MemoryScope[];
  storagePath?: string;
  retrieval?: LeafMemOptions["retrieval"];
  onMemoryChanged?: () => Promise<void>;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  // 2026-08-11: tests must inject an in-memory event store; without it the
  // audit trail defaults to the real ~/.leafmem database and pollutes it.
  events?: InspectEventStore;
};

export function defaultMemoryMcpStoragePath(): string {
  return join(homedir(), ".leafmem", "memory.sqlite");
}

export async function runMemoryMcpStdioServer(
  options: MemoryMcpStdioServerOptions = {},
): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const memory =
    options.memory ??
    createLeafMem({
      storage: {
        backend: "sqlite",
        path: options.storagePath ?? defaultMemoryMcpStoragePath(),
      },
      retrieval: options.retrieval,
    });
  // Durable audit trail (2026-08-08): MCP writes/updates/deletes/recalls are
  // recorded into the shared SQLite database so the console /v1/events page
  // shows real activity across processes and restarts.
  //
  // 2026-08-11 (isolation fix): unit tests pass an in-memory `memory` and no
  // `storagePath`, and the unconditional fallback pointed the audit store at
  // the REAL ~/.leafmem/memory.sqlite — phantom "memory_written" events
  // landed in the live audit log while the records died with the test process
  // (console showed events with no matching memory; incident 61d8652c).
  // Callers may now inject their own store; tests inject InMemory.
  const events =
    options.events ??
    new SqliteInspectEventStore(options.storagePath ?? defaultMemoryMcpStoragePath());
  const handler = createMemoryMcpHandler({
    memory,
    defaultScopes: options.defaultScopes,
    onMemoryChanged: options.onMemoryChanged,
    events,
  });

  if ("setEncoding" in stdin && typeof stdin.setEncoding === "function") {
    stdin.setEncoding("utf8");
  }

  let buffer = "";
  let queue = Promise.resolve();

  stdin.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : String(chunk);
    queue = queue.then(async () => {
      await drainBufferedLines(false);
    });
  });

  stdin.on("end", () => {
    queue = queue.then(async () => {
      await drainBufferedLines(true);
    });
  });

  await new Promise<void>((resolve, reject) => {
    stdin.once("error", reject);
    stdin.once("end", () => {
      void queue.then(resolve, reject);
    });
  });

  async function drainBufferedLines(flush: boolean): Promise<void> {
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      await handleLine(line);
    }

    if (flush) {
      const tail = buffer.trim();
      buffer = "";
      if (tail) {
        await handleLine(tail);
      }
    }
  }

  async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`[leafmem-mcp] ${message}\n`);
      stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        })}\n`,
      );
      return;
    }

    try {
      const response = await handler.handleRequest(payload);
      if (response !== undefined) {
        stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`[leafmem-mcp] ${message}\n`);
      stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal error" },
        })}\n`,
      );
    }
  }
}
