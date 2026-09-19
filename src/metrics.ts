import type { GrillEvent, Session } from "./domain.js";

export function sessionMetrics(state: Session, events: GrillEvent[]) {
  const firstQueued = new Map<string, number>();
  const answered = new Set<string>();
  const latencies: number[] = [];
  for (const event of events) {
    const data = event.data;
    if (
      data.type === "QuestionChanged" &&
      data.decision.question === "queued" &&
      !firstQueued.has(data.decision.id)
    )
      firstQueued.set(data.decision.id, Date.parse(event.timestamp));
    if (data.type === "DecisionAnswered") {
      answered.add(data.decision.id);
      const queued = firstQueued.get(data.decision.id);
      if (queued !== undefined) latencies.push(Math.max(0, Date.parse(event.timestamp) - queued));
    }
  }
  const work = Object.values(state.work);
  return {
    candidateQuestions: Object.keys(state.decisions).length,
    uniqueQuestionsQueued: firstQueued.size,
    humanAnswers: events.filter((e) => e.data.type === "DecisionAnswered").length,
    distinctHumanDecisions: answered.size,
    automaticResolutions: events.filter((e) => e.data.type === "DecisionResolved").length,
    decisionsCommitted: Object.values(state.decisions).filter((d) => d.committed).length,
    decisionsUnresolved: Object.values(state.decisions).filter(
      (d) => !d.selection && d.question !== "withdrawn",
    ).length,
    withdrawnQuestions: Object.values(state.decisions).filter((d) => d.question === "withdrawn")
      .length,
    hypothesesPruned: Object.values(state.hypotheses).filter((h) => h.status === "pruned").length,
    hypothesesMerged: Object.values(state.hypotheses).filter((h) => h.status === "merged").length,
    hypothesesSuspendedForBudget: Object.values(state.hypotheses).filter(
      (h) => h.status === "suspended",
    ).length,
    providerCallsReserved: state.calls,
    tokensReserved: state.tokensReserved,
    measuredCalls: work.filter((w) => w.usage).length,
    reportedInputTokens: work.reduce((sum, w) => sum + (w.usage?.inputTokens ?? 0), 0),
    reportedOutputTokens: work.reduce((sum, w) => sum + (w.usage?.outputTokens ?? 0), 0),
    estimatedCostUsd: work.reduce((sum, w) => sum + (w.usage?.estimatedCostUsd ?? 0), 0),
    usageCoverageComplete: work.length > 0 && work.every((w) => Boolean(w.usage)),
    workCompleted: work.filter((w) => w.status === "completed").length,
    workStale: work.filter((w) => w.status === "stale").length,
    workFailed: work.filter((w) => w.status === "failed").length,
    answerLatencyMs: latencies,
    humanActiveTimeMs: null,
    note: "Queue latency includes idle time. Human active time is not inferred. Reported usage covers only calls carrying provider usage; SDK cost estimates are not billing receipts. Reservations are not measured token usage.",
  };
}
