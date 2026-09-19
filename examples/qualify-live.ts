import { GrillService } from "../src/storage.js";
import { configuredProviders } from "../src/providers.js";
import { ExplorationRunner } from "../src/runner.js";
import { humanResponse } from "../src/application.js";
import { sessionMetrics } from "../src/metrics.js";

// This explicitly invoked command spends provider credits. It is never part of CI.
// Only synthetic context is sent; output contains counts, not model bodies or credentials.
const service = new GrillService(":memory:");
let runner: ExplorationRunner | undefined;
try {
  const providers = configuredProviders();
  if (!providers.reasoning) throw new Error("Reasoning configuration required");
  const access = service.start(
    "Design a tiny offline reading list. It stores only titles and URLs on one device, has no account, no network sync, and no telemetry. Explore whether manual ordering or alphabetical ordering changes the design. Do not execute actions or research external facts.",
    {
      maxCalls: 4,
      maxTokens: Math.min(40000, Number(process.env["GRILL_QUALIFY_MAX_TOKENS"] ?? 40000)),
      maxConcurrent: 2,
      maxHypotheses: 2,
    },
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
  const question = service.questions(access)[0];
  if (question)
    humanResponse(service, access, question.id, question.revision, {
      action: "answer",
      answer: question.options[0]!.id,
    });
  const afterAnswer = service.read(access);
  const answerCommitted = Boolean(question && afterAnswer.decisions[question.id]?.committed);
  const replayMatches = JSON.stringify(service.replay(access)) === JSON.stringify(afterAnswer);
  const exportContainsAnswer = Boolean(
    question && service.export(access).includes(question.options[0]!.label),
  );
  const metrics = sessionMetrics(afterAnswer, service.events(access));
  console.log(
    JSON.stringify(
      {
        reasoningCompleted,
        judgments,
        calls: state.calls,
        tokensReserved: state.tokensReserved,
        questions: service.questions(access).length,
        errors,
        failureCodes: work.filter((w) => w.failureCode).map((w) => w.failureCode),
        jevConfigured: Boolean(providers.judgment),
        simulatedAnswerCommitted: answerCommitted,
        replayMatches,
        exportContainsAnswer,
        measuredReasoningCalls: metrics.measuredCalls,
        estimatedReasoningCostUsd: metrics.estimatedCostUsd,
      },
      null,
      2,
    ),
  );
  if (
    !reasoningCompleted ||
    !answerCommitted ||
    !replayMatches ||
    !exportContainsAnswer ||
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
