# Speculative Grilling

A non-blocking human clarification engine for agents.

Explore plausible answers before asking the human. Use what those explorations reveal to decide which questions matter. An unresolved question blocks commitment, not computation.

**Status: runnable development alpha.** The shared engine, SQLite event store, bounded exploration runner, Pi extension, MCP v2 tools, human elicitation, and Tasks adapter are implemented. Tests exercise actual MCP dispatch, standalone stdio, and Pi extension loading. An opt-in convergence policy can withdraw low-impact questions with matching recorded outcomes. Live-provider qualification and broader semantic equivalence remain unfinished; this is not a production release.

## Run locally

Requires Node 24 and pnpm. Vite Plus is installed as a project dependency.

```sh
pnpm install --frozen-lockfile
pnpm exec vp run check
pnpm exec vp test run
pnpm exec vp run demo
pnpm exec vp run benchmark
```

The demo uses synthetic data and makes no model calls. It explores alternatives, accepts an explicit answer, prunes incompatible work, exports committed decisions, and verifies replay after reopening the database. The benchmark validates a scripted comparison harness; it is not a measured improvement claim.

See [running and configuring the adapters](docs/running.md) for Pi, MCP, provider configuration, and current limitations.

## The idea

An agent encounters an unresolved product choice. Instead of stopping immediately, it explores bounded alternative hypotheses, investigates facts, and compares consequences. Some alternatives converge. Some become impossible. Some reveal a meaningful decision only the human can make.

The engine uses Value of Information (VoI) to prioritize human attention. Model confidence helps assess evidence; it never grants authority to invent a user's preferences.

For example, two proposed upload implementations might lead to the same user-visible behavior, eliminating an implementation question. Immediate deletion and recoverable deletion remain materially different product choices. Exploring them does not authorize selecting either on the user's behalf.

## Intended system

- A durable, event-sourced decision graph with evidence and provenance.
- Multiple bounded hypotheses, speculative expansion, pruning, merging, and reusable work.
- Explicit authority, epistemic status, and commitment boundaries.
- A capable reasoning model for exploration and a Jev integration for bounded semantic judgments.
- Deterministic policy and a VoI question scheduler.
- An asynchronous question queue supporting structured answers, free text, deferral, delegation, and steering.
- One application service shared by a Pi extension and an MCP server.
- Specification and decision-record exports derived from committed state.
- Instrumentation and a hidden-design evaluation suite.

The interaction contract comes first. The final choice of TUI, web sidecar, and optional MCP App remains open.

## Read next

- [Running guide](docs/running.md): configuration and implemented behavior.
- [Product brief](docs/product-brief.md): scope and product boundaries.
- [Architecture](docs/architecture.md): state, policy, reconciliation, and adapters.
- [Roadmap](docs/roadmap.md): delivery sequence and acceptance criteria.
- [Integration research](docs/integration-research.md): verified references and remaining checks.
- [Public-data policy](docs/public-data-policy.md): source, runtime data, and publication boundaries.
- [Contributing](CONTRIBUTING.md): current workflow.

## License

A license has not been selected yet. Public visibility alone is not an open-source license. Do not assume a reuse or redistribution grant beyond applicable platform terms and law.
