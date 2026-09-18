import { expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

test("standalone stdio process speaks MCP and closes cleanly without provider credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grill-stdio-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/adapters/mcp-main.ts"], {
    env: {
      ...process.env,
      GRILL_DATABASE: join(directory, "session.sqlite"),
      GRILL_REASONING_PROVIDER: "",
      GRILL_REASONING_MODEL: "",
      GRILL_REASONING_API_KEY: "",
      TYPESAFE_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const output: string[] = [];
  lines.on("line", (line) => output.push(line));
  // Drain stderr without publishing local paths or environment details in assertions.
  child.stderr.resume();
  const exited = once(child, "exit");
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "synthetic-stdio-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }) + "\n",
    );
    await expect.poll(() => output.length, { timeout: 10000 }).toBeGreaterThan(0);
    const message = JSON.parse(output[0]!);
    expect(message.error).toBeUndefined();
    expect(message.result.tools.some((tool: { name: string }) => tool.name === "grill_start")).toBe(
      true,
    );
    child.stdin.end();
    const [code] = await exited;
    expect(code).toBe(0);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
    lines.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
