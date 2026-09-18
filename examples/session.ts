import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrillService } from "../src/storage.js";
import { status } from "../src/application.js";

const directory = mkdtempSync(join(tmpdir(), "speculative-grilling-demo-"));
const database = join(directory, "session.sqlite");
let service = new GrillService(database);
try {
  const access = service.start(
    "Synthetic example: design deletion behavior for a shared notebook.",
  );
  service.execute(access, {
    type: "propose",
    decision: {
      id: "retention",
      prompt: "How long are deleted notes recoverable?",
      authority: "user_required",
      options: [
        { id: "month", label: "Recoverable for 30 days" },
        { id: "none", label: "Immediately removed" },
      ],
      impact: 9,
      divergence: 9,
    },
  });
  service.execute(access, { type: "fork", hypothesisId: "root", decisionId: "retention" });
  console.log("Two hypothetical worlds; the decision remains uncommitted.");
  console.log(status(service.read(access)));
  const surviving = Object.values(service.read(access).hypotheses).find(
    (h) => h.assignments["retention"] === "month",
  )!;
  service.execute(
    access,
    { type: "startWork", workId: "demo-work", hypothesisId: surviving.id, reserveTokens: 100 },
    "system",
  );
  service.execute(
    access,
    {
      type: "completeWork",
      workId: "demo-work",
      summary: "Hypothetical recovery needs a retention deadline and restore operation.",
      decisions: [],
    },
    "system",
  );
  service.execute(access, { type: "schedule" }, "system");
  const q = service.questions(access)[0]!;
  console.log(`Question is available while branch work completes: ${q.prompt}`);
  service.execute(
    access,
    { type: "answer", decisionId: q.id, revision: q.revision, optionId: "month" },
    "human",
  );
  service.execute(access, { type: "commit", decisionId: q.id });
  service.close();
  service = new GrillService(database);
  if (JSON.stringify(service.read(access)) !== JSON.stringify(service.replay(access)))
    throw new Error("Replay differs from persisted state");
  console.log("Restart and event replay verified. Committed output:");
  console.log(service.export(access));
} finally {
  service.close();
  rmSync(directory, { recursive: true, force: true });
}
