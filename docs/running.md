# Running the development alpha

The complete local clarification loop is available through Pi, MCP, and a CLI. The combined live reasoning/Jev/answer/export/replay check has passed. Model quality and semantic thresholds still need broader calibration.

## CLI and package

Build with `pnpm exec vp run build`, then use `node dist/src/cli.js help`. The CLI supports `start <name> <brief>`, `use <name>`, `explore`, `ask`, `status`, `graph`, `steer <text>`, `reopen <decision>`, `pause`, `resume`, `export`, and `forget`. Only explore makes provider calls. Answering commits the displayed choice and unlocks dependent questions. Forget requires explicit confirmation.

`pnpm pack` creates an installable archive of built code, declarations, public docs and the MIT license. Installing the archive with pnpm exposes the grill command and the speculative-grilling library entry point. Build before packing. The package remains private to prevent accidental registry publication; the public repository and local archive remain usable. The Pi package manifest points to the built extension. A clean archive installation and library import have been checked.

## Installation and checks

Use Node 24 and the package-manager version pinned in package.json. Install with `pnpm install --frozen-lockfile`. Run tasks through the project Vite Plus executable:

```sh
pnpm exec vp run check
pnpm exec vp test run
pnpm exec vp run build
pnpm exec vp run demo
pnpm exec vp run benchmark
```

The demo and benchmark use synthetic data. Neither requires credentials. The benchmark covers five scenarios and three policies under identical definitions, facts, authority and budget ceilings. Hidden answers enter through simulated human input. Scoring checks disagreement, false automatic choices and unresolved decisions. It tests policy behavior, not real model quality or human attention savings.

## Pi

From the installed checkout:

```sh
pnpm exec pi --extension ./src/adapters/pi.ts
```

The extension exposes grill_start, grill_inspect, grill_command, and grill_review_answers to the agent. Human interaction uses the `/grill` command:

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

Accepted UI answers record answer and commitment events atomically and unlock dependent questions. Configured exploration can continue within the session budget. For free text spanning several decisions, grill_review_answers displays the original text and every proposed interpretation in a native confirmation. Acceptance commits the batch atomically; stale or invalid entries prevent the entire batch from committing. The host agent supplies interpretations; interpretation alone is never consent. `/grill forget` confirms deletion of the current session and its local history.

## MCP

Build once, then configure a local stdio MCP host to launch `node` with the absolute path to `dist/src/adapters/mcp-main.js`. Launching through `pnpm exec tsx src/adapters/mcp-main.ts` also works for development. Do not use a script runner that writes task banners to stdout as the host's transport command.

Available tools are grill_start, grill_inspect, grill_command, grill_questions, grill_review_answers, grill_explore, grill_export, and grill_forget. grill_start returns a session ID and private access token; keep both in the authorized host's local state. Possessing a session ID alone does not allow access. Reviewed interpretations and session deletion require genuine human confirmation through elicitation.

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

OpenRouter uses Chat Completions JSON mode; select a model supporting response_format. Other providers use their catalog API. Outputs still require local schema validation. See the [OpenRouter structured-output documentation](https://openrouter.ai/docs/guides/features/structured-outputs). Failures have safe categories rather than raw provider messages. The runner reserves room for judgments when possible and reports budget_exhausted when requests cannot fit. Questions remain answerable after compute stops.

Metrics now include reported reasoning tokens and SDK-estimated cost. Missing usage for Jev, failed, or cancelled calls is explicit through usageCoverageComplete. These estimates are not billing receipts.

With explicitly configured credentials, `pnpm exec vp run qualify:live` runs a synthetic provider smoke test with at most four calls and 40,000 reserved tokens. This command spends provider credits and is never run by CI. It uses an in-memory database and prints counts only. Supply TYPESAFE_API_KEY as well to exercise Jev; a passing reasoning-only run does not qualify Jev. A successful smoke test establishes connectivity and schema compatibility, not model quality or calibrated convergence.

To qualify Jev independently, inject only TYPESAFE_API_KEY and run `pnpm exec vp run qualify:jev`. It submits one synthetic batch containing three judgments, checks the response schema, and verifies that judgments do not answer or commit the human-owned decision. It makes no reasoning calls and does not retry. Both qualification commands keep credentials in process memory, use an in-memory database, and withhold raw provider errors. Missing credentials fail before any network call.

Validation checkpoint (2026-09-18): the live reasoning smoke test passed using OpenRouter's `anthropic/claude-haiku-4.5`: three completed reasoning calls, 23,935 reserved tokens, one queued question, and zero errors. Jev was disabled for that run. On 2026-09-19, the separate live Jev check passed: one batch returned three valid judgments, producing one assessment while preserving the human question and its uncommitted state. No quality or question-reduction claim follows from this connectivity check.

## State and behavior

Combined live checkpoint (2026-09-19): OpenRouter anthropic/claude-haiku-4.5 and Jev completed two reasoning calls and six decision assessments in three total provider calls, reserving 26,530 tokens with zero errors. A simulated answer committed, appeared in the export, and replay matched. The SDK estimated reasoning cost at USD 0.012922, excluding Jev. Earlier runs exposed budget starvation and invalid JSON, which drove fixes. This validates a workflow, not model quality. GRILL_QUALIFY_MAX_TOKENS can lower the live qualification command's default 40,000-token ceiling.

SQLite stores events, command receipts, and a projection in a transaction. By default it lives in the platform user's local data directory, outside the checkout. Events are retained indefinitely in this alpha. A copied database contains private session context and access material; do not share it as a debug attachment.

Schema 1 adapter metadata migrates transactionally to schema 2 without changing event history. Explicit session deletion removes its events, command receipts and associated adapter access with secure-delete enabled and a WAL checkpoint. Exports, backups and other readers' copies remain separate; this is not a promise of forensic erasure from every copy.

New decisions start as candidates. The runner explores before the scheduling phase queues human questions. Agents doing their own research can use the schedule command when ready. Facts and derivable decisions require supporting evidence before resolution. Delegated choices require recorded human delegation. Commit is a distinct operation and requires resolved prerequisites.

Branch-local proposals receive scoped IDs and carry their hypothetical prerequisites. A node under one alternative cannot leak into another alternative's export. Budget-suspended worlds remain inspectable and are not treated as disproved. Exact merging preserves provenance. Reopening invalidates descendants and premise-dependent evidence. Stale worker results are recorded without applying their proposed decisions.

Experimental convergence is disabled by default. The service's third start argument, or MCP grill_start's policy argument, can set `semanticConvergence: true`. It applies only to reversible, low-impact preferences with a current low-materiality judgment, all alternatives explored, no suspended alternatives or outstanding dependent decisions, and identical nonempty observable effects reported by completed reasoning work. It withdraws the question and preserves the alternative assignments; it does not select or commit an answer. New context restores the alternatives. Matching model-reported effects is evidence under this opt-in policy, not a proof of semantic equivalence. User-required and approval-required questions are excluded.

Differently worded outcomes can also converge when a Jev equivalence score of at least 0.99 references every current reasoning result by work ID; all the other guards still apply. This threshold is not a calibrated probability. New dependent obligations restore the alternatives. Work can declare its input dependencies, retaining all hypothetical premises; unrelated changes can preserve scoped results. The built-in provider filters branch context and tracks the decisions and premises it received.

Runtime work belongs to the running adapter process. Restarting restores session state and detects interrupted work; it never silently reissues paid calls. This alpha does not install a daemon that continues running after the host exits. Adapter metadata and event logs survive disconnects, but continuing compute requires a living worker process.

## Remaining release work

- Broader live-model comparisons and reasoning-provider compatibility.
- Qualification and broader coverage of semantic convergence. The opt-in policy only compares recorded effects under strict guards; it does not claim that similar summaries prove equivalent designs.
- Calibrated VoI estimates and real-user evaluation. Current scores are inspectable ordinal heuristics.
- Further evaluation of scoped result reuse and human-reviewed free-text interpretation.
- Automated repository/web evidence collection. Current evidence is explicitly submitted by the host agent; recording a source does not independently establish its truth.
- Optional separate worker deployment for uninterrupted computation after a host exits. Local migration, deletion and archive packaging are implemented.
- Broader client testing. Current checks cover Node 24, Pi 0.85.1 loading/native UI contracts, MCP SDK 2.0.0 with protocol 2026-07-28, stdio, HTTP dispatch, MRTR and Tasks. They do not establish compatibility with every client or visual inspection of every host UI.

These are limitations of the alpha, not features simulated by its examples. The target remains the complete system in the product brief.
