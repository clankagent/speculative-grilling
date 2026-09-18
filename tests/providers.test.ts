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
