import { expect, test } from "vite-plus/test";
import { evaluationCases, evaluateCase } from "../src/evaluation.js";
test.each(evaluationCases)(
  "matched-policy fixture $name preserves the hidden design",
  (fixture) => {
    for (const policy of ["sequential", "frontier", "speculative"] as const) {
      const result = evaluateCase(fixture, policy);
      expect(result.disagreement).toBe(0);
      expect(result.falseAutomaticDecisions).toBe(0);
      expect(result.unresolved).toBe(0);
    }
  },
);
test("only equivalent optional choices eliminate a human question", () => {
  const equivalent = evaluationCases.find((f) => f.name === "irrelevant-order")!;
  expect(evaluateCase(equivalent, "speculative").humanAnswers).toBe(1);
  expect(evaluateCase(equivalent, "frontier").humanAnswers).toBe(2);
  const required = evaluationCases.find((f) => f.name === "required-choice")!;
  expect(evaluateCase(required, "speculative").humanAnswers).toBe(1);
});
