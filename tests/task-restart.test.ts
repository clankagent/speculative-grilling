import { expect, test } from "vite-plus/test";
import { GrillService } from "../src/storage.js";
import { createGrillMcpServer, type TaskHandlers } from "../src/adapters/mcp.js";

test("a persisted task with obsolete questions terminates explicitly rather than waiting forever", async () => {
  const service = new GrillService(":memory:");
  try {
    const access = service.start("Synthetic restart");
    const handlers: TaskHandlers = {};
    createGrillMcpServer(service, undefined, handlers);
    service.putPrivate("task:fixture", {
      taskId: "fixture",
      access,
      status: "input_required",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      pending: { removed_1: { id: "removed", revision: 1 } },
      consumed: {},
    });
    const view = (await handlers["tasks/get"]!({ taskId: "fixture" })) as {
      status: string;
      result: { isError: boolean };
    };
    expect(view.status).toBe("completed");
    expect(view.result.isError).toBe(true);
    expect(service.read(access).calls).toBe(0);
  } finally {
    service.close();
  }
});

test("an interrupted task recovers without silently retrying a paid call", async () => {
  const service = new GrillService(":memory:");
  try {
    const access = service.start("Synthetic interruption");
    service.execute(
      access,
      { type: "startWork", workId: "w", hypothesisId: "root", reserveTokens: 100 },
      "system",
    );
    service.putPrivate("task:fixture", {
      taskId: "fixture",
      access,
      status: "working",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      pending: {},
      consumed: {},
    });
    const handlers: TaskHandlers = {};
    createGrillMcpServer(service, undefined, handlers);
    const view = (await handlers["tasks/get"]!({ taskId: "fixture" })) as {
      status: string;
      result: { isError: boolean };
    };
    expect(view.status).toBe("completed");
    expect(view.result.isError).toBe(true);
    expect(service.read(access).work.w?.status).toBe("failed");
    expect(service.read(access).calls).toBe(1);
  } finally {
    service.close();
  }
});
