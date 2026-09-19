import { z } from "zod";

export const idSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/)
  .refine((id) => !["__proto__", "constructor", "prototype"].includes(id));
const text = z.string().min(1).max(20000);
export const authoritySchema = z.enum([
  "external_fact",
  "derivable",
  "agent_discretion",
  "user_preference",
  "user_required",
  "approval_required",
]);
export const assignmentsSchema = z.record(idSchema, idSchema);
export const decisionSchema = z
  .object({
    id: idSchema,
    prompt: text,
    authority: authoritySchema,
    options: z
      .array(z.object({ id: idSchema, label: text }))
      .min(2)
      .max(12),
    dependencies: z.array(idSchema).max(30).default([]),
    when: assignmentsSchema.default({}),
    impact: z.number().min(0).max(10).default(5),
    divergence: z.number().min(0).max(10).default(5),
    effort: z.number().min(0).max(10).default(5),
    attentionCost: z.number().min(1).max(10).default(3),
    reversible: z.boolean().default(true),
  })
  .strict();
export type DecisionInput = z.infer<typeof decisionSchema>;
export type Authority = z.infer<typeof authoritySchema>;
export type Actor = "human" | "agent" | "system";
export type Selection = {
  optionId: string;
  basis: "explicit" | "verified_fact" | "derived" | "delegated";
  evidenceIds: string[];
};
export type Decision = DecisionInput & {
  revision: number;
  selection: Selection | null;
  committed: boolean;
  delegated: boolean;
  question: "candidate" | "queued" | "deferred" | "answered" | "withdrawn";
  reason: string;
};
export const evidenceSchema = z
  .object({
    id: idSchema,
    summary: text,
    source: text,
    supports: assignmentsSchema,
    premises: z.array(idSchema).default([]),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema> & { valid: boolean };
export type Hypothesis = {
  id: string;
  assignments: Record<string, string>;
  status: "active" | "expanded" | "pruned" | "merged" | "suspended";
  reason: string;
  mergedInto: string | null;
  parents: string[];
  convergenceDecision?: string | null;
};
export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
  })
  .strict();
export type ProviderUsage = z.infer<typeof usageSchema>;
export type Work = {
  id: string;
  kind: "reasoning" | "judgment";
  hypothesisId: string;
  epoch: number;
  dependencies: Record<string, number>;
  status: "running" | "completed" | "stale" | "failed" | "cancelled";
  summary: string;
  reservedTokens: number;
  observableEffects: string[];
  exhausted: boolean;
  provider: string;
  usage?: ProviderUsage;
  failureCode?: string;
};
export const policySchema = z
  .object({
    semanticConvergence: z.boolean().default(false),
    convergenceMaxImpact: z.number().min(0).max(3).default(2),
    convergenceMaxMateriality: z.number().min(0).max(0.2).default(0.1),
  })
  .strict();
export const budgetSchema = z
  .object({
    maxHypotheses: z.number().int().min(2).max(16).default(3),
    maxCalls: z.number().int().min(1).max(1000).default(20),
    maxTokens: z.number().int().min(100).max(1000000).default(60000),
    maxConcurrent: z.number().int().min(1).max(8).default(2),
  })
  .strict();
export const assessmentSchema = z
  .object({
    decisionId: idSchema,
    revision: z.number().int(),
    model: text,
    materiality: z.number().min(0).max(1),
    userOwned: z.number().min(0).max(1),
    safeToSpeculate: z.number().min(0).max(1),
    equivalence: z.number().min(0).max(1).optional(),
    workIds: z.array(idSchema).max(16).optional(),
  })
  .strict();
export type Assessment = z.infer<typeof assessmentSchema>;
export type Session = {
  id: string;
  revision: number;
  epoch: number;
  brief: string;
  state: "ready" | "exploring" | "paused" | "waiting" | "budget_exhausted";
  context: string[];
  decisions: Record<string, Decision>;
  evidence: Record<string, Evidence>;
  assessments: Record<string, Assessment>;
  hypotheses: Record<string, Hypothesis>;
  work: Record<string, Work>;
  budget: z.infer<typeof budgetSchema>;
  policy: z.infer<typeof policySchema>;
  calls: number;
  tokensReserved: number;
};
export type EventData =
  | { type: "AnswersReviewed"; sourceText: string; decisionIds: string[] }
  | { type: "SessionStarted"; session: Session }
  | { type: "ContextAdded" | "SessionSteered"; context: string; epoch: number }
  | {
      type:
        | "DecisionProposed"
        | "DecisionAnswered"
        | "DecisionResolved"
        | "DecisionCommitted"
        | "DecisionReopened"
        | "QuestionChanged"
        | "DecisionDelegated";
      decision: Decision;
    }
  | { type: "EvidenceAdded" | "EvidenceInvalidated"; evidence: Evidence }
  | { type: "HypothesisChanged"; hypothesis: Hypothesis }
  | { type: "WorkChanged"; work: Work }
  | { type: "BudgetReserved"; calls: number; tokensReserved: number }
  | { type: "AssessmentRecorded"; assessment: Assessment }
  | { type: "ExplorationChanged"; state: Session["state"]; epoch: number };
export type GrillEvent = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  sequence: number;
  commandId: string;
  actor: Actor;
  timestamp: string;
  data: EventData;
};

export const reviewedAnswerSchema = z
  .object({
    decisionId: idSchema,
    revision: z.number().int(),
    optionId: idSchema.optional(),
    other: text.optional(),
  })
  .strict();
export const commandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("answerBatch"),
    sourceText: text,
    answers: z.array(reviewedAnswerSchema).min(1).max(20),
  }),
  z.object({ type: z.literal("assess"), assessment: assessmentSchema }),
  z.object({ type: z.literal("propose"), decision: decisionSchema }),
  z.object({ type: z.literal("evidence"), evidence: evidenceSchema }),
  z.object({ type: z.literal("context"), text }),
  z.object({ type: z.literal("steer"), text }),
  z.object({
    type: z.literal("answer"),
    decisionId: idSchema,
    revision: z.number().int(),
    optionId: idSchema.optional(),
    other: text.optional(),
    commit: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("resolve"),
    decisionId: idSchema,
    optionId: idSchema,
    evidenceIds: z.array(idSchema).min(1).max(30),
  }),
  z.object({
    type: z.literal("delegate"),
    decisionId: idSchema,
    revision: z.number().int().optional(),
  }),
  z.object({ type: z.literal("choose"), decisionId: idSchema, optionId: idSchema }),
  z.object({ type: z.literal("commit"), decisionId: idSchema }),
  z.object({ type: z.literal("reopen"), decisionId: idSchema }),
  z.object({
    type: z.literal("defer"),
    decisionId: idSchema,
    revision: z.number().int().optional(),
  }),
  z.object({ type: z.literal("schedule") }),
  z.object({ type: z.literal("fork"), hypothesisId: idSchema, decisionId: idSchema }),
  z.object({ type: z.literal("merge") }),
  z.object({ type: z.literal("converge") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("exhaustBudget") }),
  z.object({
    type: z.literal("startWork"),
    kind: z.enum(["reasoning", "judgment"]).default("reasoning"),
    workId: idSchema,
    hypothesisId: idSchema,
    reserveTokens: z.number().int().min(1).max(100000),
    dependencyIds: z.array(idSchema).max(1000).optional(),
  }),
  z.object({
    type: z.literal("completeWork"),
    workId: idSchema,
    summary: text,
    decisions: z.array(decisionSchema).max(10),
    observableEffects: z.array(z.string().min(1).max(2000)).max(30).default([]),
    exhausted: z.boolean().default(false),
    provider: z.string().max(200).default("unspecified"),
    usage: usageSchema.optional(),
  }),
  z.object({
    type: z.literal("failWork"),
    workId: idSchema,
    failureCode: z
      .enum(["PROVIDER", "PROVIDER_SCHEMA", "PROVIDER_JSON", "INVALID_RESULT", "INTERRUPTED"])
      .default("INTERRUPTED"),
  }),
]);
export type Command = z.infer<typeof commandSchema>;
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export function ensure(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new DomainError(code, message);
}
export function project(events: GrillEvent[]): Session {
  let state: Session | undefined;
  for (const event of events) {
    ensure(event.schemaVersion === 1, "SCHEMA_VERSION", "Unsupported event schema");
    const data = event.data;
    if (data.type === "SessionStarted") state = structuredClone(data.session);
    ensure(state, "CORRUPT_LOG", "Missing initial session event");
    ensure(
      event.sequence === state.revision + 1,
      "CORRUPT_LOG",
      "Event sequence is not contiguous",
    );
    if ("decision" in data) state.decisions[data.decision.id] = structuredClone(data.decision);
    if ("evidence" in data) state.evidence[data.evidence.id] = structuredClone(data.evidence);
    if ("hypothesis" in data)
      state.hypotheses[data.hypothesis.id] = structuredClone(data.hypothesis);
    if ("work" in data) state.work[data.work.id] = structuredClone(data.work);
    if ("assessment" in data)
      state.assessments[data.assessment.decisionId] = structuredClone(data.assessment);
    if ("context" in data) {
      state.context.push(data.context);
      state.epoch = data.epoch;
    }
    if (data.type === "BudgetReserved") {
      state.calls = data.calls;
      state.tokensReserved = data.tokensReserved;
    }
    if (data.type === "ExplorationChanged") {
      state.state = data.state;
      state.epoch = data.epoch;
    }
    state.revision = event.sequence;
  }
  ensure(state, "NOT_FOUND", "Session not found");
  return state;
}
