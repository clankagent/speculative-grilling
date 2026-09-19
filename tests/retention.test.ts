import { expect, test } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrillService } from "../src/storage.js";

test("session deletion checks access and removes only associated history and adapter state", () => {
  const s = new GrillService(":memory:");
  try {
    const a = s.start("Delete synthetic session"),
      b = s.start("Keep synthetic session");
    s.putPrivate("task-a", { access: a });
    s.putPrivate("pi-a", a);
    s.putPrivate("task-b", { access: b });
    expect(() => s.deleteSession({ ...a, secret: "wrong" })).toThrow();
    s.execute(
      a,
      { type: "startWork", workId: "w", hypothesisId: "root", reserveTokens: 100 },
      "system",
    );
    expect(() => s.deleteSession(a)).toThrow("Pause");
    s.execute(a, { type: "pause" }, "human");
    s.deleteSession(a);
    expect(() => s.read(a)).toThrow("access denied");
    expect(s.getPrivate("task-a")).toBeUndefined();
    expect(s.getPrivate("pi-a")).toBeUndefined();
    expect(s.getPrivate("task-b")).toBeDefined();
    expect(s.read(b).brief).toBe("Keep synthetic session");
  } finally {
    s.close();
  }
});

test("schema 1 adapter metadata migrates transactionally without changing event replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "grill-migration-"));
  const path = join(directory, "sessions.sqlite");
  try {
    let s = new GrillService(path);
    const a = s.start("Migration fixture");
    s.putPrivate("fixture", { access: a });
    const before = s.read(a);
    s.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "ALTER TABLE adapter_state DROP COLUMN session_id; UPDATE metadata SET value='1' WHERE key='schemaVersion'",
    );
    legacy.close();
    s = new GrillService(path);
    try {
      expect(s.read(a)).toEqual(before);
      expect(s.replay(a)).toEqual(before);
      s.deleteSession(a);
      expect(s.getPrivate("fixture")).toBeUndefined();
    } finally {
      s.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
