# Running the development alpha

## Installation and checks

Use Node 24 and the package-manager version pinned in package.json. Install with `pnpm install --frozen-lockfile`. Run tasks through the project Vite Plus executable:

```sh
pnpm exec vp run check
pnpm exec vp test run
pnpm exec vp run build
pnpm exec vp run demo
pnpm exec vp run benchmark
```

The demo and benchmark use synthetic data. Neither requires credentials. The benchmark compares scripted policies against a hidden answer map; it verifies the harness and accounting, not model performance or a question-reduction claim.

## Pi

From the installed checkout:

```sh
pnpm exec pi --extension ./src/adapters/pi.ts
```

The extension exposes grill_start, grill_inspect, and grill_command to the agent. Human interaction uses the `/grill` command:

| Command                       | Behavior                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `/grill start <brief>`        | Start a durable session; existing sessions remain in storage                      |
| `/grill questions`            | Open the current question queue and answer, defer, or delegate an eligible choice |
| `/grill explore`              | Begin bounded background reasoning using configured providers                     |
| `/grill status`               | Inspect state, budgets, failures, and commitments                                 |
| `/grill graph`                | Inspect the graph without changing it                                             |
| `/grill steer <text>`         | Record human steering and invalidate in-flight work using old context             |
| `/grill reopen <decision-id>` | Reopen a decision and invalidate dependent commitments                            |
| `/grill pause`                | Cancel current exploration cooperatively                                          |
| `/grill resume`               | Allow exploration again; does not make a paid call by itself                      |
| `/grill export`               | Put committed Markdown in the editor for review; does not publish it              |

A persistent widget updates from the service event stream. Session credentials stay in private adapter storage and are not inserted into Pi's model-visible tool output. The current presentation uses Pi's built-in selectors and editor; a custom visual interface is not required.

## MCP

Build once, then configure a local stdio MCP host to launch `node` with the absolute path to `dist/src/adapters/mcp-main.js`. Launching through `pnpm exec tsx src/adapters/mcp-main.ts` also works for development. Do not use a script runner that writes task banners to stdout as the host's transport command.

Available tools are grill_start, grill_inspect, grill_command, grill_questions, grill_explore, and grill_export. grill_start returns a session ID and private access token; keep both in the authorized host's local state. Possessing a session ID alone does not allow access.

grill_command accepts validated domain commands but cannot answer on behalf of the human, delegate authority, inject worker results, or manufacture Jev assessments. Use a unique commandId for each logical mutation and reuse it only for retries of the same input.

grill_questions uses MCP input_required elicitation. It can return several independent questions together, accepts free text as an explicit alternative, and treats refusal as deferral. The trusted MCP host is responsible for obtaining genuine human input.

grill_explore returns a durable Task when the request advertises the io.modelcontextprotocol/tasks extension. Clients poll tasks/get, supply input through tasks/update, and cancel through tasks/cancel. Other clients receive a normal bounded result. Task IDs are unguessable bearer capabilities for that task; keep them private. Tasks are not enumerable.

The pinned SDK's core registry still rejects tasks/get and tasks/cancel for modern requests. The adapter therefore implements the official Tasks extension at a separate validated transport boundary, while the SDK handles core MCP. This is covered by wire-level tests and does not modify the dependency. The same layer is used for stdio and the programmatic local HTTP handler.

The programmatic HTTP handler is for local integration/testing. No public HTTP listener or remote authentication deployment is installed.

## Providers

Supply credentials through the environment of the adapter process or a secret manager. Never save real credentials in this repository, examples, command arguments, or an MCP configuration intended for publication.

| Variable                 | Purpose                                               |
| ------------------------ | ----------------------------------------------------- |
| GRILL_REASONING_PROVIDER | Provider ID supported by the installed Pi AI SDK      |
| GRILL_REASONING_MODEL    | Exact model ID from that provider's catalog           |
| GRILL_REASONING_API_KEY  | Explicit credential used only for reasoning calls     |
| TYPESAFE_API_KEY         | Optional credential for direct Jev batch judgments    |
| GRILL_DATABASE           | Optional private SQLite location outside the checkout |

No provider is selected automatically. Without reasoning configuration the graph tools still work and exploration reports the missing configuration. The Jev adapter uses the documented systemone endpoint and typed Noul questions. Judgments influence queue ranking; they cannot override authority or commit decisions.

The reasoning provider receives the explicitly supplied brief, session context, decision definitions, evidence summaries, and the selected hypothetical world. It does not read the ambient filesystem, environment, chat history, or credentials for context. Remote model services still receive that selected content when exploration is requested.

Calls have timeouts and no automatic paid retry. Provider error bodies are withheld from durable logs and tool output. Token reservations use conservative byte-based input estimates and the configured output limit. They are not actual usage or dollar accounting. A session defaults to 20 calls, 60,000 reserved tokens, two concurrent workers, and three active hypotheses. Configure these limits when creating a session.

## State and behavior

SQLite stores events, command receipts, and a projection in a transaction. By default it lives in the platform user's local data directory, outside the checkout. Events are retained indefinitely in this alpha. A copied database contains private session context and access material; do not share it as a debug attachment.

New decisions start as candidates. The runner explores before the scheduling phase queues human questions. Agents doing their own research can use the schedule command when ready. Facts and derivable decisions require supporting evidence before resolution. Delegated choices require recorded human delegation. Commit is a distinct operation and requires resolved prerequisites.

Branch-local proposals receive scoped IDs and carry their hypothetical prerequisites. A node under one alternative cannot leak into another alternative's export. Budget-suspended worlds remain inspectable and are not treated as disproved. Exact merging preserves provenance. Reopening invalidates descendants and premise-dependent evidence. Stale worker results are recorded without applying their proposed decisions.

Experimental convergence is disabled by default. The service's third start argument, or MCP grill_start's policy argument, can set `semanticConvergence: true`. It applies only to reversible, low-impact preferences with a current low-materiality judgment, all alternatives explored, no suspended alternatives or outstanding dependent decisions, and identical nonempty observable effects reported by completed reasoning work. It withdraws the question and preserves the alternative assignments; it does not select or commit an answer. New context restores the alternatives. Matching model-reported effects is evidence under this opt-in policy, not a proof of semantic equivalence. User-required and approval-required questions are excluded.

Runtime work belongs to the running adapter process. Restarting restores session state and detects interrupted work; it never silently reissues paid calls. This alpha does not install a daemon that continues running after the host exits. Adapter metadata and event logs survive disconnects, but continuing compute requires a living worker process.

## Remaining release work

- Live reasoning-provider and Jev qualification with authorized credentials.
- Qualification and broader coverage of semantic convergence. The opt-in policy only compares recorded effects under strict guards; it does not claim that similar summaries prove equivalent designs.
- Calibrated VoI estimates and real-user evaluation. Current scores are inspectable ordinal heuristics.
- More selective reuse of in-flight results. Current invalidation intentionally errs toward discarding uncertain work.
- Cross-question interpretation of free text. The current implementation stores free text as the explicit alternative for the selected question.
- Automated repository/web evidence collection. Current evidence is explicitly submitted by the host agent; recording a source does not independently establish its truth.
- A separate worker service for uninterrupted computation after a host exits, retention controls, and storage migrations beyond the initial schema.
- Final license choice, packaging, and supported-client release matrix.

These are limitations of the alpha, not features simulated by its examples. The target remains the complete system in the product brief.
