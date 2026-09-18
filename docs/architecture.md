# Architecture proposal

This describes the target architecture. See [the running guide](running.md) for the implementation's current boundaries. Public interfaces remain experimental.

## Dependency boundary

```text
Pi extension ----+
MCP server ------+--> application service --> engine --> graph / policy
Optional UI -----+                          |          |
                                           +--> storage
                                           +--> reasoning / judgment / evidence providers
```

Adapters translate commands, queries, and events. Domain code has no dependency on Pi, MCP, a terminal, or a browser. A versioned interaction contract supports all presentations.

Suggested logical modules are protocol, graph, engine, voi, reasoning, jev, evidence, storage, service, ui-contract, adapter-pi, and adapter-mcp. Logical separation does not require a package per module on day one. A TypeScript workspace is a candidate implementation approach, with pnpm and Vite Plus where applicable.

## State and authority

| Dimension            | Proposed values                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Authority            | external_fact, derivable, agent_discretion, user_preference, user_required, approval_required                         |
| Epistemic status     | explicit, verified_fact, derived, provisional, hypothetical, rejected                                                 |
| Commitment           | uncommitted, branch_local, branch_invariant, committed                                                                |
| Hypothesis lifecycle | active, blocked, dominated, merged, pruned, committed                                                                 |
| Question lifecycle   | candidate, researching, speculating, queued, presented, deferred, answered, auto_resolved, made_irrelevant, withdrawn |

A decision records its alternatives, dependencies, authority, consequences, reversibility, evidence, and revision. A hypothesis records assignments and their dependency scope, derived work, open decisions, and provenance. Plausibility weights are distinct from decision authority.

Authority comes from trusted policy and explicit delegation. A model may propose a classification but cannot downgrade an existing user or approval requirement. A derived decision must reference its premises. External facts require evidence provenance and applicability to the current context.

## Event log

Commands validate policy and append events atomically. Events include a schema version, event ID, session ID, monotonic sequence, command ID, actor class, timestamp, causal references, and payload. State is a projection of those events; snapshots accelerate replay without replacing history.

Event families include session/context changes, proposed nodes and dependencies, evidence, hypothesis forks/merges/prunes, question queue changes, answers, assumptions, invalidations, commitment, reopening, exports, and worker outcomes.

Use idempotency keys for retried commands and expected revisions for concurrent edits. Persistence must reject duplicate effects, invalid dependency cycles, inconsistent assignments, and stale commits. Replaying stored model outputs must not trigger fresh model calls.

## Engine cycle

1. Ingest and normalize evidence, user answers, and steering.
2. Reconcile hypotheses and invalidate dependent work.
3. Select expansion and research work within budgets.
4. Obtain reasoning and batched judgment results.
5. Apply deterministic policy, then fork, reuse, merge, or defer.
6. Rank eligible human questions by expected value.
7. Commit eligible decisions and emit updated projections.

Separate expansion, hypothesis, evidence, and human schedulers may initially run in one process. A queued question must not block unrelated work. Exhausting useful speculation yields an honest waiting state rather than an endless loop.

Work carries the graph revision and hypothesis dependencies it was started with. Late results are accepted only if still applicable; otherwise they are recorded as stale or retained for explicitly justified reuse. Cancellation is cooperative. A cancelled worker cannot later commit an outdated answer.

## Reconciliation and merging

An explicit answer prunes incompatible hypotheses and invalidates descendants that relied on superseded premises. Independent evidence remains reusable. Reopening a committed decision preserves its history and marks affected exports stale.

Beam limits constrain active compute, not truth. A branch dropped for budget reasons is not disproved. Preserve why it was dropped and allow re-expansion when new evidence or an answer requires it.

Start with exact equivalence of normalized relevant state. Semantic judgments can nominate merge candidates. A merge must preserve provenance, unresolved obligations, material constraints, and authority boundaries. Similar prose or a high confidence score alone is insufficient. Conservative non-merging is preferable to losing a consequential alternative.

If branches converge, retain unresolved distinctions that still matter to authority or externally visible behavior. Where a distinction truly becomes irrelevant, withdraw its question with a reason; do not record an invented user answer.

## Commitment policy

- An explicit answer takes precedence over a conflicting inference.
- A committed human decision changes only through an explicit reopening path.
- Agent discretion is bounded by the recorded delegation and consequences.
- Approval-required decisions cannot auto-commit without the required approval.
- Branch invariance is evidence for eligibility, not an automatic authority grant.
- Provisional and hypothetical results never enter committed exports as settled facts.
- Speculation itself must be authorized; hypothetical permission cannot authorize external actions.
- Budgets bound calls, tokens, cost, concurrent workers, active hypotheses, and exploration depth/work.

The policy returns a reason and provenance for every automatic resolution, deferral, escalation, and commitment. Judgments retain provider/model version and calibration context. A judgment failure should preserve uncertainty rather than silently select a default.

## VoI scheduling

Estimate the value of resolving a question from expected loss avoided and useful computation enabled, minus attention and timing cost. Rank only policy-eligible questions. Mandatory authority checkpoints cannot be optimized away by a low score.

Do not multiply arbitrary scores and label the result a probability. Keep feature values, units or ordinal scales, missing-data behavior, and rationale inspectable. Prevent starvation of critical unresolved decisions. Bundle independent questions where helpful, while avoiding questions whose options depend on unanswered parents unless explicitly conditional.

## Application and interaction contracts

Commands: startSession, addContext, submitEvidence, answerQuestion, deferQuestion, delegateQuestion, reopenDecision, startExploration, pauseExploration, resumeExploration, steer, commit, exportSpec.

Queries: session, question queue, graph, hypotheses, decision details, timeline, budgets, and metrics. Events are available through a resumable subscription with a sequence cursor.

QuestionCard includes identity and revision, prompt, response schema, choices where applicable, importance, why-now explanation, consequence summary, provenance references, optional recommendation, and permitted actions. Recommendations are visibly distinct from answers.

GrillStatus separates exploration state, queued input, actual blockers, active hypotheses, research, commitments, eliminated questions, budgets, and errors. Explanations should use stored provenance rather than retrospective invented rationales.

## Adapters

Pi exposes a small tool and command surface plus the question/status views. Session references reconnect to the service's durable state. Focus handling and concurrent TUI updates need a real integration test before selecting the final presentation.

The MCP target is protocol 2026-07-28 with the current TypeScript SDK, subject to exact package pinning. Application sessions have explicit handles independent of transport sessions. Tasks, MRTR and optional Apps are separate capabilities, with structured tool access for clients without rich UI.

The engine may be exploring while questions are available. This is application status, not an invented MCP task status. Map to the protocol's actual working/input_required states per operation. A blocking input request must not incorrectly imply that every engine worker is blocked. Task input uses tasks/update; ordinary MRTR continuation retries the original request. Validate both flows independently.

The service owns provider execution. No core dependency on MCP Sampling is planned. Disconnecting a view does not destroy a session; worker lifetime, restart recovery, and cancellation semantics must be explicit.

## Storage, export, and privacy

Keep runtime session data outside source control. Store only the context needed for the session, with configurable retention and deletion. Provider requests use selected context, not unrestricted filesystem or environment capture.

Exports read a specific committed revision and record provenance without embedding credentials, private absolute paths, or raw transcripts by default. An explicit separate assumptions/open-questions report can include unresolved state, clearly labeled. Exporting locally and publishing publicly are different actions.

Implementation acceptance includes crash recovery, duplicate input, stale workers, migrations, unauthorized cross-session access, and bounded resource consumption.
