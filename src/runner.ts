import { randomUUID } from "node:crypto";
import { GrillService, type SessionAccess } from "./storage.js";
import { type ReasoningProvider, type JudgmentProvider, expansionSchema } from "./providers.js";
import { DomainError } from "./domain.js";

export class ExplorationRunner {
  private readonly running = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  constructor(
    private readonly service: GrillService,
    private readonly reasoning: ReasoningProvider,
    private readonly judgment?: JudgmentProvider,
  ) {}
  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }
  start(access: SessionAccess, rounds = 3): Promise<void> {
    const current = this.running.get(access.sessionId);
    if (current) return current.promise;
    const controller = new AbortController();
    const promise = this.run(access, Math.max(1, Math.min(10, rounds)), controller.signal).finally(
      () => this.running.delete(access.sessionId),
    );
    this.running.set(access.sessionId, { controller, promise });
    return promise;
  }
  async stop(access: SessionAccess) {
    this.running.get(access.sessionId)?.controller.abort();
    this.service.execute(access, { type: "pause" }, "system");
    await this.running.get(access.sessionId)?.promise;
  }
  async close() {
    const jobs = [...this.running.values()];
    jobs.forEach((j) => j.controller.abort());
    await Promise.allSettled(jobs.map((j) => j.promise));
  }
  private async run(access: SessionAccess, rounds: number, signal: AbortSignal) {
    const seen = new Set<string>();
    for (let round = 0; round < rounds && !signal.aborted; round++) {
      let state = this.service.read(access);
      if (state.state === "paused") return;
      const before = Object.keys(state.decisions).length;
      const candidates = Object.values(state.hypotheses)
        .filter((h) => h.status === "active" && !h.convergenceDecision && !seen.has(h.id))
        .slice(0, state.budget.maxConcurrent);
      if (!candidates.length) break;
      await Promise.all(
        candidates.map(async (hypothesis) => {
          seen.add(hypothesis.id);
          const workId = randomUUID();
          try {
            state = this.service.read(access);
            this.service.execute(
              access,
              {
                type: "startWork",
                workId,
                hypothesisId: hypothesis.id,
                reserveTokens: this.reasoning.reserveTokens(state, hypothesis.id),
              },
              "system",
            );
            const result = expansionSchema.parse(
              await this.reasoning.expand(state, hypothesis.id, signal),
            );
            this.service.execute(
              access,
              { type: "completeWork", workId, ...result, provider: this.reasoning.name },
              "system",
            );
          } catch (error) {
            if (this.service.read(access).work[workId]?.status === "running")
              this.service.execute(access, { type: "failWork", workId }, "system");
            if (error instanceof DomainError && error.code === "BUDGET") return;
            // Provider messages can contain secrets or raw context; retain only the safe failure event.
          }
        }),
      );
      if (signal.aborted) break;
      state = this.service.read(access);
      for (const h of Object.values(state.hypotheses).filter(
        (h) => h.status === "active" && !h.convergenceDecision,
      )) {
        const pivot = Object.values(state.decisions).find(
          (d) =>
            !d.selection &&
            !h.assignments[d.id] &&
            d.dependencies.every((id) => h.assignments[id] || state.decisions[id]?.committed) &&
            Object.entries(d.when).every(
              ([id, option]) =>
                (h.assignments[id] ?? state.decisions[id]?.selection?.optionId) === option,
            ),
        );
        if (
          pivot &&
          Object.values(this.service.read(access).hypotheses).filter((h) => h.status === "active")
            .length < state.budget.maxHypotheses
        ) {
          this.service.execute(
            access,
            { type: "fork", hypothesisId: h.id, decisionId: pivot.id },
            "system",
          );
        }
      }
      this.service.execute(access, { type: "merge" }, "system");
      if (
        Object.keys(state.decisions).length === before &&
        !Object.values(this.service.read(access).hypotheses).some(
          (h) => h.status === "active" && !seen.has(h.id),
        )
      )
        break;
    }
    if (!signal.aborted && this.judgment) {
      const state = this.service.read(access);
      const h = Object.values(state.hypotheses).find((h) => h.status === "active");
      if (h && Object.values(state.decisions).some((d) => !d.selection)) {
        const workId = randomUUID();
        try {
          this.service.execute(
            access,
            {
              type: "startWork",
              workId,
              hypothesisId: h.id,
              kind: "judgment",
              reserveTokens: this.judgment.reserveTokens(state),
            },
            "system",
          );
          const judgments = await this.judgment.evaluate(state, signal);
          this.service.execute(
            access,
            {
              type: "completeWork",
              workId,
              summary: `Batched judgments from ${this.judgment.name}`,
              decisions: [],
            },
            "system",
          );
          if (this.service.read(access).work[workId]?.status === "completed")
            for (const assessment of judgments)
              this.service.execute(access, { type: "assess", assessment }, "system");
        } catch {
          if (this.service.read(access).work[workId]?.status === "running")
            this.service.execute(access, { type: "failWork", workId }, "system");
        }
      }
    }
    if (!signal.aborted) {
      this.service.execute(access, { type: "converge" }, "system");
      this.service.execute(access, { type: "schedule" }, "system");
    }
  }
}
