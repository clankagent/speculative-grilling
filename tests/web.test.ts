import { expect, test } from "vite-plus/test";
import { GrillService } from "../src/storage.js";
import { startWorkspace } from "../src/web/server.js";
import { startExample, exampleProvider } from "../src/web/demo.js";
import { ExplorationRunner } from "../src/runner.js";
import { get } from "node:http";
import { decisionSchema } from "../src/domain.js";

test("new questions become available before later exploration waves finish", async () => {
  const service = new GrillService(":memory:");
  const access = service.start("Synthetic notebook");
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const runner = new ExplorationRunner(service, {
    name: "synthetic",
    reserveTokens: () => 100,
    async expand() {
      if (calls++ === 0)
        return {
          summary: "Two product choices",
          decisions: [
            decisionSchema.parse({
              id: "offline",
              prompt: "Edit offline?",
              authority: "user_required",
              options: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
            }),
          ],
        };
      entered.resolve();
      await release.promise;
      return { summary: "Branch exploration finished", decisions: [] };
    },
  });
  const run = runner.start(access, 2);
  try {
    await entered.promise;
    expect(runner.isRunning(access.sessionId)).toBe(true);
    expect(service.questions(access).map((q) => q.id)).toContain("offline");
  } finally {
    release.resolve();
    await run;
    await runner.close();
    service.close();
  }
});

test("browser transport guards private state and applies human answers to the shared graph", async () => {
  const service = new GrillService(":memory:");
  const access = startExample(service);
  const ui = await startWorkspace(service, access, { demo: true });
  const connect = await fetch(`${ui.origin}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: new URL(ui.url).hash.slice(1) }),
  });
  const cookie = connect.headers.get("set-cookie")!.split(";")[0]!;
  const post = (value: unknown, extra: Record<string, string> = {}) =>
    fetch(`${ui.origin}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie, ...extra },
      body: JSON.stringify(value),
    });
  try {
    expect(connect.status).toBe(200);
    expect(connect.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect((await fetch(`${ui.origin}/api/state`)).status).toBe(400);
    expect((await post({ type: "pause" }, { Origin: "https://untrusted.example" })).status).toBe(
      400,
    );
    const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
      get(`${ui.origin}/api/state`, { headers: { cookie, Host: "untrusted.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
    expect(invalidHost).toBe(400);
    const before = service.read(access),
      q = service.questions(access).find((q) => q.id === "retention")!;
    const answer = {
      type: "answer",
      id: q.id,
      revision: q.revision,
      response: { action: "answer", answer: "recover" },
    };
    expect((await post(answer)).status).toBe(200);
    expect(service.read(access).decisions.retention?.committed).toBe(true);
    expect(service.questions(access).some((q) => q.id === "restore")).toBe(true);
    expect(
      Object.values(service.read(access).hypotheses).some(
        (h) => h.assignments.retention === "erase" && h.status === "pruned",
      ),
    ).toBe(true);
    expect((await post(answer)).status).toBe(400);
    expect(service.read(access).calls).toBe(before.calls);
    expect(service.replay(access)).toEqual(service.read(access));
    const snapshot = await (await fetch(`${ui.origin}/api/state`, { headers: { cookie } })).text();
    expect(snapshot).not.toContain(access.secret);
    expect(snapshot).not.toContain(new URL(ui.url).hash.slice(1));
    const reviewId = ui.queueReview({
      sourceText: "Read only offline",
      answers: [
        {
          decisionId: "offline",
          revision: service.read(access).decisions.offline!.revision,
          optionId: "read",
        },
      ],
    });
    expect(service.read(access).decisions.offline!.committed).toBe(false);
    expect((await post({ type: "review", id: reviewId, accept: true })).status).toBe(200);
    expect(service.read(access).decisions.offline!.selection?.optionId).toBe("read");
  } finally {
    await ui.close();
    service.close();
  }
});

test("live stream carries concurrent work and answers without blocking the UI", async () => {
  const service = new GrillService(":memory:");
  const access = startExample(service);
  const runner = new ExplorationRunner(service, exampleProvider(150));
  const ui = await startWorkspace(service, access, { runner, demo: true });
  const connect = await fetch(`${ui.origin}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: new URL(ui.url).hash.slice(1) }),
  });
  const cookie = connect.headers.get("set-cookie")!.split(";")[0]!;
  const post = (value: unknown) =>
    fetch(`${ui.origin}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify(value),
    });
  const abort = new AbortController();
  try {
    const feed = await fetch(`${ui.origin}/api/events`, {
      headers: { cookie },
      signal: abort.signal,
    });
    const reader = feed.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("questions");
    expect((await post({ type: "explore" })).status).toBe(200);
    expect(runner.isRunning(access.sessionId)).toBe(true);
    const q = service.questions(access)[0]!;
    expect(
      (
        await post({
          type: "answer",
          id: q.id,
          revision: q.revision,
          response: { action: "answer", answer: q.options[0]!.id },
        })
      ).status,
    ).toBe(200);
    await runner.start(access);
    expect(service.read(access).decisions[q.id]!.committed).toBe(true);
    expect(
      Object.values(service.read(access).work).some(
        (w) => w.status === "stale" || w.status === "completed",
      ),
    ).toBe(true);
    abort.abort();
  } finally {
    abort.abort();
    await ui.close();
    await runner.close();
    service.close();
  }
});

test("live browser starts arbitrary briefs only on request and rejects answers from a replaced session", async () => {
  const service = new GrillService(":memory:");
  let calls = 0;
  const runner = new ExplorationRunner(service, {
    name: "synthetic",
    reserveTokens: () => 100,
    async expand() {
      calls++;
      return { summary: "Explored", decisions: [], exhausted: true };
    },
  });
  let saved;
  const ui = await startWorkspace(service, undefined, {
    runner,
    allowNew: true,
    onSession: (access) => {
      saved = access;
    },
  });
  const connect = await fetch(`${ui.origin}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: new URL(ui.url).hash.slice(1) }),
  });
  const cookie = connect.headers.get("set-cookie")!.split(";")[0]!;
  const post = (value: unknown) =>
    fetch(`${ui.origin}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify(value),
    });
  try {
    expect(
      (await (await fetch(`${ui.origin}/api/state`, { headers: { cookie } })).json()).state,
    ).toBeNull();
    expect(calls).toBe(0);
    expect((await post({ type: "start", brief: "short" })).status).toBe(400);
    const first = await (
      await post({ type: "start", brief: "Design a synthetic reading application" })
    ).json();
    expect(first.state.brief).toBe("Design a synthetic reading application");
    expect(saved).toBeDefined();
    const second = await (
      await post({ type: "start", brief: "Design a synthetic hiking notebook" })
    ).json();
    expect(second.state.id).not.toBe(first.state.id);
    expect(
      (await post({ type: "steer", text: "Obsolete tab", sessionId: first.state.id })).status,
    ).toBe(400);
    expect((await post({ type: "pause", sessionId: second.state.id })).status).toBe(200);
    expect(calls).toBeGreaterThan(0);
  } finally {
    await ui.close();
    await runner.close();
    service.close();
  }
});
