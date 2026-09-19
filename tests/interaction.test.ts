import { expect, test } from "vite-plus/test";
import { GrillService } from "../src/storage.js";
import {
  humanResponse,
  answerReviewPreview,
  acceptAnswerReview,
  agentCommand,
} from "../src/application.js";

test("accepted UI answers commit atomically and unlock dependent questions", () => {
  const s = new GrillService(":memory:");
  try {
    const a = s.start("Synthetic notebook");
    for (const id of ["parent", "child"])
      s.execute(a, {
        type: "propose",
        decision: {
          id,
          prompt: id,
          authority: "user_required",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          dependencies: id === "child" ? ["parent"] : [],
          when: id === "child" ? { parent: "yes" } : {},
        },
      });
    s.execute(a, { type: "schedule" });
    const q = s.questions(a)[0]!;
    humanResponse(s, a, q.id, q.revision, { action: "answer", answer: "yes" }, "answer-once");
    expect(s.read(a).decisions.parent?.committed).toBe(true);
    expect(s.questions(a).map((q) => q.id)).toEqual(["child"]);
    const revision = s.read(a).revision;
    humanResponse(s, a, q.id, q.revision, { action: "answer", answer: "yes" }, "answer-once");
    expect(s.read(a).revision).toBe(revision);
    expect(s.export(a)).toContain("Yes");
    const events = s
      .events(a)
      .filter((e) => ["DecisionAnswered", "DecisionCommitted"].includes(e.data.type));
    expect(events).toHaveLength(2);
    expect(events[0]?.commandId).toBe(events[1]?.commandId);
  } finally {
    s.close();
  }
});

test("queue presentation preserves the current Jev ranking assessment", () => {
  const s = new GrillService(":memory:");
  try {
    const a = s.start("Synthetic queue");
    for (const id of ["a", "b"]) {
      s.execute(a, {
        type: "propose",
        decision: {
          id,
          prompt: id,
          authority: "user_required",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      });
      s.execute(
        a,
        {
          type: "assess",
          assessment: {
            decisionId: id,
            revision: 1,
            model: "fixture",
            materiality: id === "a" ? 0 : 1,
            userOwned: 1,
            safeToSpeculate: 1,
          },
        },
        "system",
      );
    }
    s.execute(a, { type: "schedule" });
    expect(s.questions(a).map((q) => q.id)).toEqual(["b", "a"]);
  } finally {
    s.close();
  }
});

test("reviewed multi-answer interpretation is atomic, dependency ordered, and human-only", () => {
  const s = new GrillService(":memory:");
  try {
    const a = s.start("Synthetic batch");
    for (const id of ["parent", "child"])
      s.execute(a, {
        type: "propose",
        decision: {
          id,
          prompt: id,
          authority: "user_required",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          dependencies: id === "child" ? ["parent"] : [],
        },
      });
    const review = {
      sourceText: "Yes to both",
      answers: [
        { decisionId: "child", revision: 1, optionId: "yes" },
        { decisionId: "parent", revision: 1, optionId: "yes" },
      ],
    };
    expect(answerReviewPreview(s, a, review)).toContain("Yes to both");
    expect(() => agentCommand(s, a, { type: "answerBatch", ...review })).toThrow("requires human");
    const before = s.read(a);
    expect(() =>
      acceptAnswerReview(s, a, {
        ...review,
        answers: [{ ...review.answers[0], revision: 99 }, review.answers[1]],
      }),
    ).toThrow("changed");
    expect(s.read(a)).toEqual(before);
    acceptAnswerReview(s, a, review, "review-once");
    expect(Object.values(s.read(a).decisions).every((d) => d.committed)).toBe(true);
    const revision = s.read(a).revision;
    acceptAnswerReview(s, a, review, "review-once");
    expect(s.read(a).revision).toBe(revision);
    expect(s.replay(a)).toEqual(s.read(a));
  } finally {
    s.close();
  }
});
