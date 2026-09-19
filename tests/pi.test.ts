import { expect, test, vi } from "vite-plus/test";
import {
  discoverAndLoadExtensions,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("real Pi loader registers tools and human command answers the same durable graph", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grill-pi-test-"));
  vi.stubEnv("GRILL_DATABASE", join(dir, "sessions.sqlite"));
  vi.stubEnv("GRILL_REASONING_API_KEY", "");
  vi.stubEnv("TYPESAFE_API_KEY", "");
  const loaded = await discoverAndLoadExtensions([resolve("src/adapters/pi.ts")], dir, dir);
  expect(loaded.errors).toEqual([]);
  const extension = loaded.extensions[0]!;
  const selections = ["links · Allow public links?", "yes · Yes"];
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: dir,
    sessionManager: { getSessionId: () => "synthetic-pi-session" },
    ui: {
      setWidget: vi.fn(),
      notify,
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => selections.shift()),
      editor: vi.fn(),
      setEditorText: vi.fn(),
    },
  } as unknown as ExtensionContext;
  try {
    expect([...extension.tools.keys()]).toEqual([
      "grill_review_answers",
      "grill_start",
      "grill_inspect",
      "grill_command",
    ]);
    for (const handler of extension.handlers.get("session_start") ?? [])
      await handler({ type: "session_start", reason: "startup" }, ctx);
    const call = async (name: string, args: unknown) =>
      extension.tools.get(name)!.definition.execute("test", args, undefined, undefined, ctx);
    await call("grill_start", { brief: "Synthetic notebook" });
    await call("grill_command", {
      commandId: "propose",
      command: JSON.stringify({
        type: "propose",
        decision: {
          id: "links",
          prompt: "Allow public links?",
          authority: "user_required",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      }),
    });
    await call("grill_command", {
      commandId: "schedule",
      command: JSON.stringify({ type: "schedule" }),
    });
    await extension.commands.get("grill")!.handler("questions", ctx as ExtensionCommandContext);
    const graph = await call("grill_inspect", { view: "graph" });
    const content = graph.content.find((c) => c.type === "text");
    expect(content?.type).toBe("text");
    if (content?.type === "text")
      expect(JSON.parse(content.text).decisions.links.selection.basis).toBe("explicit");
    expect(notify).not.toHaveBeenCalledWith(expect.anything(), "error");
    const blocked = await call("grill_command", {
      commandId: "forged",
      command: JSON.stringify({ type: "delegate", decisionId: "links" }),
    });
    expect(blocked.details).toEqual({ error: true });
    await call("grill_command", {
      commandId: "new-review",
      command: JSON.stringify({
        type: "propose",
        decision: {
          id: "expiry",
          prompt: "Expiry?",
          authority: "user_required",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      }),
    });
    const reviewed = await call("grill_review_answers", {
      sourceText: "No expiry",
      answers: [{ decisionId: "expiry", revision: 1, optionId: "no" }],
    });
    expect(reviewed.details).toEqual({ accepted: true });
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Review interpreted answers",
      expect.stringContaining("No expiry"),
    );
  } finally {
    for (const handler of extension.handlers.get("session_shutdown") ?? [])
      await handler({ type: "session_shutdown" }, ctx);
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
