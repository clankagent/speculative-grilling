import { GrillService } from "../src/storage.js";
import { configuredProviders } from "../src/providers.js";
import { ExplorationRunner } from "../src/runner.js";

// This explicitly invoked command spends provider credits. It is never part of CI.
// Only synthetic context is sent; output contains counts, not model bodies or credentials.
const service = new GrillService(":memory:");
let runner: ExplorationRunner | undefined;
try {
  const providers = configuredProviders();
  if (!providers.reasoning) throw new Error("Reasoning configuration required");
  const access = service.start(
    "Design a tiny offline reading list. It stores only titles and URLs on one device, has no account, no network sync, and no telemetry. Explore whether manual ordering or alphabetical ordering changes the design. Do not execute actions or research external facts.",
    { maxCalls: 4, maxTokens: 40000, maxConcurrent: 2, maxHypotheses: 2 },
  );
  runner = new ExplorationRunner(service, providers.reasoning, providers.judgment);
  await runner.start(access, 2);
  const state = service.read(access);
  const work = Object.values(state.work);
  const reasoningCompleted = work.filter(
    (w) => w.kind === "reasoning" && w.status === "completed",
  ).length;
  const judgments = Object.keys(state.assessments).length;
  const errors = work.filter((w) => ["failed", "stale"].includes(w.status)).length;
  console.log(
    JSON.stringify(
      {
        reasoningCompleted,
        judgments,
        calls: state.calls,
        tokensReserved: state.tokensReserved,
        questions: service.questions(access).length,
        errors,
        jevConfigured: Boolean(providers.judgment),
      },
      null,
      2,
    ),
  );
  if (
    !reasoningCompleted ||
    errors ||
    (providers.judgment && Object.keys(state.decisions).length > 0 && !judgments)
  )
    process.exitCode = 1;
} catch {
  console.error(
    "Live qualification failed; check provider configuration and account availability. Details withheld.",
  );
  process.exitCode = 1;
} finally {
  await runner?.close();
  service.close();
}
