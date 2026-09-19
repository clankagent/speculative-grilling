import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  humanResponse,
  safeError,
  answerReviewSchema,
  answerReviewPreview,
  acceptAnswerReview,
} from "../application.js";
import { ensure } from "../domain.js";
import { applicable } from "../engine.js";
import type { GrillService, SessionAccess } from "../storage.js";
import type { ExplorationRunner } from "../runner.js";

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("answer"),
    id: z.string(),
    revision: z.number().int(),
    response: z.unknown(),
  }),
  z.object({ type: z.literal("reopen"), id: z.string(), revision: z.number().int() }),
  z.object({ type: z.literal("steer"), text: z.string().min(1).max(20000) }),
  z.object({ type: z.enum(["explore", "pause"]) }),
  z.object({ type: z.literal("review"), id: z.string(), accept: z.boolean() }),
]);
async function body(req: IncomingMessage) {
  let value = "";
  for await (const part of req) {
    value += part.toString();
    ensure(Buffer.byteLength(value) <= 100000, "SIZE", "Request too large");
  }
  return JSON.parse(value);
}
const equals = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** One session, one loopback origin. The browser receives projections, never provider credentials. */
export async function startWorkspace(
  service: GrillService,
  access: SessionAccess,
  options: { runner?: ExplorationRunner; demo?: boolean; port?: number } = {},
) {
  service.read(access);
  const token = randomBytes(32).toString("hex");
  const cookieName = `grill_${randomBytes(8).toString("hex")}`;
  let origin = "";
  let workerError = "";
  let explorationEnabled = false;
  const reviews = new Map<string, z.infer<typeof answerReviewSchema>>();
  const continueWork = () => {
    if (!explorationEnabled || !options.runner || service.read(access).state === "paused") return;
    workerError = "";
    void options.runner.start(access).catch(() => {
      workerError = "Exploration stopped. Check recorded work before trying again.";
    });
  };
  const snapshot = () => {
    const state = service.read(access);
    return {
      state,
      questions: service.questions(access),
      reviews: [...reviews].map(([id, review]) => ({ id, ...review })),
      applicableIds: Object.values(state.decisions)
        .filter((d) => applicable(state, d))
        .map((d) => d.id),
      demo: !!options.demo,
      canExplore: !!options.runner,
      running: options.runner?.isRunning(access.sessionId) ?? false,
      workerError,
      specification: service.export(access),
    };
  };
  const assets: Record<string, [string, string]> = {
    "/": ["index.html", "text/html"],
    "/app.js": ["app.js", "text/javascript"],
    "/style.css": ["style.css", "text/css"],
  };
  const streams = new Set<import("node:http").ServerResponse>();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      ensure(req.headers.host === new URL(origin).host, "ORIGIN", "Unrecognized host");
      ensure(
        !req.headers.origin || req.headers.origin === origin,
        "ORIGIN",
        "Cross-origin request rejected",
      );
      ensure(
        !req.headers["sec-fetch-site"] ||
          ["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])),
        "ORIGIN",
        "Cross-site request rejected",
      );
      const path = new URL(req.url ?? "/", origin).pathname;
      if (req.method === "GET" && assets[path]) {
        const [file, type] = assets[path];
        res.setHeader("Content-Type", `${type}; charset=utf-8`);
        res.end(readFileSync(new URL(`./public/${file}`, import.meta.url)));
        return;
      }
      if (req.method === "POST")
        ensure(req.headers["content-type"] === "application/json", "TYPE", "JSON required");
      if (path === "/api/connect" && req.method === "POST") {
        const input = z.object({ token: z.string().max(128) }).parse(await body(req));
        ensure(
          equals(input.token, token),
          "AUTH",
          "Open the workspace link supplied by the local launcher",
        );
        res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.end("{}");
        return;
      }
      const cookie =
        req.headers.cookie
          ?.split("; ")
          .find((c) => c.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1) ?? "";
      ensure(
        equals(cookie, token),
        "AUTH",
        "Open the workspace link supplied by the local launcher",
      );
      if (path === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        streams.add(res);
        let previous = "";
        const send = () => {
          try {
            const next = JSON.stringify(snapshot());
            if (next !== previous) {
              res.write(`data: ${next}\n\n`);
              previous = next;
            }
          } catch {
            res.end();
          }
        };
        send();
        const timer = setInterval(send, 350);
        res.on("close", () => {
          clearInterval(timer);
          streams.delete(res);
        });
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (path === "/api/state" && req.method === "GET") {
        res.end(JSON.stringify(snapshot()));
        return;
      }
      if (path === "/api/action" && req.method === "POST") {
        const action = actionSchema.parse(await body(req));
        if (action.type === "review") {
          const review = reviews.get(action.id);
          ensure(review, "REVIEW", "This review is no longer pending");
          if (action.accept) acceptAnswerReview(service, access, review);
          reviews.delete(action.id);
          if (action.accept) continueWork();
        } else if (action.type === "answer") {
          humanResponse(service, access, action.id, action.revision, action.response);
          continueWork();
        } else if (action.type === "reopen") {
          ensure(
            service.read(access).decisions[action.id]?.revision === action.revision,
            "STALE",
            "Decision changed. Review the current version before reopening.",
          );
          service.execute(access, { type: "reopen", decisionId: action.id }, "human");
          service.execute(access, { type: "schedule" }, "system");
          continueWork();
        } else if (action.type === "steer") {
          service.execute(access, { type: "steer", text: action.text }, "human");
          continueWork();
        } else if (action.type === "pause") {
          explorationEnabled = false;
          if (options.runner) await options.runner.stop(access);
          else service.execute(access, { type: "pause" }, "human");
        } else {
          ensure(
            options.runner,
            "PROVIDER",
            "No reasoning provider is configured for this session",
          );
          explorationEnabled = true;
          service.execute(access, { type: "resume" }, "human");
          continueWork();
        }
        res.end(JSON.stringify(snapshot()));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: safeError(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Listener unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/#${token}`,
    origin,
    queueReview: (input: unknown) => {
      const review = answerReviewSchema.parse(input);
      answerReviewPreview(service, access, review);
      const id = randomBytes(12).toString("hex");
      reviews.set(id, review);
      return id;
    },
    close: async () => {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export type Workspace = Awaited<ReturnType<typeof startWorkspace>>;
