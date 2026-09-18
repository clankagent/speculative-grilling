import { GrillService } from "../src/storage.js";
import { JevProvider } from "../src/providers.js";

// Explicit live check: one synthetic batch, no reasoning calls and no automatic retries.
const service = new GrillService(":memory:");
try {
  const key = process.env["TYPESAFE_API_KEY"];
  if (!key) throw new Error("Missing Jev credential");
  const access = service.start("Synthetic offline reading list; no real user data.");
  service.execute(access, {
    type: "propose",
    decision: {
      id: "ordering",
      prompt: "Manual or alphabetical ordering?",
      authority: "user_required",
      options: [
        { id: "manual", label: "Manual" },
        { id: "alphabetical", label: "Alphabetical" },
      ],
    },
  });
  const judge = new JevProvider(key);
  const assessments = await judge.evaluate(service.read(access), new AbortController().signal);
  if (assessments.length !== 1 || assessments[0]!.decisionId !== "ordering")
    throw new Error("Unexpected assessment");
  for (const assessment of assessments)
    service.execute(access, { type: "assess", assessment }, "system");
  service.execute(access, { type: "schedule" });
  const state = service.read(access);
  if (
    state.decisions.ordering!.selection ||
    state.decisions.ordering!.committed ||
    service.questions(access).length !== 1
  )
    throw new Error("Authority invariant failed");
  console.log(
    JSON.stringify(
      {
        provider: "typesafe/jev-latest",
        batches: 1,
        judgments: 3,
        assessments: assessments.length,
        humanQuestionPreserved: true,
        authorityPreserved: true,
      },
      null,
      2,
    ),
  );
} catch {
  console.error(
    "Jev qualification failed. Check TYPESAFE_API_KEY and account availability; response details withheld.",
  );
  process.exitCode = 1;
} finally {
  service.close();
}
