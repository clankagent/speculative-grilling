import { afterEach, expect, test } from "vite-plus/test";
import { GrillService } from "../src/storage.js";

const services: GrillService[] = [];
afterEach(() => services.splice(0).forEach((s) => s.close()));
function fixture(authority = "user_preference", enabled = true, impact = 1) {
  const service = new GrillService(":memory:");
  services.push(service);
  const access = service.start("Synthetic convergence case", {}, { semanticConvergence: enabled });
  const run = (command: unknown) => service.execute(access, command, "system");
  run({
    type: "propose",
    decision: {
      id: "mode",
      prompt: "Internal order?",
      authority,
      impact,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  });
  run({ type: "fork", hypothesisId: "root", decisionId: "mode" });
  const worlds = Object.values(service.read(access).hypotheses).filter(
    (h) => h.status === "active",
  );
  for (const [i, world] of worlds.entries()) {
    run({ type: "startWork", workId: `w${i}`, hypothesisId: world.id, reserveTokens: 100 });
    run({
      type: "completeWork",
      workId: `w${i}`,
      summary: "Same visible result",
      decisions: [],
      observableEffects: ["The output contains both entries sorted by title"],
      exhausted: true,
      provider: "fixture",
    });
  }
  run({
    type: "assess",
    assessment: {
      decisionId: "mode",
      revision: service.read(access).decisions.mode!.revision,
      model: "fixture",
      materiality: 0.01,
      userOwned: 0.5,
      safeToSpeculate: 1,
    },
  });
  return { service, access, run, worlds };
}
test("opt-in convergence preserves alternatives without inferring an answer", () => {
  const { service, access, run, worlds } = fixture();
  // A later judgment job must not replace the reasoning provenance.
  run({
    type: "startWork",
    kind: "judgment",
    workId: "judge",
    hypothesisId: worlds[0]!.id,
    reserveTokens: 100,
  });
  run({ type: "completeWork", workId: "judge", summary: "Judged", decisions: [] });
  run({ type: "converge" });
  run({ type: "schedule" });
  const state = service.read(access);
  expect(service.questions(access)).toHaveLength(0);
  expect(state.decisions.mode?.question).toBe("withdrawn");
  expect(state.decisions.mode?.selection).toBeNull();
  expect(state.decisions.mode?.committed).toBe(false);
  expect(worlds.map((h) => state.hypotheses[h.id]!.assignments.mode).sort()).toEqual(["a", "b"]);
  expect(Object.values(state.hypotheses).filter((h) => h.status === "merged")).toHaveLength(1);
  expect(service.replay(access)).toEqual(state);
  service.execute(access, { type: "steer", text: "The internal ordering now matters" }, "human");
  run({ type: "schedule" });
  expect(service.questions(access)).toHaveLength(1);
  expect(
    Object.values(service.read(access).hypotheses).filter((h) => h.status === "active"),
  ).toHaveLength(2);
});
test.each([
  ["user_preference", false, 1],
  ["user_preference", true, 8],
  ["user_required", true, 1],
  ["approval_required", true, 1],
] as const)(
  "convergence cannot bypass %s / enabled %s / impact %s",
  (authority, enabled, impact) => {
    const { service, access, run } = fixture(authority, enabled, impact);
    run({ type: "converge" });
    run({ type: "schedule" });
    expect(service.questions(access)).toHaveLength(1);
  },
);
test("failed newer exploration prevents reuse of an earlier convergence claim", () => {
  const { service, access, run, worlds } = fixture();
  run({ type: "startWork", workId: "retry", hypothesisId: worlds[0]!.id, reserveTokens: 100 });
  run({ type: "failWork", workId: "retry" });
  run({ type: "converge" });
  run({ type: "schedule" });
  expect(service.questions(access)).toHaveLength(1);
});
test("different observable effects keep the question open", () => {
  const { service, access, run, worlds } = fixture();
  run({ type: "startWork", workId: "different", hypothesisId: worlds[0]!.id, reserveTokens: 100 });
  run({
    type: "completeWork",
    workId: "different",
    summary: "Changed",
    decisions: [],
    observableEffects: ["Only one entry is visible"],
    exhausted: true,
    provider: "fixture",
  });
  run({ type: "converge" });
  run({ type: "schedule" });
  expect(service.questions(access)).toHaveLength(1);
});

test("semantic convergence requires a judgment tied to every current reasoning result", () => {
  const { service, access, run, worlds } = fixture();
  run({ type: "startWork", workId: "paraphrase", hypothesisId: worlds[0]!.id, reserveTokens: 100 });
  run({
    type: "completeWork",
    workId: "paraphrase",
    summary: "Equivalent ordering",
    decisions: [],
    observableEffects: ["Both entries are visible in alphabetical title order"],
    exhausted: true,
    provider: "fixture",
  });
  const assessment = {
    ...service.read(access).assessments.mode!,
    equivalence: 0.999,
    workIds: ["w0", "w1"],
  };
  run({ type: "assess", assessment });
  run({ type: "converge" });
  expect(service.read(access).decisions.mode?.question).not.toBe("withdrawn");
  run({ type: "assess", assessment: { ...assessment, workIds: ["paraphrase", "w1"] } });
  run({ type: "converge" });
  expect(service.read(access).decisions.mode?.question).toBe("withdrawn");
  expect(service.read(access).decisions.mode?.selection).toBeNull();
});

test("a newly discovered dependent obligation reopens a converged question", () => {
  const { service, access, run } = fixture();
  run({ type: "converge" });
  run({
    type: "propose",
    decision: {
      id: "new-obligation",
      prompt: "New consequence?",
      authority: "user_required",
      dependencies: ["mode"],
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
  });
  run({ type: "schedule" });
  expect(service.questions(access).map((q) => q.id)).toEqual(["mode"]);
  expect(
    Object.values(service.read(access).hypotheses).filter((h) => h.status === "active"),
  ).toHaveLength(2);
});
