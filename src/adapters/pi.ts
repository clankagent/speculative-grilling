import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GrillService, type SessionAccess } from "../storage.js";
import { agentCommand, status, safeError } from "../application.js";
import { configuredProviders } from "../providers.js";
import { ExplorationRunner } from "../runner.js";
import { startWorkspace, type Workspace } from "../web/server.js";

export default function grillExtension(pi: ExtensionAPI) {
  let service: GrillService | undefined;
  let runner: ExplorationRunner | undefined;
  let access: SessionAccess | undefined;
  let workspace: Workspace | undefined;
  let opening: Promise<Workspace> | undefined;
  let unsubscribe: AbortController | undefined;
  const requireService = () => {
    if (!service) throw new Error("Session not initialized");
    return service;
  };
  const requireAccess = () => {
    if (!access) throw new Error("Ask the agent to start a design session first");
    return access;
  };
  const getWorkspace = async () => {
    if (workspace) return workspace;
    opening ??= startWorkspace(requireService(), requireAccess(), runner ? { runner } : {});
    try {
      workspace = await opening;
      return workspace;
    } finally {
      opening = undefined;
    }
  };
  const update = (ctx: ExtensionContext) => {
    if (!service || !access || !ctx.hasUI) return;
    const value = status(service.read(access));
    ctx.ui.setWidget("speculative-grilling", [
      `Grill · ${value.pendingQuestions} questions · ${value.committedDecisions} committed`,
      "Ctrl+Shift+G opens the question workspace",
    ]);
  };
  const watch = (ctx: ExtensionContext) => {
    unsubscribe?.abort();
    unsubscribe = new AbortController();
    const s = requireService(),
      a = requireAccess(),
      signal = unsubscribe.signal;
    void (async () => {
      try {
        for await (const _event of s.subscribe(a, s.read(a).revision, signal)) update(ctx);
      } catch {
        if (!signal.aborted && ctx.hasUI) ctx.ui.notify("Grill event stream stopped", "error");
      }
    })();
    update(ctx);
  };
  const open = async (ctx: ExtensionContext) => {
    try {
      const ui = await getWorkspace();
      const result =
        process.platform === "win32"
          ? await pi.exec("rundll32.exe", ["url.dll,FileProtocolHandler", ui.url])
          : await pi.exec(process.platform === "darwin" ? "open" : "xdg-open", [ui.url]);
      if (result.code !== 0) ctx.ui.notify(`Open the workspace: ${ui.url}`, "info");
    } catch (error) {
      ctx.ui.notify(safeError(error), "error");
    }
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
    await workspace?.close();
    await runner?.close();
    service?.close();
    workspace = undefined;
    service = undefined;
    access = undefined;
  });
  pi.registerShortcut("ctrl+shift+g", {
    description: "Open the asynchronous question workspace",
    handler: open,
  });
  pi.registerCommand("grill", {
    description: "Open the question workspace (also Ctrl+Shift+G)",
    handler: async (_args, ctx) => open(ctx),
  });
  pi.registerTool({
    name: "grill_review_answers",
    label: "Review interpreted answers",
    description:
      "Queue interpretations of the human's free text in the browser workspace. Returns immediately; only acceptance in the workspace commits them.",
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
    async execute(_id, params) {
      try {
        const ui = await getWorkspace();
        const reviewId = ui.queueReview(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ pending: true, reviewId, workspaceUrl: ui.url }),
            },
          ],
          details: { pending: true },
        };
      } catch (error) {
        return { content: [{ type: "text", text: safeError(error) }], details: { pending: false } };
      }
    },
  });
  pi.registerTool({
    name: "grill_start",
    label: "Start clarification",
    description:
      "Start a durable design session and return its browser workspace. Present the link to the human. Record choices and explore with tools; human answers happen in the workspace without slash commands.",
    parameters: Type.Object({ brief: Type.String({ minLength: 1, maxLength: 50000 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!access) {
        access = requireService().start(params.brief);
        requireService().putPrivate(`pi:${ctx.sessionManager.getSessionId()}`, access);
        watch(ctx);
      }
      const ui = await getWorkspace();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: status(requireService().read(access)),
              workspaceUrl: ui.url,
            }),
          },
        ],
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
      const s = requireService(),
        a = requireAccess();
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
      "Apply a validated agent command. Human answers, approvals and delegation are browser-only. Inspect after human changes to get current revisions.",
    parameters: Type.Object({ command: Type.String(), commandId: Type.String() }),
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
}
