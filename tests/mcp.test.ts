import { afterEach, expect, test } from "vite-plus/test";
import { GrillService } from "../src/storage.js";
import { createGrillMcpHandler } from "../src/adapters/mcp-transport.js";
import { ExplorationRunner } from "../src/runner.js";
import type { ReasoningProvider } from "../src/providers.js";

const services: GrillService[] = [];
afterEach(() => services.splice(0).forEach((s) => s.close()));
function setup(reasoning?: ReasoningProvider) {
  const service = new GrillService(":memory:");
  services.push(service);
  const runner = reasoning ? new ExplorationRunner(service, reasoning) : undefined;
  const handler = createGrillMcpHandler(service, runner);
  let id = 0;
  async function request(method: string, params: Record<string, unknown>, tasks = false) {
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(typeof params["name"] === "string" ? { "Mcp-Name": params["name"] } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "synthetic-test-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {
                elicitation: { form: {} },
                ...(tasks ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {}),
              },
            },
          },
        }),
      }),
    );
    const raw = await response.text();
    const data =
      raw.startsWith("event:") || raw.startsWith("data:")
        ? raw
            .split("\n")
            .find((line) => line.startsWith("data:"))!
            .slice(5)
            .trim()
        : raw;
    return JSON.parse(data) as { result?: Record<string, unknown>; error?: unknown };
  }
  return { service, request, runner };
}
test("actual MCP v2 HTTP dispatch lists tools and routes commands through the engine", async () => {
  const { service, request } = setup();
  const tools = await request("tools/list", {});
  expect(tools.error).toBeUndefined();
  expect(tools.result?.["tools"]).toBeDefined();
  const access = service.start("Synthetic notebook");
  const response = await request("tools/call", {
    name: "grill_command",
    arguments: {
      access,
      commandId: "test",
      command: {
        type: "propose",
        decision: {
          id: "links",
          prompt: "Allow public links?",
          authority: "user_required",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      },
    },
  });
  expect(response.error).toBeUndefined();
  expect(response.result?.["isError"]).not.toBe(true);
  service.execute(access, { type: "schedule" });
  expect(service.questions(access)).toHaveLength(1);
  const rejected = await request("tools/call", {
    name: "grill_command",
    arguments: {
      access,
      commandId: "forge",
      command: { type: "answer", decisionId: "links", revision: 2, optionId: "yes" },
    },
  });
  expect(rejected.result?.["isError"]).toBe(true);
});
test("MCP input_required carries typed questions and accepts actual elicitation responses", async () => {
  const { service, request } = setup();
  const access = service.start("Synthetic notebook");
  service.execute(access, {
    type: "propose",
    decision: {
      id: "links",
      prompt: "Allow public links?",
      authority: "user_required",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
  });
  service.execute(access, { type: "schedule" });
  const initial = await request("tools/call", { name: "grill_questions", arguments: { access } });
  expect(initial.result?.["isError"], JSON.stringify(initial)).not.toBe(true);
  expect(initial.error).toBeUndefined();
  expect(initial.result?.["resultType"]).toBe("input_required");
  const inputs = initial.result?.["inputRequests"] as Record<string, unknown>;
  const key = Object.keys(inputs)[0]!;
  const answer = await request("tools/call", {
    name: "grill_questions",
    arguments: { access },
    inputResponses: { [key]: { action: "accept", content: { action: "answer", answer: "yes" } } },
  });
  expect(answer.error).toBeUndefined();
  expect(answer.result?.["isError"]).not.toBe(true);
  expect(service.read(access).decisions["links"]?.selection?.basis).toBe("explicit");
});
test("MCP Tasks return a durable handle and actual tasks/get status", async () => {
  const { service, request, runner } = setup({
    name: "synthetic",
    reserveTokens: () => 100,
    async expand() {
      return { summary: "No further decisions", decisions: [] };
    },
  });
  const access = service.start("Synthetic notebook");
  const response = await request(
    "tools/call",
    { name: "grill_explore", arguments: { access, rounds: 1 } },
    true,
  );
  expect(response.error).toBeUndefined();
  expect(response.result?.["resultType"]).toBe("task");
  const taskId = response.result?.["taskId"];
  expect(typeof taskId).toBe("string");
  await runner?.close();
  const poll = await request("tasks/get", { taskId }, true);
  expect(poll.error).toBeUndefined();
  expect(poll.result?.["resultType"]).toBe("complete");
  expect(poll.result?.["status"]).toBe("completed");
});
test("Task input supports partial answers and harmless retries, and rejects conflicting duplicates", async () => {
  const { service, request, runner } = setup({
    name: "synthetic",
    reserveTokens: () => 100,
    async expand() {
      return { summary: "No new choices", decisions: [] };
    },
  });
  const access = service.start("Synthetic product");
  for (const id of ["links", "retention"])
    service.execute(access, {
      type: "propose",
      decision: {
        id,
        prompt: `Synthetic ${id} choice?`,
        authority: "user_required",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
    });
  const response = await request(
    "tools/call",
    { name: "grill_explore", arguments: { access, rounds: 1 } },
    true,
  );
  await runner?.close();
  const taskId = response.result?.["taskId"];
  const poll = await request("tasks/get", { taskId }, true);
  expect(poll.result?.["status"]).toBe("input_required");
  const keys = Object.keys(poll.result?.["inputRequests"] as object);
  expect(keys).toHaveLength(2);
  const inputResponses = {
    [keys[0]!]: { action: "accept", content: { action: "answer", answer: "yes" } },
  };
  const update = await request("tasks/update", { taskId, inputResponses }, true);
  expect(update.error, JSON.stringify(update)).toBeUndefined();
  const retry = await request("tasks/update", { taskId, inputResponses }, true);
  expect(retry.error).toBeUndefined();
  const revision = service.read(access).revision;
  const bad = await request(
    "tasks/update",
    {
      taskId,
      inputResponses: {
        [keys[0]!]: { action: "accept", content: { action: "answer", answer: "no" } },
      },
    },
    true,
  );
  expect(bad.error).toBeDefined();
  expect(service.read(access).revision).toBe(revision);
  const remaining = await request("tasks/get", { taskId }, true);
  expect(Object.keys(remaining.result?.["inputRequests"] as object)).toHaveLength(1);
  const cancelled = await request("tasks/cancel", { taskId }, true);
  expect(cancelled.error).toBeUndefined();
  const end = await request("tasks/get", { taskId }, true);
  expect(end.result?.["status"]).toBe("cancelled");
});
