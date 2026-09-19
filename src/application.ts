import { z } from "zod";
import { commandSchema, ensure, reviewedAnswerSchema, type Session } from "./domain.js";
import { type GrillService, type SessionAccess } from "./storage.js";

const agentCommands = new Set([
  "propose",
  "evidence",
  "context",
  "resolve",
  "choose",
  "commit",
  "schedule",
  "fork",
  "merge",
  "pause",
  "resume",
]);
export function agentCommand(
  service: GrillService,
  access: SessionAccess,
  input: unknown,
  commandId?: string,
) {
  const command = commandSchema.parse(input);
  ensure(
    agentCommands.has(command.type),
    "AUTHORITY",
    "This operation requires human UI input or an internal worker",
  );
  return service.execute(access, command, "agent", commandId ? { commandId } : {});
}
export function status(s: Session) {
  return {
    sessionId: s.id,
    revision: s.revision,
    state: s.state,
    activeHypotheses: Object.values(s.hypotheses).filter((h) => h.status === "active").length,
    committedDecisions: Object.values(s.decisions).filter((d) => d.committed).length,
    speculativeDecisions: Object.values(s.decisions).filter((d) => !d.committed).length,
    pendingQuestions: Object.values(s.decisions).filter((d) => d.question === "queued").length,
    failedWork: Object.values(s.work).filter((w) => w.status === "failed").length,
    staleWork: Object.values(s.work).filter((w) => w.status === "stale").length,
    calls: s.calls,
    tokensReserved: s.tokensReserved,
    budget: s.budget,
  };
}
export const humanResponseSchema = z
  .object({
    action: z.enum(["answer", "other", "defer", "delegate"]),
    answer: z.string().max(20000).default(""),
  })
  .strict();
export function humanResponse(
  service: GrillService,
  access: SessionAccess,
  questionId: string,
  revision: number,
  input: unknown,
  commandId?: string,
) {
  const response = humanResponseSchema.parse(input);
  const command =
    response.action === "answer"
      ? {
          type: "answer",
          decisionId: questionId,
          revision,
          optionId: response.answer,
          commit: true,
        }
      : response.action === "other"
        ? { type: "answer", decisionId: questionId, revision, other: response.answer, commit: true }
        : { type: response.action, decisionId: questionId, revision };
  service.execute(access, command, "human", commandId ? { commandId } : {});
  return service.execute(access, { type: "schedule" }, "system");
}
export function safeError(error: unknown): string {
  // Only domain messages are authored locally. Provider/SDK errors may include request details.
  if (error instanceof Error && error.name === "DomainError") return error.message;
  if (error instanceof z.ZodError) return "Input failed schema validation";
  return "Operation failed; private diagnostic details were withheld";
}

export const answerReviewSchema = z
  .object({
    sourceText: z.string().min(1).max(20000),
    answers: z.array(reviewedAnswerSchema).min(1).max(20),
  })
  .strict();
export function answerReviewPreview(
  service: GrillService,
  access: SessionAccess,
  input: unknown,
): string {
  const review = answerReviewSchema.parse(input);
  const state = service.read(access);
  return (
    `Original answer:\n${review.sourceText}\n\nProposed interpretation (accepting commits these choices):\n` +
    review.answers
      .map((a) => {
        const d = state.decisions[a.decisionId];
        ensure(
          d && d.revision === a.revision && !d.committed,
          "STALE",
          "Refresh the proposed answers before review",
        );
        ensure(
          Boolean(a.optionId) !== Boolean(a.other),
          "ANSWER",
          "Provide one answer per decision",
        );
        const label = a.other ?? d.options.find((o) => o.id === a.optionId)?.label;
        ensure(label, "OPTION", "Unknown proposed option");
        return `${d.prompt}\n→ ${label}`;
      })
      .join("\n\n")
  );
}
export function acceptAnswerReview(
  service: GrillService,
  access: SessionAccess,
  input: unknown,
  commandId?: string,
) {
  const review = answerReviewSchema.parse(input);
  service.execute(
    access,
    { type: "answerBatch", ...review },
    "human",
    commandId ? { commandId } : {},
  );
  return service.execute(access, { type: "schedule" }, "system");
}
