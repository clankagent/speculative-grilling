# Implementation roadmap

Every stage contributes to the complete system. The sections below define acceptance targets; the running guide distinguishes implemented behavior from remaining release work.

## Current checkpoint

The development alpha implements the policy kernel, transactional SQLite service, bounded hypotheses, revision-checked workers, provider adapters, queue ranking, opt-in recorded-outcome convergence, Pi extension, and MCP tools/MRTR/Tasks. Regression tests cover state invariants, actual adapter dispatch, stdio process shutdown, and Pi extension loading. The synthetic demo and benchmark run without credentials. The MIT license is selected, and separate live OpenRouter reasoning and Jev judgment smoke tests have passed. Combined live workflow evaluation, calibrated evaluation, broader semantic reasoning, retention/migrations, and final packaging remain open.

## 1. Contracts and policy kernel

Define schemas, events, commands, authority checks, graph invariants, and interaction contracts. Choose the runtime and storage after verifying provider and adapter constraints.

Acceptance: deterministic replay; invalid cycles and stale revisions rejected; retries cause no duplicate effects; no user-owned or approval-required decision auto-commits; fixture transcripts contain only synthetic data.

## 2. Durable application service

Implement sessions, event persistence, snapshots, queries, resumable subscriptions, budgets, cancellation, and committed export. Add migration and recovery behavior.

Acceptance: restart restores the same state; disconnected clients can resume; two clients cannot silently overwrite an answer; hypothetical content cannot contaminate settled output.

## 3. Speculation and reconciliation

Implement bounded expansion, hypotheses, provenance-scoped reuse, pruning, exact merging, late-result validation, and reopening. Introduce reasoning and judgment provider interfaces before live calls.

Acceptance: unrelated work continues with a pending question; answers prune only dependent worlds; a stale worker cannot revive a pruned branch; budget-pruned branches are not treated as evidence; exact merges retain obligations.

## 4. Model integrations and VoI

Implement the reasoning provider, Jev batching, validated structured output, retries, rate limits, usage accounting, judgment calibration, and question ranking. Add conservative semantic merge proposals.

Acceptance: model errors preserve uncertainty; spending is bounded; judgments cannot escalate their own authority; factual questions route to research; consequential user questions remain eligible despite high model confidence.

## 5. Pi and MCP adapters

Build both adapters on the same service. Verify Pi background interaction. Verify MCP capability handling, Tasks, input updates, ordinary MRTR, cancellation, reconnect, and clients without Apps. Decide presentation from these integration results.

Acceptance: a common conformance suite produces equivalent domain events through both adapters; repeated input is idempotent; stale cards are rejected or reconciled explicitly; unsupported capabilities fail clearly or use a documented fallback.

## 6. Evaluation and first complete release

Create hidden-design fixtures: a full intended specification, a redacted initial brief, and a simulated user constrained to the hidden specification. Compare sequential clarification, frontier batching, and speculation under matched budgets and provider conditions.

Measure questions shown, active human time, human blocking time, final design disagreement, false automatic decisions, late invalidations, compute cost, discarded work, reused work, unresolved decisions, and authority violations. Define how each metric is observed and avoid claiming simulated response latency represents real human attention.

Release requires durable sessions, real providers, both adapters, exports, privacy boundaries, installation documentation, a license decision, and published limitations. A deterministic fixture demo is useful for regression testing but does not substitute for live integration validation.

## First implementation slice

Build an end-to-end deterministic session: propose two alternatives, explore both, queue a consequential question while independent work continues, accept a structured answer, prune/reuse results, commit authorized decisions, export, restart, and replay. Exercise it through the shared service before adding transport-specific UI.
