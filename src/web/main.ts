import { GrillService, type SessionAccess } from "../storage.js";
import { ExplorationRunner } from "../runner.js";
import { configuredProviders } from "../providers.js";
import { startExample, exampleProvider } from "./demo.js";
import { startWorkspace } from "./server.js";

const demo = !process.argv.includes("--live");
const service = new GrillService(demo ? ":memory:" : process.env["GRILL_DATABASE"]);
const providers = demo
  ? { reasoning: exampleProvider(), judgment: undefined }
  : configuredProviders();
const briefIndex = process.argv.indexOf("--brief");
const brief = briefIndex >= 0 ? process.argv[briefIndex + 1] : undefined;
const resume = !demo && process.argv.includes("--resume");
const access = demo
  ? startExample(service)
  : resume
    ? service.getPrivate<SessionAccess>("browser:latest")
    : brief
      ? service.start(brief)
      : undefined;
if (resume && !access) throw new Error("No browser session saved. Start with --live first.");
if (resume && access) service.recover(access);
if (!demo && access) service.putPrivate("browser:latest", access);
const runner = providers.reasoning
  ? new ExplorationRunner(service, providers.reasoning, providers.judgment)
  : undefined;
const workspace = await startWorkspace(service, access, {
  demo,
  allowNew: !demo,
  providerLabel: `${process.env["GRILL_REASONING_PROVIDER"] ?? "Reasoning"} / ${process.env["GRILL_REASONING_MODEL"] ?? "configured model"}${providers.judgment ? " + Jev" : ""}`,
  onSession: (created) => service.putPrivate("browser:latest", created),
  ...(runner ? { runner } : {}),
  port: Number(process.env["GRILL_WEB_PORT"] ?? 0),
});
console.log(
  `${demo ? "Interactive synthetic example (no API calls)" : "Private workspace; exploration starts only when requested"}\n${workspace.url}`,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await workspace.close();
  await runner?.close();
  service.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
