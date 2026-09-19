import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { GrillService, type SessionAccess } from "../storage.js";
import { startWorkspace, type Workspace } from "../web/server.js";
import { configuredProviders } from "../providers.js";
import { ExplorationRunner } from "../runner.js";
import { createGrillMcpServer, type TaskHandlers } from "./mcp.js";
import { TasksTransport } from "./mcp-transport.js";

const service = new GrillService(process.env["GRILL_DATABASE"]);
const providers = configuredProviders();
const runner = providers.reasoning
  ? new ExplorationRunner(service, providers.reasoning, providers.judgment)
  : undefined;
const tasks: TaskHandlers = {};
const workspaces = new Map<string, Promise<Workspace>>();
const workspace = (access: SessionAccess) => {
  service.read(access);
  let value = workspaces.get(access.sessionId);
  if (!value) {
    value = startWorkspace(service, access, runner ? { runner } : {});
    workspaces.set(access.sessionId, value);
  }
  return value;
};
createGrillMcpServer(service, runner, tasks, workspace);
const handle = serveStdio(() => createGrillMcpServer(service, runner, tasks, workspace), {
  transport: new TasksTransport(new StdioServerTransport(), tasks),
  onerror: () => {
    process.stderr.write("MCP transport error; details withheld\n");
  },
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([...workspaces.values()].map(async (value) => (await value).close()));
  await runner?.close();
  await handle.close();
  service.close();
}
process.once("SIGINT", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});
process.stdin.once("end", () => {
  void close();
});
