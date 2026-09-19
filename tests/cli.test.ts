import { expect, test } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GrillService, type SessionAccess } from "../src/storage.js";

test("standalone CLI persists a named session, accepts an answer, exports and deletes it", () => {
  const directory = mkdtempSync(join(tmpdir(), "grill-cli-"));
  const database = join(directory, "sessions.sqlite");
  const command = (args: string[], input = "") =>
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        GRILL_DATABASE: database,
        GRILL_REASONING_API_KEY: "",
        TYPESAFE_API_KEY: "",
      },
    });
  try {
    expect(JSON.parse(command(["start", "fixture", "Synthetic notebook"])).committedDecisions).toBe(
      0,
    );
    let s = new GrillService(database);
    const access = s.getPrivate<SessionAccess>("cli:fixture")!;
    s.execute(access, {
      type: "propose",
      decision: {
        id: "sharing",
        prompt: "Public links?",
        authority: "user_required",
        options: [
          { id: "no", label: "Private only" },
          { id: "yes", label: "Public" },
        ],
      },
    });
    s.close();
    command(["ask"], "1\n");
    expect(command(["export"])).toContain("Private only");
    expect(JSON.parse(command(["status"])).committedDecisions).toBe(1);
    command(["forget"], "delete\n");
    s = new GrillService(database);
    try {
      expect(s.getPrivate("cli:fixture")).toBeUndefined();
      expect(s.getPrivate("cli:current")).toBeUndefined();
    } finally {
      s.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
