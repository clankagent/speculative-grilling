import { evaluationCases, evaluateCase } from "../src/evaluation.js";
const results = evaluationCases.flatMap((fixture) =>
  (["sequential", "frontier", "speculative"] as const).map((policy) =>
    evaluateCase(fixture, policy),
  ),
);
console.log(
  "Synthetic policy regression suite: identical facts, authority and budget ceilings. Fixture outcomes are not live-model quality evidence; human time and actual billing are not simulated.",
);
console.table(results);
if (results.some((r) => r.disagreement || r.falseAutomaticDecisions || r.unresolved))
  process.exitCode = 1;
