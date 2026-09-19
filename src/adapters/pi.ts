import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GrillService, type SessionAccess } from "../storage.js";
import {
  agentCommand,
  humanResponse,
  status,
  safeError,
  answerReviewPreview,
  acceptAnswerReview,
} from "../application.js";
import { configuredProviders } from "../providers.js";
import { ExplorationRunner } from "../runner.js";

export default function grillExtension(pi: ExtensionAPI) {
  let service: GrillService | undefined;
  let runner: ExplorationRunner | undefined;
  let access: SessionAccess | undefined;
  let unsubscribe: AbortController | undefined;
  const requireService = () => {
    if (!service) throw new Error("Grill session is not initialized");
    return service;
  };
  const requireAccess = () => {
    if (!access) throw new Error("Start a grill session with /grill start");
    return access;
  };
  const update = (ctx: ExtensionContext) => {
    if (!service || !access || !ctx.hasUI) return;
    const value = status(service.read(access));
    ctx.ui.setWidget("speculative-grilling", [
      `Grill · ${value.state} · ${value.activeHypotheses} hypotheses · ${value.pendingQuestions} questions · ${value.committedDecisions} committed`,
      "/grill questions · /grill explore · /grill status",
    ]);
  };
  const watch = (ctx: ExtensionContext) => {
    unsubscribe?.abort();
    unsubscribe = new AbortController();
    const localService = requireService();
    const localAccess = requireAccess();
    const signal = unsubscribe.signal;
    void (async () => {
      try {
        for await (const _event of localService.subscribe(
          localAccess,
          localService.read(localAccess).revision,
          signal,
        ))
          update(ctx);
      } catch {
        if (!signal.aborted && ctx.hasUI) ctx.ui.notify("Grill event stream stopped", "error");
      }
    })();
    update(ctx);
  };
  pi.on("session_start", async (_event, ctx) => {
    service = new GrillService(process.env["GRILL_DATABASE"]);
    const providers = configuredProviders();
    runner = providers.reasoning
      ? new ExplorationRunner(service, providers.reasoning, providers.judgment)
      : undefined;
    access = service.getPrivate<SessionAccess>(`pi:${ctx.sessionManager.getSessionId()}`);
    if (access) {
      service.recover(access);
      watch(ctx);
    }
  });
  pi.on("session_shutdown", async () => {
    unsubscribe?.abort();
    await runner?.close();
    service?.close();
    service = undefined;
    access = undefined;
  });
  pi.registerTool({
    name: "grill_review_answers",
    label: "Review interpreted answers",
    description:
      "Propose structured interpretations of the human's free text. A native confirmation shows every proposed choice before anything is committed.",
    parameters: Type.Object({
      sourceText: Type.String(),
      answers: Type.Array(
        Type.Object({
          decisionId: Type.String(),
          revision: Type.Integer(),
          optionId: Type.Optional(Type.String()),
          other: Type.Optional(Type.String()),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        if (!ctx.hasUI)
          return {
            content: [{ type: "text", text: "Human review requires an interactive Pi session" }],
            details: { accepted: false },
          };
        const s = requireService(),
          a = requireAccess();
        const accepted = await ctx.ui.confirm(
          "Review interpreted answers",
          answerReviewPreview(s, a, params),
        );
        if (accepted) acceptAnswerReview(s, a, params);
        update(ctx);
        return {
          content: [
            { type: "text", text: JSON.stringify({ accepted, status: status(s.read(a)) }) },
          ],
          details: { accepted },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: safeError(error) }],
          details: { accepted: false },
        };
      }
    },
  });
  pi.registerTool({
    name: "grill_start",
    label: "Start clarification",
    description:
      "Start a durable speculative clarification session from a brief. Human decisions use /grill questions.",
    parameters: Type.Object({ brief: Type.String({ minLength: 1, maxLength: 50000 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (access)
        return {
          content: [
            {
              type: "text",
              text: "A grill session already exists. Use /grill start to explicitly replace it.",
            },
          ],
          details: {},
        };
      access = requireService().start(params.brief);
      requireService().putPrivate(`pi:${ctx.sessionManager.getSessionId()}`, access);
      watch(ctx);
      return {
        content: [{ type: "text", text: JSON.stringify(status(requireService().read(access))) }],
        details: {},
      };
    },
  });
  pi.registerTool({
    name: "grill_inspect",
    label: "Inspect clarification",
    description: "Read the decision graph, queue, or committed specification.",
    parameters: Type.Object({
      view: Type.Union([
        Type.Literal("status"),
        Type.Literal("graph"),
        Type.Literal("questions"),
        Type.Literal("export"),
      ]),
    }),
    async execute(_id, params) {
      const s = requireService();
      const a = requireAccess();
      const value =
        params.view === "status"
          ? status(s.read(a))
          : params.view === "questions"
            ? s.questions(a)
            : params.view === "export"
              ? s.export(a)
              : s.read(a);
      return {
        content: [
          { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
        ],
        details: {},
      };
    },
  });
  pi.registerTool({
    name: "grill_command",
    label: "Update clarification",
    description:
      "Apply a validated agent command. Accepts propose, evidence, context, resolve, choose, commit, schedule, fork, merge, pause, resume. Human answers and delegation are UI-only.",
    parameters: Type.Object({
      command: Type.String({
        description: "JSON command following the documented engine command schema",
      }),
      commandId: Type.String(),
    }),
    async execute(_id, params) {
      try {
        const state = agentCommand(
          requireService(),
          requireAccess(),
          JSON.parse(params.command),
          params.commandId,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(status(state)) }],
          details: { error: false },
        };
      } catch (error) {
        return { content: [{ type: "text", text: safeError(error) }], details: { error: true } };
      }
    },
  });
  pi.registerCommand("grill", {
    description:
      "Speculative clarification: start, questions, explore, status, graph, steer, reopen, pause, resume, export, forget",
    handler: async (args, ctx) => {
      try {
        const [action = "status", ...rest] = args.trim().split(/\s+/);
        const argument = rest.join(" ");
        const s = requireService();
        if (action === "start") {
          const brief = argument || (await ctx.ui.editor("What are we designing?"));
          if (!brief?.trim()) return;
          if (access) await runner?.stop(access);
          access = s.start(brief);
          s.putPrivate(`pi:${ctx.sessionManager.getSessionId()}`, access);
          watch(ctx);
          return;
        }
        const a = requireAccess();
        if (action === "questions") {
          const questions = s.questions(a);
          if (!questions.length) {
            ctx.ui.notify("No questions currently need your input", "info");
            return;
          }
          const selected = await ctx.ui.select(
            "Needs your input",
            questions.map((q) => `${q.id} · ${q.prompt}`),
          );
          const q = questions.find((q) => `${q.id} · ${q.prompt}` === selected);
          if (!q) return;
          const labels = q.options.map((o) => `${o.id} · ${o.label}`);
          const choice = await ctx.ui.select(`${q.prompt}\n${q.whyNow}`, [
            ...labels,
            "Something else…",
            "Defer",
            ...(q.mayDelegate ? ["Delegate this decision"] : []),
          ]);
          if (!choice) return;
          if (choice === "Something else…") {
            const answer = await ctx.ui.editor(q.prompt);
            if (answer?.trim()) humanResponse(s, a, q.id, q.revision, { action: "other", answer });
          } else if (choice === "Defer") humanResponse(s, a, q.id, q.revision, { action: "defer" });
          else if (choice === "Delegate this decision")
            humanResponse(s, a, q.id, q.revision, { action: "delegate" });
          else {
            const option = q.options[labels.indexOf(choice)];
            if (option)
              humanResponse(s, a, q.id, q.revision, { action: "answer", answer: option.id });
          }
          if (runner && s.read(a).state !== "paused") {
            void runner.start(a).then(
              () => update(ctx),
              () => ctx.ui.notify("Exploration stopped; inspect session status", "error"),
            );
          }
        } else if (action === "explore") {
          if (!runner) {
            ctx.ui.notify(
              "Configure GRILL_REASONING_PROVIDER, GRILL_REASONING_MODEL and GRILL_REASONING_API_KEY",
              "warning",
            );
            return;
          }
          s.execute(a, { type: "resume" }, "human");
          void runner.start(a).then(
            () => update(ctx),
            () => ctx.ui.notify("Exploration stopped; inspect session status", "error"),
          );
        } else if (action === "pause") {
          if (runner) await runner.stop(a);
          else s.execute(a, { type: "pause" }, "human");
        } else if (action === "resume") s.execute(a, { type: "resume" }, "human");
        else if (action === "steer") {
          const value = argument || (await ctx.ui.editor("Steer the design"));
          if (value) s.execute(a, { type: "steer", text: value }, "human");
        } else if (action === "reopen")
          s.execute(a, { type: "reopen", decisionId: argument }, "human");
        else if (action === "forget") {
          if (
            await ctx.ui.confirm(
              "Delete this clarification session?",
              "This removes its decisions, history, and saved adapter access from the local database. Exported files and backups remain separate.",
            )
          ) {
            unsubscribe?.abort();
            if (runner) await runner.stop(a);
            else s.execute(a, { type: "pause" }, "human");
            s.deleteSession(a);
            access = undefined;
            ctx.ui.setWidget("speculative-grilling", []);
            ctx.ui.notify("Clarification session deleted", "info");
          }
        } else if (action === "export") {
          ctx.ui.setEditorText(s.export(a));
          ctx.ui.notify(
            "Committed specification copied into the editor; review before sending or saving",
            "info",
          );
        } else if (action === "graph") {
          await ctx.ui.editor(
            "Decision graph (inspection only)",
            JSON.stringify(s.read(a), null, 2),
          );
        } else ctx.ui.notify(JSON.stringify(status(s.read(a)), null, 2), "info");
        update(ctx);
      } catch (error) {
        ctx.ui.notify(safeError(error), "error");
      }
    },
  });
}
