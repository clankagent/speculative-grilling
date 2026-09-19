import { afterEach, expect, test } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrillService } from "../src/storage.js";

const services: GrillService[] = [];
const directories: string[] = [];
afterEach(() => {
  services.splice(0).forEach((s) => s.close());
  directories.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function setup(budget: unknown = {}) {
  const s = new GrillService(":memory:");
  services.push(s);
  const a = s.start("Synthetic brief", budget);
  s.execute(a, {
    type: "propose",
    decision: {
      id: "mode",
      prompt: "Mode?",
      authority: "user_preference",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  });
  return { s, a };
}
test("questions are candidates until the explicit scheduling phase", () => {
  const { s, a } = setup();
  expect(s.questions(a)).toHaveLength(0);
  s.execute(a, { type: "fork", hypothesisId: "root", decisionId: "mode" });
  expect(s.questions(a)).toHaveLength(0);
  s.execute(a, { type: "schedule" });
  expect(s.questions(a)).toHaveLength(1);
});

test("late worker completion cannot undo an explicit pause", () => {
  const { s, a } = setup();
  s.execute(
    a,
    { type: "startWork", workId: "late", hypothesisId: "root", reserveTokens: 100 },
    "system",
  );
  s.execute(a, { type: "pause" }, "human");
  s.execute(
    a,
    { type: "completeWork", workId: "late", summary: "Obsolete result", decisions: [] },
    "system",
  );
  expect(s.read(a).state).toBe("paused");
  expect(s.read(a).work.late?.status).not.toBe("completed");
});

test("explicitly scoped work survives an unrelated human answer", () => {
  const { s, a } = setup();
  s.execute(a, {
    type: "propose",
    decision: {
      id: "unrelated",
      prompt: "Unrelated choice?",
      authority: "user_required",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  });
  s.execute(
    a,
    {
      type: "startWork",
      workId: "scoped",
      hypothesisId: "root",
      reserveTokens: 100,
      dependencyIds: ["mode"],
    },
    "system",
  );
  s.execute(
    a,
    { type: "answer", decisionId: "unrelated", revision: 1, optionId: "a", commit: true },
    "human",
  );
  s.execute(
    a,
    { type: "completeWork", workId: "scoped", summary: "Still applicable", decisions: [] },
    "system",
  );
  expect(s.read(a).work.scoped?.status).toBe("completed");
});
test("branch-local proposals carry scope and cannot collide across worlds", () => {
  const { s, a } = setup();
  s.execute(a, { type: "fork", hypothesisId: "root", decisionId: "mode" });
  const worlds = Object.values(s.read(a).hypotheses).filter((h) => h.status === "active");
  for (const [i, world] of worlds.entries())
    s.execute(
      a,
      { type: "startWork", workId: `w${i}`, hypothesisId: world.id, reserveTokens: 100 },
      "system",
    );
  for (const [i] of worlds.entries())
    s.execute(
      a,
      {
        type: "completeWork",
        workId: `w${i}`,
        summary: "Scoped result",
        decisions: [
          {
            id: "child",
            prompt: "Child decision?",
            authority: "user_preference",
            options: [
              { id: "x", label: "X" },
              { id: "y", label: "Y" },
            ],
          },
        ],
      },
      "system",
    );
  const children = Object.values(s.read(a).decisions).filter((d) => d.id.startsWith("child_"));
  expect(children).toHaveLength(2);
  expect(children.map((d) => d.when["mode"]).sort()).toEqual(["a", "b"]);
  s.execute(a, { type: "schedule" });
  expect(s.questions(a)).toHaveLength(1);
  const q = s.questions(a)[0]!;
  s.execute(a, { type: "answer", decisionId: q.id, revision: q.revision, optionId: "a" }, "human");
  s.execute(a, { type: "commit", decisionId: q.id });
  s.execute(a, { type: "schedule" });
  expect(s.questions(a)).toHaveLength(1);
  expect(s.questions(a)[0]?.id).toBe(children.find((d) => d.when["mode"] === "a")!.id);
  expect(s.read(a).decisions[children.find((d) => d.when["mode"] === "b")!.id]?.question).toBe(
    "withdrawn",
  );
});
test("bounded beam preserves excluded alternatives as suspended rather than disproved", () => {
  const { s, a } = setup({ maxHypotheses: 2 });
  s.execute(a, {
    type: "propose",
    decision: {
      id: "four",
      prompt: "Four choices?",
      authority: "user_required",
      options: ["w", "x", "y", "z"].map((id) => ({ id, label: id })),
    },
  });
  s.execute(a, { type: "fork", hypothesisId: "root", decisionId: "four" });
  const worlds = Object.values(s.read(a).hypotheses);
  expect(worlds.filter((h) => h.status === "active")).toHaveLength(2);
  expect(worlds.filter((h) => h.status === "suspended")).toHaveLength(2);
  expect(worlds.filter((h) => h.status === "pruned")).toHaveLength(0);
});
test("explicit delegation permits a reversible choice and never changes user_required authority", () => {
  const { s, a } = setup();
  s.execute(a, { type: "delegate", decisionId: "mode" }, "human");
  s.execute(a, { type: "choose", decisionId: "mode", optionId: "a" });
  s.execute(a, { type: "commit", decisionId: "mode" });
  expect(s.read(a).decisions["mode"]?.selection?.basis).toBe("delegated");
  s.execute(a, {
    type: "propose",
    decision: {
      id: "erase",
      prompt: "Permanent erase?",
      authority: "approval_required",
      reversible: false,
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
  });
  expect(() => s.execute(a, { type: "delegate", decisionId: "erase" }, "human")).toThrow(
    "cannot be delegated",
  );
  expect(() => s.execute(a, { type: "choose", decisionId: "erase", optionId: "yes" })).toThrow(
    "delegation",
  );
});
test("free-text answers are explicit alternatives and silence never commits", () => {
  const { s, a } = setup();
  s.execute(a, { type: "schedule" });
  const q = s.questions(a)[0]!;
  s.execute(
    a,
    { type: "answer", decisionId: q.id, revision: q.revision, other: "Use a hybrid mode" },
    "human",
  );
  expect(s.export(a)).not.toContain("hybrid");
  s.execute(a, { type: "commit", decisionId: q.id });
  expect(s.export(a)).toContain("hybrid");
});
test("independent database clients serialize writes and reject stale revisions", () => {
  const directory = mkdtempSync(join(tmpdir(), "grill-db-test-"));
  directories.push(directory);
  const path = join(directory, "sessions.sqlite");
  const one = new GrillService(path);
  const two = new GrillService(path);
  services.push(one, two);
  const access = one.start("Synthetic brief");
  const revision = two.read(access).revision;
  one.execute(access, { type: "context", text: "First client update" });
  expect(() =>
    two.execute(access, { type: "context", text: "Stale update" }, "agent", {
      expectedRevision: revision,
    }),
  ).toThrow("changed");
  expect(two.read(access).context).toEqual(["First client update"]);
});
test("conflicting evidence cannot auto-resolve and oversized calls cannot consume budget", () => {
  const { s, a } = setup({ maxTokens: 100 });
  expect(() =>
    s.execute(
      a,
      { type: "startWork", workId: "too-big", hypothesisId: "root", reserveTokens: 101 },
      "system",
    ),
  ).toThrow("budget");
  expect(s.read(a).calls).toBe(0);
  s.execute(a, {
    type: "propose",
    decision: {
      id: "fact",
      prompt: "Existing format?",
      authority: "external_fact",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  });
  for (const option of ["a", "b"])
    s.execute(a, {
      type: "evidence",
      evidence: {
        id: `e_${option}`,
        summary: "Conflicting fixture evidence",
        source: "Synthetic fixture",
        supports: { fact: option },
      },
    });
  expect(() =>
    s.execute(a, { type: "resolve", decisionId: "fact", optionId: "a", evidenceIds: ["e_a"] }),
  ).toThrow("Conflicting");
});
