import { z } from "zod";
import { commandSchema, ensure, type Session } from "./domain.js";
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
      ? { type: "answer", decisionId: questionId, revision, optionId: response.answer }
      : response.action === "other"
        ? { type: "answer", decisionId: questionId, revision, other: response.answer }
        : { type: response.action, decisionId: questionId, revision };
  return service.execute(access, command, "human", commandId ? { commandId } : {});
}
export function safeError(error: unknown): string {
  // Only domain messages are authored locally. Provider/SDK errors may include request details.
  if (error instanceof Error && error.name === "DomainError") return error.message;
  if (error instanceof z.ZodError) return "Input failed schema validation";
  return "Operation failed; private diagnostic details were withheld";
}
