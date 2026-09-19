# Speculative Grilling

A non-blocking human clarification engine for agents.

Explore plausible answers before asking the human. Use what those explorations reveal to decide which questions matter. An unresolved question blocks commitment, not computation.

**Status: usable development alpha.** The combined live reasoning/Jev/answer/export/replay workflow has passed. The shared engine, SQLite store, bounded exploration, Pi extension, MCP tools/MRTR/Tasks, reviewed multi-question answers, guarded convergence, scoped work reuse, deletion/migration, CLI and archive packaging are implemented. Model quality and semantic thresholds still need broader calibration. This is not a production release.

## What does using it look like?

You give an agent a design brief. It records uncertain decisions, explores alternative answers within a budget, and presents the questions that still need your judgment. You can answer, add an alternative, defer, or explicitly delegate an eligible choice. Accepted answers prune incompatible branches and unlock dependent questions. Export includes only committed decisions.

This is currently an engine with host integrations, not a standalone graphical app:

| Surface | What you see | Best use |
| --- | --- | --- |
| **Pi extension** | A live status widget, native question menus, free-text editors, and confirmation dialogs | First interactive try, especially if you already use Pi |
| **CLI** | Numbered questions and text output in a terminal | Direct local use without an MCP host |
| **MCP server** | Question/review forms rendered by your MCP host | Connecting an agent app with compatible elicitation support |

There is no web dashboard, graphical decision tree, or custom MCP App yet. Graph inspection currently shows JSON. The Pi interface uses Pi's existing controls, not a separate visual design.

## First try: see the engine without keys

From a new source checkout, with Node 24 and pnpm installed:

```sh
git clone https://github.com/clankagent/speculative-grilling.git
cd speculative-grilling
pnpm install --frozen-lockfile
pnpm exec vp run demo
```

This **automatic, synthetic walkthrough** explores two deletion policies, records a preselected answer, prunes the incompatible world, exports a decision and verifies restart/replay. It costs nothing and needs no credentials. It does not ask you questions and does not demonstrate live model reasoning.

## First interactive try: Pi

In that checkout:

```sh
pnpm exec vp run build
pnpm exec pi --extension ./dist/src/adapters/pi.js
```

Pi itself needs a working model setup for ordinary chat. This project does not set up or replace Pi's model account. Loading the extension alone does not spend credits.

1. Enter `/grill start Design a small offline reading list for one person`.
2. Ask Pi: **“Use the grill tools to inspect this session, record the important design choices and known facts, explore alternatives, and schedule the questions that need my input.”** This uses Pi's own agent and tools.
3. Enter `/grill questions`. Select a question, then select an answer, enter something else, defer it, or delegate if offered.
4. Use `/grill status` to check progress and `/grill graph` for detailed JSON inspection. If no question is queued, inspect status; an empty queue alone does not mean the design is complete.
5. Enter `/grill export` to place the committed specification in Pi's editor for review. Nothing is published automatically.

The native question interaction has this shape (illustrative text, **not a screenshot**):

```text
Grill · waiting · 2 hypotheses · 1 questions · 0 committed
/grill questions · /grill explore · /grill status

Needs your input
  retention · How long are deleted notes recoverable?

How long are deleted notes recoverable?
  month · Recoverable for 30 days
  none · Immediately removed
  Something else…
  Defer
```

For the dedicated background reasoning worker and Jev judgments, configure the provider environment described in the [running guide](docs/running.md#providers), then enter `/grill explore`. **Pi's chat authentication does not automatically configure this worker.** It uses GRILL_REASONING_PROVIDER, GRILL_REASONING_MODEL and GRILL_REASONING_API_KEY; TYPESAFE_API_KEY enables Jev. This step makes paid provider calls. Accepted answers can continue an already configured worker within the session budget.

For an answer spanning several questions, Pi can propose interpretations with grill_review_answers. You see the original text and every proposed choice before accepting the batch. A model's interpretation is never treated as your approval by itself.

## CLI or MCP instead

After building, `node dist/src/cli.js help` lists the CLI commands. Start a named session, run explore with configured providers, run ask to answer its questions, and export the result. Starting a session alone creates an empty graph; it does not generate questions.

For MCP, configure your host to launch Node with the absolute path to dist/src/adapters/mcp-main.js. There is no service URL to open in a browser. Your host needs compatible elicitation to show the human questions; see the [MCP setup and compatibility details](docs/running.md#mcp).

The repository is the current distribution point. You do not need to download the development archive to follow the source-checkout instructions above. Tests and benchmarks are developer checks, not installation steps.

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

[MIT](LICENSE).
