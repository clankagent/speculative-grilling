#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { GrillService, type SessionAccess } from "./storage.js";
import { configuredProviders } from "./providers.js";
import { ExplorationRunner } from "./runner.js";
import { humanResponse, safeError, status } from "./application.js";

const [command = "help", ...args] = process.argv.slice(2);
const help = `grill start <name> <brief>  Create and select a named private session
grill use <name>            Select an existing session
grill explore              Run bounded reasoning and optional Jev judgments
grill ask                  Answer queued questions interactively
grill status | graph       Inspect the selected session
grill export               Write committed Markdown to stdout
grill steer <text>         Supply new context
grill reopen <decision>    Reopen a decision and its dependents
grill pause | resume       Control exploration state
grill forget               Delete the selected session after confirmation
grill help                 Show this help

Runtime data uses the private database, never the source checkout.
Only explore makes provider calls. Provider configuration is supplied by environment.`;
let service: GrillService | undefined;
let runner: ExplorationRunner | undefined;
let input: ReturnType<typeof createInterface> | undefined;
try {
  if (command === "help") console.log(help);
  else {
    service = new GrillService(process.env["GRILL_DATABASE"]);
    const s = service;
    let access = s.getPrivate<SessionAccess>("cli:current");
    if (command === "start" || command === "use") {
      const name = args.shift();
      if (!name || !/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error("Invalid session name");
      const existing = s.getPrivate<SessionAccess>(`cli:${name}`);
      if (command === "start") {
        if (existing) throw new Error("Name already exists");
        access = s.start(args.join(" "));
        s.putPrivate(`cli:${name}`, access);
      } else {
        if (!existing) throw new Error("Unknown session name");
        s.read(existing);
        access = existing;
      }
      s.putPrivate("cli:current", access);
      console.log(JSON.stringify(status(s.read(access!)), null, 2));
    } else {
      if (!access) throw new Error("No selected session");
      const a = access;
      if (command === "explore") {
        const providers = configuredProviders();
        if (!providers.reasoning) throw new Error("Provider configuration required");
        runner = new ExplorationRunner(s, providers.reasoning, providers.judgment);
        await runner.start(a);
        console.log(JSON.stringify(status(s.read(a)), null, 2));
      } else if (command === "ask") {
        input = createInterface({ input: stdin, output: stdout });
        s.execute(a, { type: "schedule" }, "system");
        for (let q = s.questions(a)[0]; q; q = s.questions(a)[0]) {
          console.log(`\n${q.prompt}\n${q.whyNow}`);
          q.options.forEach((o, i) => console.log(`${i + 1}. ${o.label}`));
          const reply = (await input.question("Number, other, defer, delegate, or quit: ")).trim();
          if (!reply || reply === "quit") break;
          if (reply === "other") {
            const answer = await input.question("Your answer: ");
            if (answer.trim()) humanResponse(s, a, q.id, q.revision, { action: "other", answer });
          } else if (reply === "defer" || (reply === "delegate" && q.mayDelegate))
            humanResponse(s, a, q.id, q.revision, { action: reply });
          else {
            const option = q.options[Number(reply) - 1];
            if (!option) {
              console.log("Choose one of the listed actions.");
              continue;
            }
            humanResponse(s, a, q.id, q.revision, { action: "answer", answer: option.id });
          }
        }
        console.log(JSON.stringify(status(s.read(a)), null, 2));
      } else if (command === "export") console.log(s.export(a));
      else if (command === "graph") console.log(JSON.stringify(s.read(a), null, 2));
      else if (command === "status") console.log(JSON.stringify(status(s.read(a)), null, 2));
      else if (command === "steer") s.execute(a, { type: "steer", text: args.join(" ") }, "human");
      else if (command === "reopen") s.execute(a, { type: "reopen", decisionId: args[0] }, "human");
      else if (command === "pause" || command === "resume")
        s.execute(a, { type: command }, "human");
      else if (command === "forget") {
        input = createInterface({ input: stdin, output: stdout });
        if (
          (await input.question("Delete this session and its history? Type delete: ")) === "delete"
        ) {
          s.deleteSession(a);
          console.log("Session deleted.");
        }
      } else throw new Error("Unknown command");
    }
  }
} catch (error) {
  console.error(safeError(error));
  console.error("Run grill help for usage. Check the selected session and provider configuration.");
  process.exitCode = 1;
} finally {
  input?.close();
  await runner?.close();
  service?.close();
}
