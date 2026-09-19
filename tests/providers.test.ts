import { expect, test, vi } from "vite-plus/test";
import { GrillService } from "../src/storage.js";
import { JevProvider, type ReasoningProvider } from "../src/providers.js";
import { ExplorationRunner } from "../src/runner.js";

test("real Jev wire format is batched and output is validated without granting authority", async () => {
  const service = new GrillService(":memory:");
  const access = service.start("Synthetic decision");
  service.execute(access, {
    type: "propose",
    decision: {
      id: "sharing",
      prompt: "Public links?",
      authority: "user_required",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
  });
  service.execute(access, { type: "schedule" });
  let body: Record<string, unknown> = {};
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({
      model: "jev-latest",
      answers: {
        materiality_0: { type: "noul", noul: 0.9 },
        ownership_0: { type: "noul", noul: 0.99 },
        speculation_0: { type: "noul", noul: 0.8 },
      },
    });
  });
  const judge = new JevProvider("synthetic-test-key", fetcher);
  const assessments = await judge.evaluate(service.read(access), new AbortController().signal);
  expect(Object.keys(body["questions"] as object)).toHaveLength(3);
  expect(assessments[0]?.materiality).toBe(0.9);
  service.execute(access, { type: "assess", assessment: assessments[0] }, "system");
  expect(service.read(access).decisions["sharing"]?.selection).toBeNull();
  expect(service.questions(access)).toHaveLength(1);
  service.close();
});
test("background exploration keeps questions available and bounds provider calls", async () => {
  const service = new GrillService(":memory:");
  const access = service.start("Synthetic notebook", { maxCalls: 2 });
  let calls = 0;
  const reasoning: ReasoningProvider = {
    name: "test",
    reserveTokens: () => 100,
    async expand() {
      calls++;
      return calls === 1
        ? {
            summary: "Two product alternatives",
            decisions: [
              {
                id: "sharing",
                prompt: "Public links?",
                authority: "user_required",
                options: [
                  { id: "yes", label: "Yes" },
                  { id: "no", label: "No" },
                ],
                dependencies: [],
                when: {},
                impact: 8,
                divergence: 8,
                effort: 5,
                attentionCost: 2,
                reversible: true,
              },
            ],
          }
        : { summary: "Branch-specific reasoning", decisions: [] };
    },
  };
  const runner = new ExplorationRunner(service, reasoning);
  await runner.start(access, 5);
  expect(calls).toBe(2);
  expect(service.questions(access)).toHaveLength(1);
  expect(service.read(access).calls).toBe(2);
  expect(service.export(access)).not.toContain("Public links");
  service.close();
});
test("provider exceptions are not persisted with credentials or request contents", async () => {
  const service = new GrillService(":memory:");
  const access = service.start("Synthetic brief");
  const runner = new ExplorationRunner(service, {
    name: "test",
    reserveTokens: () => 100,
    async expand() {
      throw new Error("PRIVATE_PROVIDER_DETAIL");
    },
  });
  await runner.start(access);
  expect(JSON.stringify(service.events(access))).not.toContain("PRIVATE_PROVIDER_DETAIL");
  expect(Object.values(service.read(access).work)[0]?.status).toBe("failed");
  service.close();
});

test("Jev equivalence questions carry actual branch outcomes and bind the result to work IDs", async () => {
  const s = new GrillService(":memory:");
  try {
    const a = s.start("Synthetic convergence", {}, { semanticConvergence: true });
    s.execute(a, {
      type: "propose",
      decision: {
        id: "order",
        prompt: "Order?",
        authority: "user_preference",
        impact: 1,
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
    });
    s.execute(a, { type: "fork", hypothesisId: "root", decisionId: "order" });
    for (const [i, h] of Object.values(s.read(a).hypotheses)
      .filter((h) => h.status === "active")
      .entries()) {
      s.execute(
        a,
        { type: "startWork", workId: `w${i}`, hypothesisId: h.id, reserveTokens: 100 },
        "system",
      );
      s.execute(
        a,
        {
          type: "completeWork",
          workId: `w${i}`,
          summary: "Recorded outcome",
          decisions: [],
          exhausted: true,
          observableEffects: [i ? "Alphabetical titles" : "Titles sorted A to Z"],
          provider: "fixture",
        },
        "system",
      );
    }
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.questions.equivalence_0).toBeDefined();
      expect(JSON.parse(body.state).outcomes).toHaveLength(2);
      return Response.json({
        model: "jev-latest",
        answers: {
          materiality_0: { type: "noul", noul: 0.01 },
          ownership_0: { type: "noul", noul: 0.5 },
          speculation_0: { type: "noul", noul: 1 },
          equivalence_0: { type: "noul", noul: 0.999 },
        },
      });
    });
    const results = await new JevProvider("synthetic-key", fetcher).evaluate(
      s.read(a),
      new AbortController().signal,
    );
    expect(results[0]?.workIds).toEqual(["w0", "w1"]);
    expect(results[0]?.equivalence).toBe(0.999);
  } finally {
    s.close();
  }
});
