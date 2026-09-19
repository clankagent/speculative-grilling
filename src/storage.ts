import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import {
  type Actor,
  type GrillEvent,
  type Session,
  budgetSchema,
  policySchema,
  commandSchema,
  ensure,
  project,
} from "./domain.js";
import { exportSpec, questionQueue, transition } from "./engine.js";

export type SessionAccess = { sessionId: string; secret: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function defaultDatabasePath(): string {
  return join(
    process.env["XDG_DATA_HOME"] ??
      (process.platform === "win32"
        ? (process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"))
        : join(homedir(), ".local", "share")),
    "speculative-grilling",
    "sessions.sqlite",
  );
}
export class GrillService {
  private readonly db: DatabaseSync;
  constructor(path = defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('schemaVersion','1');
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id, sequence));
      CREATE TABLE IF NOT EXISTS commands (session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(session_id,id));`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS adapter_state (key TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
    const version = this.db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get();
    ensure(
      ["1", "2"].includes(String(version?.["value"])),
      "SCHEMA_VERSION",
      "Database requires a supported migration",
    );
    if (version?.["value"] === "1")
      this.transaction(() => {
        this.db.exec("ALTER TABLE adapter_state ADD COLUMN session_id TEXT");
        for (const row of this.db.prepare("SELECT key,body FROM adapter_state").all()) {
          const value = JSON.parse(row["body"] as string);
          const sessionId = value?.access?.sessionId ?? value?.sessionId;
          if (
            typeof sessionId === "string" &&
            this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)
          )
            this.db
              .prepare("UPDATE adapter_state SET session_id=? WHERE key=?")
              .run(sessionId, row["key"] as string);
        }
        this.db.exec("UPDATE metadata SET value='2' WHERE key='schemaVersion'");
      });
    this.db.exec("PRAGMA secure_delete=ON");
  }
  close() {
    this.db.close();
  }
  getPrivate<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT body FROM adapter_state WHERE key=?").get(hash(key));
    return row ? (JSON.parse(row["body"] as string) as T) : undefined;
  }
  putPrivate(key: string, value: unknown): void {
    const record = value as { access?: SessionAccess; sessionId?: string } | null;
    const sessionId = record?.access?.sessionId ?? record?.sessionId ?? null;
    this.db
      .prepare(
        "INSERT INTO adapter_state(key,body,session_id) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,session_id=excluded.session_id",
      )
      .run(hash(key), JSON.stringify(value), sessionId);
  }
  deleteSession(access: SessionAccess): void {
    this.transaction(() => {
      const state = this.authenticate(access);
      ensure(
        !Object.values(state.work).some((w) => w.status === "running"),
        "STATE",
        "Pause running work before deleting a session",
      );
      this.db.prepare("DELETE FROM adapter_state WHERE session_id=?").run(access.sessionId);
      this.db.prepare("DELETE FROM commands WHERE session_id=?").run(access.sessionId);
      this.db.prepare("DELETE FROM events WHERE session_id=?").run(access.sessionId);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(access.sessionId);
    });
    // Best-effort checkpoint; copies/backups and other readers have independent lifetimes.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  start(brief: string, budget: unknown = {}, policy: unknown = {}): SessionAccess {
    z.string().min(1).max(50000).parse(brief);
    const sessionId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const initial: Session = {
      id: sessionId,
      revision: 0,
      epoch: 0,
      brief,
      state: "ready",
      context: [],
      decisions: {},
      evidence: {},
      assessments: {},
      hypotheses: {
        root: {
          id: "root",
          assignments: {},
          status: "active",
          reason: "Initial world",
          mergedInto: null,
          parents: [],
        },
      },
      work: {},
      budget: budgetSchema.parse(budget),
      policy: policySchema.parse(policy),
      calls: 0,
      tokensReserved: 0,
    };
    const event: GrillEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      sessionId,
      sequence: 1,
      commandId: randomUUID(),
      actor: "human",
      timestamp: new Date().toISOString(),
      data: { type: "SessionStarted", session: initial },
    };
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO sessions VALUES (?,?,?)")
        .run(sessionId, hash(secret), JSON.stringify(project([event])));
      this.db.prepare("INSERT INTO events VALUES (?,?,?)").run(sessionId, 1, JSON.stringify(event));
    });
    return { sessionId, secret };
  }
  private authenticate(access: SessionAccess): Session {
    const row = this.db
      .prepare("SELECT secret_hash,snapshot FROM sessions WHERE id=?")
      .get(access.sessionId);
    const expected = Buffer.from(
      typeof row?.["secret_hash"] === "string" ? row["secret_hash"] : "0".repeat(64),
      "hex",
    );
    const actual = Buffer.from(hash(access.secret), "hex");
    ensure(timingSafeEqual(expected, actual) && row, "ACCESS", "Session access denied");
    return JSON.parse(row["snapshot"] as string) as Session;
  }
  read(access: SessionAccess): Session {
    return this.authenticate(access);
  }
  events(access: SessionAccess, after = 0): GrillEvent[] {
    this.authenticate(access);
    return this.db
      .prepare("SELECT body FROM events WHERE session_id=? AND sequence>? ORDER BY sequence")
      .all(access.sessionId, after)
      .map((row) => JSON.parse(row["body"] as string) as GrillEvent);
  }
  replay(access: SessionAccess): Session {
    return project(this.events(access));
  }
  execute(
    access: SessionAccess,
    input: unknown,
    actor: Actor = "agent",
    options: { commandId?: string; expectedRevision?: number } = {},
  ): Session {
    const command = commandSchema.parse(input);
    const commandId = options.commandId ?? randomUUID();
    z.string().min(1).max(200).parse(commandId);
    const digest = hash(JSON.stringify({ actor, command }));
    return this.transaction(() => {
      const current = this.authenticate(access);
      const prior = this.db
        .prepare("SELECT digest,result FROM commands WHERE session_id=? AND id=?")
        .get(access.sessionId, commandId);
      if (prior) {
        ensure(prior["digest"] === digest, "IDEMPOTENCY", "Command ID reused with different input");
        return JSON.parse(prior["result"] as string) as Session;
      }
      if (options.expectedRevision !== undefined)
        ensure(current.revision === options.expectedRevision, "STALE", "Session revision changed");
      const changes = transition(current, command, actor);
      const events: GrillEvent[] = changes.map((data, i) => ({
        schemaVersion: 1,
        id: randomUUID(),
        sessionId: access.sessionId,
        sequence: current.revision + i + 1,
        commandId,
        actor,
        timestamp: new Date().toISOString(),
        data,
      }));
      const existing = this.events(access);
      const next = project([...existing, ...events]);
      for (const event of events)
        this.db
          .prepare("INSERT INTO events VALUES (?,?,?)")
          .run(access.sessionId, event.sequence, JSON.stringify(event));
      this.db
        .prepare("UPDATE sessions SET snapshot=? WHERE id=?")
        .run(JSON.stringify(next), access.sessionId);
      this.db
        .prepare("INSERT INTO commands VALUES (?,?,?,?)")
        .run(access.sessionId, commandId, digest, JSON.stringify(next));
      return next;
    });
  }
  questions(access: SessionAccess) {
    return questionQueue(this.read(access));
  }
  export(access: SessionAccess) {
    return exportSpec(this.read(access));
  }
  async *subscribe(
    access: SessionAccess,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<GrillEvent> {
    this.authenticate(access);
    let cursor = after;
    while (!signal?.aborted) {
      for (const event of this.events(access, cursor)) {
        cursor = event.sequence;
        yield event;
      }
      try {
        await setTimeout(100, undefined, signal ? { signal } : {});
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }
    }
  }
  recover(access: SessionAccess): Session {
    // An explicit reconnect cancels orphaned work; it never reissues paid calls.
    for (const work of Object.values(this.read(access).work))
      if (work.status === "running")
        this.execute(access, { type: "failWork", workId: work.id }, "system");
    return this.read(access);
  }
}
