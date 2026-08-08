import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AGENT_IDS,
  getAgentStatuses,
  importSessions,
  installAgent,
  isAgentId,
  resolveAgentOptions,
  type AgentId,
} from "../agents/manager.js";
import type { RequestContext } from "./server.js";
import { json, readBody } from "./server.js";

async function readBodyRecord(req: IncomingMessage): Promise<{ sharedMemory?: boolean }> {
  try {
    const body = (await readBody(req)) as Record<string, unknown>;
    return { sharedMemory: typeof body.sharedMemory === "boolean" ? body.sharedMemory : undefined };
  } catch {
    return {};
  }
}

async function readAgentWithMemory(req: IncomingMessage): Promise<{ agent: AgentId; sharedMemory?: boolean }> {
  const body = (await readBody(req)) as Record<string, unknown>;
  const agent = typeof body.agent === "string" ? body.agent : "";
  if (!isAgentId(agent)) throw new Error("Unknown agent");
  return { agent, sharedMemory: typeof body.sharedMemory === "boolean" ? body.sharedMemory : undefined };
}

export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  path: string,
): Promise<void> {
  const options = resolveAgentOptions(ctx.agents);

  if (path === "/v1/agents/status" && req.method === "GET") {
    json(res, 200, {
      storagePath: options.storagePath,
      mcpPath: options.mcpPath,
      agents: await getAgentStatuses(options),
    });
    return;
  }

  if (path === "/v1/agents/install" && req.method === "POST") {
    const { agent, sharedMemory } = await readAgentWithMemory(req);
    const result = await installAgent(agent, { ...options, sharedMemory });
    json(res, 200, { result, status: await getAgentStatuses(options) });
    return;
  }

  if (path === "/v1/agents/import" && req.method === "POST") {
    const agent = await readAgent(req);
    const result = await importSessions(agent, options);
    json(res, 200, { result, status: await getAgentStatuses(options) });
    return;
  }

  if (path === "/v1/agents/install-all" && req.method === "POST") {
    const { sharedMemory } = await readBodyRecord(req);
    const results = [];
    for (const agent of AGENT_IDS) {
      results.push(await installAgent(agent, { ...options, sharedMemory }));
    }
    json(res, 200, { results, status: await getAgentStatuses(options) });
    return;
  }

  if (path === "/v1/agents/import-all" && req.method === "POST") {
    const results = [];
    for (const agent of AGENT_IDS) {
      results.push({ agent, result: await importSessions(agent, options) });
    }
    json(res, 200, { results, status: await getAgentStatuses(options) });
    return;
  }

  json(res, 404, { error: "Not found" });
}

async function readAgent(req: IncomingMessage): Promise<AgentId> {
  const body = (await readBody(req)) as Record<string, unknown>;
  const agent = body.agent;
  if (typeof agent !== "string" || !isAgentId(agent)) {
    throw new Error("Invalid agent");
  }
  return agent;
}
