import {
  createMcpHandler,
  type Transport,
  type JSONRPCMessage,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { createGrillMcpServer, type TaskHandlers } from "./mcp.js";
import { GrillService } from "../storage.js";
import type { ExplorationRunner } from "../runner.js";
import { safeError } from "../application.js";

// SDK 2.0.0 still treats tasks/get and tasks/cancel as retired core methods.
// Implement the published 2026 Tasks extension at the transport boundary,
// with its own envelope/parameter validation; never patch SDK internals.
const taskMethods = new Set(["tasks/get", "tasks/update", "tasks/cancel"]);
const taskEnvelope = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z
    .object({
      _meta: z
        .object({
          "io.modelcontextprotocol/protocolVersion": z.literal("2026-07-28"),
          "io.modelcontextprotocol/clientCapabilities": z.object({
            extensions: z.object({ "io.modelcontextprotocol/tasks": z.object({}) }),
          }),
        })
        .passthrough(),
    })
    .passthrough(),
});
async function taskReply(raw: unknown, handlers: TaskHandlers): Promise<JSONRPCMessage> {
  const parsed = taskEnvelope.safeParse(raw);
  const id = z.object({ id: z.union([z.string(), z.number()]) }).safeParse(raw);
  if (!parsed.success)
    return {
      jsonrpc: "2.0",
      id: id.success ? id.data.id : 0,
      error: { code: -32602, message: "Valid MCP 2026 envelope and Tasks capability required" },
    };
  const request = parsed.data;
  try {
    const handler = handlers[request.method];
    if (!handler) throw new Error("Unknown task method");
    const value = await handler(request.params);
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        ...z.record(z.string(), z.unknown()).parse(value),
        resultType: "complete",
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "speculative-grilling", version: "0.1.0" },
        },
      },
    };
  } catch (error) {
    return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: safeError(error) } };
  }
}
export function createGrillMcpHandler(service: GrillService, runner?: ExplorationRunner) {
  const handlers: TaskHandlers = {};
  const sdk = createMcpHandler(() => createGrillMcpServer(service, runner, handlers));
  // Populate the extension independently of whether the first request is a tool call.
  createGrillMcpServer(service, runner, handlers);
  return {
    async fetch(request: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await request.clone().json();
      } catch {
        return sdk.fetch(request);
      }
      const method = z.object({ method: z.string() }).safeParse(raw);
      if (!method.success || !taskMethods.has(method.data.method)) return sdk.fetch(request);
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (
        request.method !== "POST" ||
        request.headers.get("Mcp-Method") !== method.data.method ||
        request.headers.get("MCP-Protocol-Version") !== "2026-07-28" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        (origin && origin !== url.origin)
      )
        return new Response("Invalid local MCP request", { status: 400 });
      return Response.json(await taskReply(raw, handlers));
    },
  };
}
export class TasksTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  constructor(
    private readonly underlying: Transport,
    private readonly handlers: TaskHandlers,
  ) {}
  async start() {
    this.underlying.onclose = () => this.onclose?.();
    this.underlying.onerror = (error) => this.onerror?.(error);
    this.underlying.onmessage = (message, extra) => {
      if ("method" in message && "id" in message && taskMethods.has(message.method)) {
        void taskReply(message, this.handlers)
          .then((reply) => this.underlying.send(reply))
          .catch(() => this.onerror?.(new Error("Task transport failed")));
      } else this.onmessage?.(message, extra);
    };
    await this.underlying.start();
  }
  send(message: JSONRPCMessage, options?: TransportSendOptions) {
    return this.underlying.send(message, options);
  }
  close() {
    return this.underlying.close();
  }
}
