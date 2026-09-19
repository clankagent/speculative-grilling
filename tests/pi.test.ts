import { expect, test, vi } from "vite-plus/test";
import { discoverAndLoadExtensions, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("real Pi loader connects the browser workspace and queues human review without native dialogs", async () => {
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
    const started = await call("grill_start", { brief: "Synthetic notebook" });
    const startText = started.content.find((c) => c.type === "text");
    if (startText?.type !== "text") throw new Error("Missing workspace");
    const url = new URL(JSON.parse(startText.text).workspaceUrl);
    const connected = await fetch(`${url.origin}/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: url.hash.slice(1) }),
    });
    const cookie = connected.headers.get("set-cookie")!.split(";")[0]!;
    const post = (value: unknown) =>
      fetch(`${url.origin}/api/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify(value),
      });
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
    const snapshot = await (await fetch(`${url.origin}/api/state`, { headers: { cookie } })).json();
    expect(
      (
        await post({
          type: "answer",
          id: "links",
          revision: snapshot.state.decisions.links.revision,
          response: { action: "answer", answer: "yes" },
        })
      ).status,
    ).toBe(200);
    expect(ctx.ui.select).not.toHaveBeenCalled();
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
    expect(reviewed.details).toEqual({ pending: true });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    const pending = await (await fetch(`${url.origin}/api/state`, { headers: { cookie } })).json();
    expect(pending.state.decisions.expiry.committed).toBe(false);
    expect((await post({ type: "review", id: pending.reviews[0].id, accept: true })).status).toBe(
      200,
    );
  } finally {
    for (const handler of extension.handlers.get("session_shutdown") ?? [])
      await handler({ type: "session_shutdown" }, ctx);
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
