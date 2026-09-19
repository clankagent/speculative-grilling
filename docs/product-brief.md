# Product brief

## Goal

Reduce avoidable human clarification and blocking time without silently taking ownership of product decisions. Treat clarification as asynchronous decision search rather than a sequence of chat turns.

Success requires both fewer unnecessary interruptions and a faithful final design. Fewer questions alone is not success.

## Established direction

This is intended to become a complete, useful system, not a disposable proof of concept. Incremental delivery should build toward the actual architecture.

The Pi extension and MCP server must use the same engine and application service. Neither adapter owns a separate implementation of exploration, authority, or commitment.

The engine maintains a decision DAG, multiple hypotheses, evidence, and provenance. Human answers are structured events. Exploration continues while questions are pending when useful authorized work remains.

The system distinguishes facts, derived conclusions, delegated implementation choices, user preferences, and explicit approval requirements. Model judgments advise policy; they do not replace it.

Jev is the intended judgment integration. A capable reasoning model generates decisions, explores consequences, interprets free text, and synthesizes output. Provider interfaces must allow deterministic fixtures for testing and calibration.

Value of Information schedules human questions. It considers expected loss avoided, downstream divergence, useful work unlocked, research alternatives, and attention cost. Initially these can be transparent heuristics; calibrated probabilities must not be claimed without evidence.

Durable project documents are projections of committed state. Persisting a hypothesis for session recovery does not make it committed knowledge.

## Human interaction

The primary experience is a small queue of consequential questions, with explanations of why each matters now. A full graph is an inspection surface rather than a required primary interface.

Users can answer with options or free text, offer an alternative, defer, delegate an eligible decision, reopen a prior decision, or steer the entire session. Delegation is explicit and scoped. Silence, deferral, and a recommendation are not consent.

An answer may resolve several decisions. Ambiguous interpretation remains provisional until resolved. Already-withdrawn questions and stale answer revisions must be handled explicitly.

Questions can disappear because evidence resolves them, authorized discretion applies, a parent becomes irrelevant, another answer subsumes them, or branches converge. Convergence can make a question unnecessary; it does not fabricate an answer to a user-owned choice.

## First complete release

Durable sessions; typed graph and events; bounded simultaneous hypotheses; expansion, pruning and merging; evidence; authority policy; reasoning and Jev providers; VoI scheduling; asynchronous interaction; replayable event stream; committed exports; Pi tools; MCP tools, Tasks and multi-round input; adapter-independent presentation contracts; and evaluation instrumentation.

## Deliberately open

- Final project name. The project is licensed under MIT.
- Service hosting topology beyond the initial local adapters. The alpha uses TypeScript, Node 24, SQLite, and pinned SDK versions.
- Reasoning provider defaults and budget presets.
- Embedded MCP App support and additional host surfaces. The primary interaction is now a shared browser workspace; Pi native selectors are not the question interface.
- Supported client versions and compatibility policy beyond the initial MCP target.
- Numeric VoI weights, calibration thresholds, and semantic equivalence policy.

## Outside the initial scope

Autonomous deployment or destructive execution, a general agent platform, mandatory hosted accounts, and automatic publication of user sessions. The engine's authority to explore a design does not authorize executing the design's real-world side effects.
