import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { GrillService } from "../storage.js";
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
createGrillMcpServer(service, runner, tasks);
const handle = serveStdio(() => createGrillMcpServer(service, runner, tasks), {
  transport: new TasksTransport(new StdioServerTransport(), tasks),
  onerror: () => {
    process.stderr.write("MCP transport error; details withheld\n");
  },
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
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
