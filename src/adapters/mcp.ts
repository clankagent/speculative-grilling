import { createHash, randomBytes } from "node:crypto";
import {
  McpServer,
  inputRequired,
  inputResponse,
  acceptedContent,
  type InputRequests,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { commandSchema, budgetSchema, policySchema, ensure } from "../domain.js";
import { GrillService, type SessionAccess } from "../storage.js";
import {
  agentCommand,
  humanResponse,
  humanResponseSchema,
  status,
  safeError,
} from "../application.js";
import { type ExplorationRunner } from "../runner.js";
import { sessionMetrics } from "../metrics.js";

const accessSchema = z.object({ sessionId: z.string(), secret: z.string().min(1).max(100) });
const result = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
type PendingQuestion = { id: string; revision: number };
type TaskRecord = {
  taskId: string;
  access: SessionAccess;
  createdAt: string;
  lastUpdatedAt: string;
  status: "working" | "input_required" | "completed" | "cancelled";
  pending: Record<string, PendingQuestion>;
  consumed: Record<string, string>;
  result?: CallToolResult;
};
const inputKey = (id: string, revision: number) => `${id}_${revision}`;
export function questionInputs(
  service: GrillService,
  access: SessionAccess,
  requested?: Record<string, PendingQuestion>,
) {
  const inputs: InputRequests = {};
  const pending: Record<string, PendingQuestion> = {};
  for (const q of service
    .questions(access)
    .filter((q) => !requested || inputKey(q.id, q.revision) in requested)
    .slice(0, 4)) {
    const key = inputKey(q.id, q.revision);
    pending[key] = { id: q.id, revision: q.revision };
    inputs[key] = inputRequired.elicit({
      message: `${q.prompt}\n${q.options.map((o) => `${o.id}: ${o.label}`).join("\n")}\n${q.whyNow}`,
      requestedSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["answer", "other", "defer", ...(q.mayDelegate ? ["delegate"] : [])],
          },
          answer: { type: "string", maxLength: 20000 },
        },
        required: ["action"],
      },
    });
  }
  return { inputs, pending };
}
export type TaskHandlers = Record<string, (params: unknown) => unknown | Promise<unknown>>;
export function createGrillMcpServer(
  service: GrillService,
  runner?: ExplorationRunner,
  taskHandlers: TaskHandlers = {},
): McpServer {
  const server = new McpServer(
    { name: "speculative-grilling", version: "0.1.0" },
    { capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
  );
  server.registerTool(
    "grill_start",
    {
      description:
        "Create a durable clarification session. Keep its returned access credentials private.",
      inputSchema: z.object({
        brief: z.string().min(1).max(50000),
        budget: budgetSchema.optional(),
        policy: policySchema.optional(),
      }),
    },
    async ({ brief, budget, policy }) => result(service.start(brief, budget, policy)),
  );
  server.registerTool(
    "grill_inspect",
    {
      description: "Read status, questions, graph, metrics, or events for an authorized session.",
      inputSchema: z.object({
        access: accessSchema,
        view: z.enum(["status", "questions", "graph", "events", "metrics"]).default("status"),
        after: z.number().int().min(0).default(0),
      }),
    },
    async ({ access, view, after }) =>
      result(
        view === "status"
          ? status(service.read(access))
          : view === "questions"
            ? service.questions(access)
            : view === "events"
              ? service.events(access, after)
              : view === "metrics"
                ? sessionMetrics(service.read(access), service.events(access))
                : service.read(access),
      ),
  );
  server.registerTool(
    "grill_command",
    {
      description:
        "Propose decisions, submit evidence, speculate, or commit eligible resolutions. This tool cannot submit human answers or grant delegation.",
      inputSchema: z.object({
        access: accessSchema,
        command: commandSchema,
        commandId: z.string().max(200),
      }),
    },
    async ({ access, command, commandId }) => {
      try {
        return result(status(agentCommand(service, access, command, commandId)));
      } catch (error) {
        return { ...result({ error: safeError(error) }), isError: true };
      }
    },
  );
  server.registerTool(
    "grill_export",
    {
      description:
        "Return Markdown containing only committed decisions. This does not publish or write files.",
      inputSchema: z.object({ access: accessSchema }),
    },
    async ({ access }) => ({ content: [{ type: "text", text: service.export(access) }] }),
  );
  server.registerTool(
    "grill_questions",
    {
      description:
        "Ask the human the current independent question frontier through MCP elicitation. Missing or declined responses never count as agreement.",
      inputSchema: z.object({ access: accessSchema }),
    },
    async ({ access }, ctx) => {
      const { inputs, pending } = questionInputs(service, access);
      let supplied = false;
      for (const [key, q] of Object.entries(pending)) {
        const view = inputResponse(ctx.mcpReq.inputResponses, key);
        const response = acceptedContent(ctx.mcpReq.inputResponses, key, humanResponseSchema);
        if (response) {
          humanResponse(service, access, q.id, q.revision, response, `mcp_${key}`);
          supplied = true;
        } else if (view.kind === "elicit" && view.action !== "accept") {
          humanResponse(service, access, q.id, q.revision, { action: "defer" });
          supplied = true;
        }
      }
      if (supplied || !Object.keys(inputs).length)
        return result({
          status: status(service.read(access)),
          questions: service.questions(access),
        });
      return inputRequired({ inputRequests: inputs });
    },
  );
  const readTask = (id: string) => {
    const task = service.getPrivate<TaskRecord>(`task:${id}`);
    ensure(task, "NOT_FOUND", "Task not found");
    return task;
  };
  const saveTask = (task: TaskRecord) => {
    task.lastUpdatedAt = new Date().toISOString();
    service.putPrivate(`task:${task.taskId}`, task);
  };
  const taskView = (task: TaskRecord) => {
    if (task.status === "input_required") {
      const current = questionInputs(service, task.access, task.pending);
      if (Object.keys(current.pending).length !== Object.keys(task.pending).length) {
        task.status = "completed";
        task.result = {
          ...result({
            error: "Question frontier changed; inspect the session and restart exploration",
          }),
          isError: true,
        };
        saveTask(task);
      }
    }
    if (task.status === "working" && !runner?.isRunning(task.access.sessionId)) {
      // After a process restart a paid call is not silently retried.
      service.recover(task.access);
      task.status = "completed";
      task.result = {
        ...result({
          error: "Worker interrupted; restart exploration explicitly to continue",
          status: status(service.read(task.access)),
        }),
        isError: true,
      };
      saveTask(task);
    }
    const base = {
      taskId: task.taskId,
      status: task.status,
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ttlMs: null,
      pollIntervalMs: 1000,
    };
    if (task.status === "input_required") {
      const { inputs } = questionInputs(service, task.access, task.pending);
      return {
        ...base,
        inputRequests: Object.fromEntries(
          Object.entries(inputs).filter(([key]) => key in task.pending),
        ),
      };
    }
    return task.status === "completed"
      ? { ...base, result: task.result ?? result(status(service.read(task.access))) }
      : base;
  };
  const finish = (taskId: string) => {
    const task = readTask(taskId);
    if (task.status === "cancelled") return;
    task.status = service.questions(task.access).length ? "input_required" : "completed";
    if (task.status === "input_required")
      task.pending = questionInputs(service, task.access).pending;
    if (task.status === "completed") task.result = result(status(service.read(task.access)));
    saveTask(task);
  };
  server.registerTool(
    "grill_explore",
    {
      description:
        "Run bounded background exploration. Uses MCP Tasks when supported; otherwise returns a normal session status after the run.",
      inputSchema: z.object({
        access: accessSchema,
        rounds: z.number().int().min(1).max(10).default(3),
      }),
    },
    async ({ access, rounds }, ctx) => {
      service.read(access);
      if (!runner)
        return {
          ...result({
            error: "Configure reasoning provider, model, and API key before exploration",
          }),
          isError: true,
        };
      const envelope = z
        .object({
          "io.modelcontextprotocol/clientCapabilities": z
            .object({ extensions: z.record(z.string(), z.unknown()).optional() })
            .optional(),
        })
        .parse(ctx.mcpReq.envelope ?? {});
      const extensions = envelope["io.modelcontextprotocol/clientCapabilities"]?.extensions;
      if (!extensions || !("io.modelcontextprotocol/tasks" in extensions)) {
        await runner.start(access, rounds);
        return result(status(service.read(access)));
      }
      const now = new Date().toISOString();
      const taskId = randomBytes(32).toString("base64url");
      const task: TaskRecord = {
        taskId,
        access,
        createdAt: now,
        lastUpdatedAt: now,
        status: "working",
        pending: {},
        consumed: {},
      };
      saveTask(task);
      void runner.start(access, rounds).then(
        () => finish(taskId),
        () => {
          const latest = readTask(taskId);
          if (latest.status === "cancelled") return;
          latest.status = "completed";
          latest.result = { ...result({ error: "Exploration could not complete" }), isError: true };
          saveTask(latest);
        },
      );
      // The extension adds this result variant to tools/call; the core SDK's callback type is narrower.
      return { resultType: "task", ...taskView(task) } as unknown as CallToolResult;
    },
  );
  const taskParams = z.object({ taskId: z.string().min(1).max(100) });
  taskHandlers["tasks/get"] = (raw) => {
    const { taskId } = taskParams.parse(raw);
    return taskView(readTask(taskId));
  };
  taskHandlers["tasks/update"] = (rawParams) => {
    const params = taskParams
      .extend({ inputResponses: z.record(z.string(), z.unknown()) })
      .parse(rawParams);
    const task = readTask(params.taskId);
    taskView(task);
    const responses = params.inputResponses;
    let changed = false;
    for (const [key, raw] of Object.entries(responses)) {
      const digest = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
      if (task.consumed[key]) {
        ensure(task.consumed[key] === digest, "INPUT", "Conflicting duplicate human response");
        continue;
      }
      ensure(task.status === "input_required", "STATE", "Task is not awaiting input");
      const q = task.pending[key];
      ensure(q, "INPUT", "Unknown or already-consumed input request");
      const response = acceptedContent({ [key]: raw }, key, humanResponseSchema);
      const view = inputResponse({ [key]: raw }, key);
      if (response)
        humanResponse(
          service,
          task.access,
          q.id,
          q.revision,
          response,
          `task_${task.taskId}_${key}`,
        );
      else if (view.kind === "elicit" && view.action !== "accept")
        humanResponse(service, task.access, q.id, q.revision, { action: "defer" });
      else ensure(false, "INPUT", "Invalid human response");
      delete task.pending[key];
      task.consumed[key] = digest;
      changed = true;
      saveTask(task);
    }
    if (!changed) return {};
    if (!Object.keys(task.pending).length) {
      task.status = "working";
      saveTask(task);
      if (runner)
        void runner.start(task.access).then(
          () => finish(task.taskId),
          () => finish(task.taskId),
        );
      else finish(task.taskId);
    } else saveTask(task);
    return {};
  };
  taskHandlers["tasks/cancel"] = async (raw) => {
    const { taskId } = taskParams.parse(raw);
    const task = readTask(taskId);
    if (task.status === "completed" || task.status === "cancelled") return {};
    task.status = "cancelled";
    saveTask(task);
    await runner?.stop(task.access);
    return {};
  };
  return server;
}
