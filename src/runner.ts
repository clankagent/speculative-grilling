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
    let budgetBlocked = false;
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
            const reservation = this.reasoning.reserveTokens(state, hypothesis.id);
            const hasPending = Object.values(state.decisions).some(
              (d) => !d.selection && d.question !== "withdrawn",
            );
            if (
              this.judgment &&
              hasPending &&
              (state.calls + 2 > state.budget.maxCalls ||
                state.tokensReserved + reservation + this.judgment.reserveTokens(state) >
                  state.budget.maxTokens)
            ) {
              budgetBlocked = true;
              return;
            }
            this.service.execute(
              access,
              {
                type: "startWork",
                workId,
                hypothesisId: hypothesis.id,
                reserveTokens: reservation,
                ...(this.reasoning.dependencyIds
                  ? { dependencyIds: this.reasoning.dependencyIds(state, hypothesis.id) }
                  : {}),
              },
              "system",
            );
            const { usage, ...body } = await this.reasoning.expand(state, hypothesis.id, signal);
            const result = expansionSchema.parse(body);
            this.service.execute(
              access,
              {
                type: "completeWork",
                workId,
                ...result,
                provider: this.reasoning.name,
                ...(usage ? { usage } : {}),
              },
              "system",
            );
          } catch (error) {
            if (this.service.read(access).work[workId]?.status === "running")
              this.service.execute(
                access,
                {
                  type: "failWork",
                  workId,
                  failureCode:
                    error instanceof DomainError &&
                    ["PROVIDER_SCHEMA", "PROVIDER_JSON"].includes(error.code)
                      ? error.code
                      : error instanceof DomainError
                        ? "INVALID_RESULT"
                        : "PROVIDER",
                },
                "system",
              );
            if (error instanceof DomainError && error.code === "BUDGET") {
              budgetBlocked = true;
              return;
            }
            // Provider messages can contain secrets or raw context; retain only the safe failure event.
          }
        }),
      );
      if (signal.aborted) break;
      // Publish ready questions between waves, while later branch work continues.
      // Wait for the entire wave so presentation revisions cannot stale sibling results.
      this.service.execute(access, { type: "schedule" }, "system");
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
      const h = Object.values(state.hypotheses).find(
        (h) => h.status === "active" && !h.convergenceDecision,
      );
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
              provider: this.judgment.name,
              decisions: [],
            },
            "system",
          );
          if (this.service.read(access).work[workId]?.status === "completed")
            for (const assessment of judgments)
              this.service.execute(access, { type: "assess", assessment }, "system");
        } catch (error) {
          if (error instanceof DomainError && error.code === "BUDGET") budgetBlocked = true;
          if (this.service.read(access).work[workId]?.status === "running")
            this.service.execute(access, { type: "failWork", workId }, "system");
        }
      }
    }
    if (!signal.aborted) {
      this.service.execute(access, { type: "converge" }, "system");
      this.service.execute(access, { type: "schedule" }, "system");
      if (budgetBlocked) this.service.execute(access, { type: "exhaustBudget" }, "system");
    }
  }
}
