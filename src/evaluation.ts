import { GrillService } from "./storage.js";
import { decisionSchema, type DecisionInput } from "./domain.js";
import { humanResponse } from "./application.js";
import { sessionMetrics } from "./metrics.js";

export type EvaluationPolicy = "sequential" | "frontier" | "speculative";
export type EvaluationCase = {
  name: string;
  brief: string;
  decisions: DecisionInput[];
  hiddenAnswers: Record<string, string>;
  evidence: Record<string, string>;
  outcomes: Record<string, Record<string, string[]>>;
};
const decision = (id: string, authority: string, extra: Record<string, unknown> = {}) =>
  decisionSchema.parse({
    id,
    prompt: `Synthetic ${id} choice?`,
    authority,
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    ...extra,
  });
export const evaluationCases: EvaluationCase[] = [
  {
    name: "irrelevant-order",
    brief: "Offline list with an output sorted by title.",
    decisions: [
      decision("order", "user_preference", { impact: 1 }),
      decision("sharing", "user_required"),
    ],
    hiddenAnswers: { order: "no", sharing: "no" },
    evidence: {},
    outcomes: {
      order: { yes: ["Both entries sorted by title"], no: ["Both entries sorted by title"] },
    },
  },
  {
    name: "consequential-order",
    brief: "The selected order is visible to the reader.",
    decisions: [decision("order", "user_preference", { impact: 1 })],
    hiddenAnswers: { order: "no" },
    evidence: {},
    outcomes: {
      order: { yes: ["Entries sorted by title"], no: ["Entries preserve manual order"] },
    },
  },
  {
    name: "conditional-sharing",
    brief: "Public sharing may need an expiry policy.",
    decisions: [
      decision("sharing", "user_required"),
      decision("expiry", "user_required", { dependencies: ["sharing"], when: { sharing: "yes" } }),
    ],
    hiddenAnswers: { sharing: "no", expiry: "yes" },
    evidence: {},
    outcomes: {},
  },
  {
    name: "shared-facts",
    brief: "Fixture repository uses plain text; sharing remains a preference.",
    decisions: [decision("text", "external_fact"), decision("sharing", "user_required")],
    hiddenAnswers: { text: "yes", sharing: "no" },
    evidence: { text: "yes" },
    outcomes: {},
  },
  {
    name: "required-choice",
    brief: "A human requires choosing an otherwise equivalent order.",
    decisions: [decision("order", "user_required", { impact: 1 })],
    hiddenAnswers: { order: "no" },
    evidence: {},
    outcomes: { order: { yes: ["Same output"], no: ["Same output"] } },
  },
];

export function evaluateCase(fixture: EvaluationCase, policy: EvaluationPolicy) {
  const service = new GrillService(":memory:");
  try {
    const access = service.start(
      fixture.brief,
      { maxCalls: 20, maxTokens: 60000, maxHypotheses: 3, maxConcurrent: 2 },
      { semanticConvergence: policy === "speculative" },
    );
    for (const d of fixture.decisions) service.execute(access, { type: "propose", decision: d });
    // Every policy receives identical facts, authority and budget limits.
    for (const [id, optionId] of Object.entries(fixture.evidence)) {
      service.execute(access, {
        type: "evidence",
        evidence: {
          id: `fact_${id}`,
          summary: "Synthetic repository fact",
          source: "Synthetic fixture",
          supports: { [id]: optionId },
        },
      });
      service.execute(access, {
        type: "resolve",
        decisionId: id,
        optionId,
        evidenceIds: [`fact_${id}`],
      });
      service.execute(access, { type: "commit", decisionId: id });
    }
    if (policy === "speculative")
      for (const [id, outcomes] of Object.entries(fixture.outcomes)) {
        const root = Object.values(service.read(access).hypotheses).find(
          (h) => h.status === "active" && !h.convergenceDecision,
        );
        if (!root) continue;
        service.execute(access, { type: "fork", hypothesisId: root.id, decisionId: id });
        const worlds = Object.values(service.read(access).hypotheses).filter(
          (h) => h.status === "active",
        );
        for (const [i, h] of worlds.entries()) {
          const workId = `${id}_${i}`;
          service.execute(
            access,
            { type: "startWork", workId, hypothesisId: h.id, reserveTokens: 100 },
            "system",
          );
          service.execute(
            access,
            {
              type: "completeWork",
              workId,
              summary: "Synthetic branch exploration",
              decisions: [],
              observableEffects: outcomes[h.assignments[id]!] ?? [],
              exhausted: true,
              provider: "fixture",
            },
            "system",
          );
        }
        const signatures = Object.values(outcomes).map((v) => JSON.stringify(v));
        service.execute(
          access,
          {
            type: "assess",
            assessment: {
              decisionId: id,
              revision: service.read(access).decisions[id]!.revision,
              model: "fixture",
              materiality: signatures.every((v) => v === signatures[0]) ? 0 : 1,
              userOwned: 1,
              safeToSpeculate: 1,
            },
          },
          "system",
        );
        service.execute(access, { type: "converge" }, "system");
      }
    service.execute(access, { type: "schedule" });
    let rounds = 0;
    while (service.questions(access).length && rounds < 30) {
      rounds++;
      const queue = service.questions(access);
      for (const q of policy === "sequential" ? queue.slice(0, 1) : queue) {
        // Hidden answers enter the session only through explicit simulated human input.
        const answer = fixture.hiddenAnswers[q.id];
        if (!answer) throw new Error("Fixture oracle has no answer");
        humanResponse(service, access, q.id, q.revision, { action: "answer", answer });
      }
    }
    const state = service.read(access);
    let disagreement = 0,
      falseAutomaticDecisions = 0;
    for (const d of Object.values(state.decisions)) {
      const irrelevant = Object.entries(d.when).some(
        ([id, value]) => state.decisions[id]?.selection?.optionId !== value,
      );
      const outcomes = fixture.outcomes[d.id];
      const equivalent =
        outcomes && new Set(Object.values(outcomes).map((v) => JSON.stringify(v))).size === 1;
      if (irrelevant || (!d.selection && d.question === "withdrawn" && equivalent)) continue;
      if (d.selection?.optionId !== fixture.hiddenAnswers[d.id]) {
        disagreement++;
        if (d.selection && d.selection.basis !== "explicit") falseAutomaticDecisions++;
      }
    }
    const metrics = sessionMetrics(state, service.events(access));
    return {
      scenario: fixture.name,
      policy,
      rounds,
      humanAnswers: metrics.humanAnswers,
      disagreement,
      falseAutomaticDecisions,
      unresolved: metrics.decisionsUnresolved,
      calls: state.calls,
      reservedTokens: state.tokensReserved,
    };
  } finally {
    service.close();
  }
}
