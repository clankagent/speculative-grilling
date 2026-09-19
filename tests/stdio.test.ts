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
    expect(
      message.result.tools.some((tool: { name: string }) => tool.name === "grill_workspace"),
    ).toBe(true);
    const call = async (id: number, name: string, args: unknown) => {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name,
            arguments: args,
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
      await expect
        .poll(() => output.some((line) => JSON.parse(line).id === id), { timeout: 10000 })
        .toBe(true);
      const response = JSON.parse(output.find((line) => JSON.parse(line).id === id)!);
      expect(response.error).toBeUndefined();
      return JSON.parse(response.result.content[0].text);
    };
    const started = await call(2, "grill_start", { brief: "Synthetic notebook" });
    const workspace = await call(3, "grill_workspace", { access: started });
    const questions = await call(4, "grill_questions", { access: started });
    expect(questions.workspaceUrl).toBe(workspace.workspaceUrl);
    const url = new URL(workspace.workspaceUrl);
    const connected = await fetch(`${url.origin}/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: url.hash.slice(1) }),
    });
    expect(connected.status).toBe(200);
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
