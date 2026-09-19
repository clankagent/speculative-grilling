import { setTimeout as delay } from "node:timers/promises";
import type { ReasoningProvider } from "../providers.js";
import type { GrillService } from "../storage.js";

export function startExample(service: GrillService) {
  const access = service.start(
    "Design a shared notebook for a small team. People can collect notes, recover mistakes and work without an internet connection.",
    { maxCalls: 60, maxTokens: 60000, maxHypotheses: 4 },
  );
  service.execute(access, {
    type: "propose",
    decision: {
      id: "retention",
      prompt: "What should happen when someone deletes a note?",
      authority: "user_required",
      options: [
        { id: "recover", label: "Keep it recoverable for 30 days" },
        { id: "erase", label: "Remove it immediately" },
      ],
      impact: 9,
      divergence: 9,
      reversible: false,
    },
  });
  service.execute(access, {
    type: "propose",
    decision: {
      id: "offline",
      prompt: "Can people edit their notes while offline?",
      authority: "user_preference",
      options: [
        { id: "edit", label: "Read and edit offline" },
        { id: "read", label: "Read offline; edit when connected" },
      ],
      impact: 7,
      divergence: 8,
    },
  });
  service.execute(access, {
    type: "propose",
    decision: {
      id: "restore",
      prompt: "Who can restore a deleted note?",
      authority: "user_required",
      options: [
        { id: "author", label: "Only the original author" },
        { id: "team", label: "Anyone on the team" },
      ],
      dependencies: ["retention"],
      when: { retention: "recover" },
      impact: 7,
    },
  });
  service.execute(access, { type: "fork", hypothesisId: "root", decisionId: "retention" });
  service.execute(access, { type: "schedule" }, "system");
  return access;
}

export function exampleProvider(milliseconds = 4500): ReasoningProvider {
  return {
    name: "Synthetic example · no model calls",
    reserveTokens: () => 100,
    async expand(state, hypothesisId, signal) {
      await delay(milliseconds, undefined, { signal });
      const assignments = state.hypotheses[hypothesisId]!.assignments;
      const retention =
        assignments["retention"] ?? state.decisions["retention"]?.selection?.optionId;
      const offline = assignments["offline"] ?? state.decisions["offline"]?.selection?.optionId;
      const effects = [
        retention === "recover"
          ? "A deleted note remains restorable for 30 days. The design needs a trash view, a restore action and a scheduled purge."
          : retention === "erase"
            ? "Deletion cannot be undone. The design needs a clear confirmation before permanent removal; no trash view is needed."
            : "A custom retention policy needs fresh analysis; the example does not invent its consequences.",
      ];
      if (offline)
        effects.push(
          offline === "edit"
            ? "Offline edits need a local change queue and conflict handling when teammates edit the same note."
            : offline === "read"
              ? "A local read cache is enough. Editing waits for a connection, avoiding offline merge conflicts."
              : "The custom offline behavior needs fresh analysis beyond this example.",
        );
      return {
        summary: effects.join(" "),
        decisions: [],
        observableEffects: effects,
        exhausted: true,
      };
    },
  };
}
