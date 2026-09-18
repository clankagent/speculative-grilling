import { GrillService } from "../src/storage.js";
import { sessionMetrics } from "../src/metrics.js";

// Deterministic harness validation, not evidence of real-world model performance.
// The oracle is separate from every policy and can only answer explicit queries.
const hiddenDesign: Record<string, string> = { links: "no", retention: "month", format: "text" };
const oracle = (id: string) => {
  if (!(id in hiddenDesign)) throw new Error("Unknown oracle decision");
  return hiddenDesign[id]!;
};
const outputs = [];
for (const policy of ["sequential", "frontier", "speculative"] as const) {
  const service = new GrillService(":memory:");
  try {
    const access = service.start(
      "Synthetic notebook: decide sharing, recovery, and format. Repository fixture specifies plain text.",
    );
    for (const [id, prompt, choices] of [
      [
        "links",
        "Allow public links?",
        [
          ["yes", "Public links"],
          ["no", "Private only"],
        ],
      ],
      [
        "retention",
        "Recovery period?",
        [
          ["month", "30 days"],
          ["none", "None"],
        ],
      ],
      [
        "format",
        "Storage format?",
        [
          ["text", "Plain text"],
          ["binary", "Binary"],
        ],
      ],
    ] as const)
      service.execute(access, {
        type: "propose",
        decision: {
          id,
          prompt,
          authority:
            id === "format" && policy === "speculative" ? "external_fact" : "user_required",
          options: choices.map(([id, label]) => ({ id, label })),
        },
      });
    if (policy === "speculative") {
      service.execute(access, { type: "fork", hypothesisId: "root", decisionId: "links" });
      service.execute(access, {
        type: "evidence",
        evidence: {
          id: "repository",
          source: "Synthetic repository fixture",
          summary: "The documented existing format is plain text.",
          supports: { format: "text" },
        },
      });
      service.execute(access, {
        type: "resolve",
        decisionId: "format",
        optionId: "text",
        evidenceIds: ["repository"],
      });
      service.execute(access, { type: "commit", decisionId: "format" });
    }
    service.execute(access, { type: "schedule" });
    let rounds = 0;
    while (service.questions(access).length) {
      rounds++;
      const queue = service.questions(access);
      const batch = policy === "sequential" ? queue.slice(0, 1) : queue;
      for (const q of batch) {
        service.execute(
          access,
          { type: "answer", decisionId: q.id, revision: q.revision, optionId: oracle(q.id) },
          "human",
        );
        service.execute(access, { type: "commit", decisionId: q.id });
      }
    }
    const state = service.read(access);
    const disagreement = Object.entries(hiddenDesign).filter(
      ([id, option]) => state.decisions[id]?.selection?.optionId !== option,
    ).length;
    const metrics = sessionMetrics(state, service.events(access));
    outputs.push({
      policy,
      rounds,
      humanAnswers: metrics.humanAnswers,
      disagreement,
      committed: metrics.decisionsCommitted,
    });
  } finally {
    service.close();
  }
}
console.log(
  "Synthetic harness check only. Policies use scripted fixture knowledge; no efficacy claim.",
);
console.table(outputs);
