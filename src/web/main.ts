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
if (!demo && !brief && !resume)
  throw new Error("Live sessions require --brief followed by your design brief, or --resume");
const access = demo
  ? startExample(service)
  : resume
    ? service.getPrivate<SessionAccess>("browser:latest")
    : service.start(brief!);
if (!access) throw new Error("No browser session saved. Start with --live --brief first.");
if (resume) service.recover(access);
if (!demo) service.putPrivate("browser:latest", access);
const runner = providers.reasoning
  ? new ExplorationRunner(service, providers.reasoning, providers.judgment)
  : undefined;
const workspace = await startWorkspace(service, access, {
  demo,
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
