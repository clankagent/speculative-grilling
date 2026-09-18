import { describe, expect, test, afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrillService } from "../src/storage.js";

const services: GrillService[] = [];
const dirs: string[] = [];
afterEach(() => {
  services.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function fixture(path = ":memory:") {
  const service = new GrillService(path);
  services.push(service);
  const access = service.start("Design a synthetic shared notebook");
  const exec = (command: unknown, human = false) =>
    service.execute(access, command, human ? "human" : "agent");
  exec({
    type: "propose",
    decision: {
      id: "retention",
      prompt: "How long are deleted notes recoverable?",
      authority: "user_required",
      options: [
        { id: "month", label: "30 days" },
        { id: "none", label: "Immediately removed" },
      ],
    },
  });
  exec({ type: "schedule" });
  return { service, access, exec };
}
describe("authority and durable state", () => {
  test("speculates, accepts an answer, prunes, commits and replays after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "grill-"));
    dirs.push(dir);
    const path = join(dir, "session.sqlite");
    const { service, access, exec } = fixture(path);
    exec({ type: "fork", hypothesisId: "root", decisionId: "retention" });
    expect(
      Object.values(service.read(access).hypotheses).filter((h) => h.status === "active"),
    ).toHaveLength(2);
    expect(service.export(access)).not.toContain("30 days");
    const q = service.questions(access)[0]!;
    exec({ type: "answer", decisionId: q.id, revision: q.revision, optionId: "month" }, true);
    exec({ type: "commit", decisionId: q.id });
    expect(service.export(access)).toContain("30 days");
    expect(
      Object.values(service.read(access).hypotheses).filter((h) => h.status === "pruned"),
    ).toHaveLength(1);
    expect(service.replay(access)).toEqual(service.read(access));
    const expected = service.read(access);
    service.close();
    services.splice(services.indexOf(service), 1);
    const reopened = new GrillService(path);
    services.push(reopened);
    expect(reopened.read(access)).toEqual(expected);
    expect(reopened.replay(access)).toEqual(expected);
  });
  test("agent cannot answer, delegate to itself, or resolve user choice with evidence", () => {
    const { service, access, exec } = fixture();
    const q = service.questions(access)[0]!;
    expect(() =>
      exec({ type: "answer", decisionId: q.id, revision: q.revision, optionId: "month" }),
    ).toThrow("human");
    expect(() => exec({ type: "delegate", decisionId: q.id })).toThrow("human");
    exec({
      type: "evidence",
      evidence: {
        id: "e1",
        summary: "A generic preference survey",
        source: "Synthetic fixture",
        supports: { retention: "month" },
      },
    });
    expect(() =>
      exec({ type: "resolve", decisionId: q.id, optionId: "month", evidenceIds: ["e1"] }),
    ).toThrow("user preference");
    expect(() => exec({ type: "commit", decisionId: q.id })).toThrow("resolved");
  });
  test("retries are idempotent and conflicting command IDs fail", () => {
    const { service, access } = fixture();
    const command = { type: "context", text: "Use a simple text format" };
    const first = service.execute(access, command, "agent", { commandId: "retry" });
    const second = service.execute(access, command, "agent", {
      commandId: "retry",
      expectedRevision: 0,
    });
    expect(second).toEqual(first);
    expect(service.read(access).context).toHaveLength(1);
    expect(() =>
      service.execute(access, { ...command, text: "Different" }, "agent", { commandId: "retry" }),
    ).toThrow("different input");
  });
  test("stale answers and unauthorized session reads fail without mutations", () => {
    const { service, access, exec } = fixture();
    const q = service.questions(access)[0]!;
    exec({ type: "defer", decisionId: q.id }, true);
    expect(() =>
      exec({ type: "answer", decisionId: q.id, revision: q.revision, optionId: "month" }, true),
    ).toThrow("changed");
    expect(() => service.read({ ...access, secret: "incorrect" })).toThrow("denied");
    expect(() => service.events({ ...access, secret: "incorrect" })).toThrow("denied");
    expect(service.questions(access)).toHaveLength(0);
  });
  test("late workers cannot resurrect pruned hypotheses", () => {
    const { service, access, exec } = fixture();
    exec({ type: "fork", hypothesisId: "root", decisionId: "retention" });
    const h = Object.values(service.read(access).hypotheses).find(
      (h) => h.assignments["retention"] === "none",
    )!;
    exec({ type: "startWork", workId: "w", hypothesisId: h.id, reserveTokens: 1000 });
    const q = service.questions(access)[0]!;
    exec({ type: "answer", decisionId: q.id, revision: q.revision, optionId: "month" }, true);
    exec({
      type: "completeWork",
      workId: "w",
      summary: "A now-invalid result",
      decisions: [
        {
          id: "danger",
          prompt: "Erase now?",
          authority: "agent_discretion",
          options: [
            { id: "a", label: "Yes" },
            { id: "b", label: "No" },
          ],
        },
      ],
    });
    expect(service.read(access).work["w"]?.status).toBe("stale");
    expect(service.read(access).decisions["danger"]).toBeUndefined();
  });
  test("invalid proposals roll back atomically and prevent dependency cycles", () => {
    const { service, access, exec } = fixture();
    const revision = service.read(access).revision;
    expect(() =>
      exec({
        type: "propose",
        decision: {
          id: "cycle",
          prompt: "Cycle?",
          authority: "user_required",
          dependencies: ["cycle"],
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      }),
    ).toThrow("cycles");
    expect(service.read(access).revision).toBe(revision);
  });
  test("reopening invalidates descendants, evidence and committed exports", () => {
    const { service, access, exec } = fixture();
    const q = service.questions(access)[0]!;
    exec({ type: "answer", decisionId: q.id, revision: q.revision, optionId: "month" }, true);
    exec({ type: "commit", decisionId: q.id });
    exec({
      type: "propose",
      decision: {
        id: "backup",
        prompt: "Backup convention?",
        authority: "derivable",
        dependencies: ["retention"],
        options: [
          { id: "yes", label: "Keep backup" },
          { id: "no", label: "No backup" },
        ],
      },
    });
    exec({
      type: "evidence",
      evidence: {
        id: "policy",
        summary: "Synthetic policy",
        source: "Fixture",
        supports: { backup: "yes" },
        premises: ["retention"],
      },
    });
    exec({ type: "resolve", decisionId: "backup", optionId: "yes", evidenceIds: ["policy"] });
    exec({ type: "commit", decisionId: "backup" });
    exec({ type: "reopen", decisionId: "retention" }, true);
    expect(service.read(access).decisions["backup"]?.committed).toBe(false);
    expect(service.read(access).evidence["policy"]?.valid).toBe(false);
    expect(service.export(access)).not.toContain("Keep backup");
  });
  test("context steering invalidates in-flight work and pauses cancel it", () => {
    const { service, access, exec } = fixture();
    exec({ type: "startWork", workId: "w1", hypothesisId: "root", reserveTokens: 100 });
    exec({ type: "steer", text: "Focus only on sharing" }, true);
    exec({ type: "completeWork", workId: "w1", summary: "Old context", decisions: [] });
    expect(service.read(access).work["w1"]?.status).toBe("stale");
    exec({ type: "startWork", workId: "w2", hypothesisId: "root", reserveTokens: 100 });
    exec({ type: "pause" });
    expect(service.read(access).work["w2"]?.status).toBe("cancelled");
    expect(() =>
      exec({ type: "startWork", workId: "w3", hypothesisId: "root", reserveTokens: 100 }),
    ).toThrow("paused");
  });
});
