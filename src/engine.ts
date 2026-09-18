import { createHash } from "node:crypto";
import {
  type Actor,
  type Command,
  type Decision,
  type EventData,
  type Session,
  ensure,
} from "./domain.js";

export function questionValue(d: Decision): number {
  // Ordinal scheduling heuristic, deliberately not a calibrated probability.
  return (d.impact * 2 + d.divergence + d.effort + (d.reversible ? 0 : 10)) / d.attentionCost;
}
export function applicable(s: Session, d: Decision): boolean {
  return (
    d.dependencies.every((id) => s.decisions[id]?.committed) &&
    Object.entries(d.when).every(([id, option]) => s.decisions[id]?.selection?.optionId === option)
  );
}
export function questionQueue(s: Session) {
  const value = (d: Decision) =>
    questionValue(d) *
    (s.assessments[d.id]?.revision === d.revision ? 0.5 + s.assessments[d.id]!.materiality : 1);
  return Object.values(s.decisions)
    .filter((d) => d.question === "queued" && applicable(s, d))
    .sort(
      (a, b) =>
        Number(b.authority === "approval_required") - Number(a.authority === "approval_required") ||
        value(b) - value(a) ||
        a.id.localeCompare(b.id),
    )
    .map((d) => ({
      id: d.id,
      revision: d.revision,
      prompt: d.prompt,
      options: d.options,
      authority: d.authority,
      value: value(d),
      whyNow: d.reason,
      mayDefer: true,
      mayDelegate: d.authority === "user_preference" && d.reversible,
      mayAnswerOther: true,
    }));
}
export function transition(original: Session, command: Command, actor: Actor): EventData[] {
  const s = structuredClone(original);
  const events: EventData[] = [];
  const emit = (event: EventData) => {
    events.push(structuredClone(event));
    if ("decision" in event) s.decisions[event.decision.id] = event.decision;
    if ("hypothesis" in event) s.hypotheses[event.hypothesis.id] = event.hypothesis;
    if ("work" in event) s.work[event.work.id] = event.work;
    if ("evidence" in event) s.evidence[event.evidence.id] = event.evidence;
  };
  const get = (id: string) => {
    const d = s.decisions[id];
    ensure(d, "NOT_FOUND", "Decision not found");
    return d;
  };
  const human = () => ensure(actor === "human", "AUTHORITY", "Explicit human action required");
  const option = (d: Decision, id: string) =>
    ensure(
      d.options.some((o) => o.id === id),
      "OPTION",
      "Unknown option",
    );
  const update = (type: Extract<EventData, { decision: Decision }>["type"], d: Decision) =>
    emit({ type, decision: { ...d, revision: d.revision + 1 } });
  const propose = (input: Extract<Command, { type: "propose" }>["decision"]) => {
    ensure(!s.decisions[input.id], "DUPLICATE", "Decision ID already exists");
    ensure(
      new Set(input.options.map((o) => o.id)).size === input.options.length,
      "OPTION",
      "Option IDs must be unique",
    );
    ensure(
      new Set(input.dependencies).size === input.dependencies.length,
      "DEPENDENCY",
      "Duplicate dependency",
    );
    for (const id of input.dependencies)
      ensure(s.decisions[id], "DEPENDENCY", "Dependency must already exist; cycles are forbidden");
    for (const [id, value] of Object.entries(input.when)) {
      ensure(input.dependencies.includes(id), "DEPENDENCY", "Condition must be a dependency");
      option(get(id), value);
    }
    const authority =
      actor !== "human" && input.authority === "agent_discretion"
        ? "user_preference"
        : input.authority;
    emit({
      type: "DecisionProposed",
      decision: {
        ...input,
        authority,
        revision: 1,
        selection: null,
        committed: false,
        delegated: actor === "human" && authority === "agent_discretion",
        question: "candidate",
        reason: "",
      },
    });
  };
  const invalidateDescendants = (root: string) => {
    const affected = new Set([root]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of Object.values(s.decisions))
        if (!affected.has(d.id) && d.dependencies.some((id) => affected.has(id))) {
          affected.add(d.id);
          changed = true;
        }
    }
    for (const id of affected) {
      const d = get(id);
      update("DecisionReopened", {
        ...d,
        selection: null,
        committed: false,
        question: "candidate",
        reason: "Decision or prerequisite reopened",
      });
    }
    for (const e of Object.values(s.evidence))
      if (e.premises.some((id) => affected.has(id)))
        emit({ type: "EvidenceInvalidated", evidence: { ...e, valid: false } });
    for (const h of Object.values(s.hypotheses))
      if (Object.keys(h.assignments).some((id) => affected.has(id))) {
        emit({
          type: "HypothesisChanged",
          hypothesis: { ...h, status: "pruned", reason: "Premise reopened" },
        });
      }
    // Start a new canonical frontier; historical worlds remain inspectable.
    const assignments = Object.fromEntries(
      Object.values(s.decisions)
        .filter((d) => d.committed && d.selection)
        .map((d) => [d.id, d.selection!.optionId]),
    );
    const id = `reopened_${s.revision}`;
    emit({
      type: "HypothesisChanged",
      hypothesis: {
        id,
        assignments,
        status: "active",
        reason: "Reopened frontier",
        mergedInto: null,
        parents: [],
      },
    });
  };
  const reconcile = () => {
    for (const h of Object.values(s.hypotheses))
      if (["active", "suspended", "merged"].includes(h.status)) {
        const conflicts = Object.entries(h.assignments).some(([id, value]) => {
          const d = s.decisions[id];
          return d?.selection && d.selection.optionId !== value;
        });
        if (conflicts)
          emit({
            type: "HypothesisChanged",
            hypothesis: { ...h, status: "pruned", reason: "Conflicts with resolved decision" },
          });
      }
    for (const h of Object.values(s.hypotheses)) {
      if (
        h.status === "merged" &&
        h.mergedInto &&
        s.hypotheses[h.mergedInto]?.status === "pruned"
      ) {
        emit({
          type: "HypothesisChanged",
          hypothesis: {
            ...h,
            status: "active",
            mergedInto: null,
            convergenceDecision: null,
            reason: "Surviving alternative promoted after reconciliation",
          },
        });
      }
    }
    if (!Object.values(s.hypotheses).some((h) => h.status === "active")) {
      const assignments = Object.fromEntries(
        Object.values(s.decisions)
          .filter((d) => d.selection)
          .map((d) => [d.id, d.selection!.optionId]),
      );
      const id = `resolved_${s.revision}`;
      emit({
        type: "HypothesisChanged",
        hypothesis: {
          id,
          assignments,
          status: "active",
          reason: "Resolved frontier",
          mergedInto: null,
          parents: [],
        },
      });
    }
    for (const d of Object.values(s.decisions))
      if (!d.selection && d.question !== "deferred") {
        const contradicted = Object.entries(d.when).some(
          ([id, value]) =>
            s.decisions[id]?.committed && s.decisions[id]?.selection?.optionId !== value,
        );
        if (contradicted && d.question !== "withdrawn")
          update("QuestionChanged", {
            ...d,
            question: "withdrawn",
            reason: "Parent choice made this question irrelevant",
          });
        else if (
          command.type === "schedule" &&
          !contradicted &&
          applicable(s, d) &&
          !["external_fact", "derivable"].includes(d.authority) &&
          !d.delegated &&
          !["queued", "withdrawn"].includes(d.question)
        ) {
          update("QuestionChanged", {
            ...d,
            question: "queued",
            reason: `A human-owned choice affects design (impact ${d.impact}/10; divergence ${d.divergence}/10)`,
          });
        }
      }
  };
  switch (command.type) {
    case "assess": {
      ensure(
        actor === "system",
        "AUTHORITY",
        "Assessments require the configured judgment provider",
      );
      ensure(
        get(command.assessment.decisionId).revision === command.assessment.revision,
        "STALE",
        "Assessment targets a stale decision",
      );
      emit({ type: "AssessmentRecorded", assessment: command.assessment });
      break;
    }
    case "propose":
      propose(command.decision);
      break;
    case "evidence": {
      ensure(!s.evidence[command.evidence.id], "DUPLICATE", "Evidence ID already exists");
      for (const [id, value] of Object.entries(command.evidence.supports)) option(get(id), value);
      const premises = [
        ...new Set([
          ...command.evidence.premises,
          ...Object.keys(command.evidence.supports).flatMap((id) => get(id).dependencies),
        ]),
      ];
      for (const id of premises)
        ensure(get(id).committed, "PREMISE", "Evidence premises must be committed");
      emit({ type: "EvidenceAdded", evidence: { ...command.evidence, premises, valid: true } });
      break;
    }
    case "context":
    case "steer": {
      if (command.type === "steer") human();
      // New context invalidates a model-supported convergence claim, never a human decision.
      for (const d of Object.values(s.decisions))
        if (d.reason.startsWith("Converged recorded outcomes")) {
          update("QuestionChanged", {
            ...d,
            question: "candidate",
            reason: "New context requires reconsidering convergence",
          });
        }
      let active = Object.values(s.hypotheses).filter(
        (h) => h.status === "active" && !h.convergenceDecision,
      ).length;
      for (const h of Object.values(s.hypotheses))
        if (h.convergenceDecision && ["active", "merged"].includes(h.status)) {
          emit({
            type: "HypothesisChanged",
            hypothesis: {
              ...h,
              status: active++ < s.budget.maxHypotheses ? "active" : "suspended",
              mergedInto: null,
              convergenceDecision: null,
              reason: "Convergence invalidated by new context",
            },
          });
        }
      emit({
        type: command.type === "steer" ? "SessionSteered" : "ContextAdded",
        context: command.text,
        epoch: s.epoch + 1,
      });
      break;
    }
    case "answer": {
      human();
      const d = get(command.decisionId);
      ensure(
        d.revision === command.revision,
        "STALE",
        "Question has changed; refresh it before answering",
      );
      ensure(
        !d.committed && !d.selection && applicable(s, d) && d.question !== "withdrawn",
        "STATE",
        "Decision is not answerable",
      );
      ensure(
        Boolean(command.optionId) !== Boolean(command.other),
        "ANSWER",
        "Provide exactly one option or free-text answer",
      );
      let selected = command.optionId;
      if (command.other) {
        selected = `other_${createHash("sha256").update(command.other).digest("hex").slice(0, 16)}`;
        d.options.push({ id: selected, label: command.other });
      }
      ensure(selected, "ANSWER", "Missing answer");
      option(d, selected);
      update("DecisionAnswered", {
        ...d,
        selection: { optionId: selected, basis: "explicit", evidenceIds: [] },
        question: "answered",
        reason: "Explicit human answer",
      });
      break;
    }
    case "resolve": {
      const d = get(command.decisionId);
      option(d, command.optionId);
      ensure(
        !d.selection && !d.committed && ["external_fact", "derivable"].includes(d.authority),
        "AUTHORITY",
        "Evidence cannot decide a user preference",
      );
      ensure(applicable(s, d), "DEPENDENCY", "Prerequisites must be committed");
      for (const id of command.evidenceIds) {
        const e = s.evidence[id];
        ensure(
          e?.valid && e.supports[d.id] === command.optionId,
          "EVIDENCE",
          "Evidence must explicitly support the choice",
        );
      }
      ensure(
        !Object.values(s.evidence).some(
          (e) => e.valid && e.supports[d.id] && e.supports[d.id] !== command.optionId,
        ),
        "CONFLICT",
        "Conflicting evidence requires investigation",
      );
      update("DecisionResolved", {
        ...d,
        selection: {
          optionId: command.optionId,
          basis: d.authority === "external_fact" ? "verified_fact" : "derived",
          evidenceIds: command.evidenceIds,
        },
        question: "answered",
        reason: "Resolved from recorded evidence",
      });
      break;
    }
    case "delegate": {
      human();
      const d = get(command.decisionId);
      if (command.revision !== undefined)
        ensure(d.revision === command.revision, "STALE", "Question changed");
      ensure(
        d.authority === "user_preference" && !d.selection && d.reversible,
        "AUTHORITY",
        "This decision cannot be delegated",
      );
      update("DecisionDelegated", {
        ...d,
        delegated: true,
        question: "candidate",
        reason: "Explicit delegation for this decision",
      });
      break;
    }
    case "choose": {
      const d = get(command.decisionId);
      option(d, command.optionId);
      ensure(
        d.delegated && !d.selection && d.reversible && applicable(s, d),
        "AUTHORITY",
        "Recorded delegation and resolved prerequisites required",
      );
      update("DecisionResolved", {
        ...d,
        selection: { optionId: command.optionId, basis: "delegated", evidenceIds: [] },
        question: "answered",
        reason: "Selected under explicit delegation",
      });
      break;
    }
    case "commit": {
      const d = get(command.decisionId);
      ensure(
        d.selection && !d.committed && applicable(s, d),
        "COMMIT",
        "Only resolved decisions with committed prerequisites are eligible",
      );
      ensure(
        d.authority !== "approval_required" || d.selection.basis === "explicit",
        "AUTHORITY",
        "Explicit approval required",
      );
      ensure(
        d.selection.evidenceIds.every((id) => s.evidence[id]?.valid),
        "EVIDENCE",
        "Supporting evidence is stale",
      );
      update("DecisionCommitted", { ...d, committed: true });
      break;
    }
    case "reopen":
      human();
      invalidateDescendants(command.decisionId);
      break;
    case "defer": {
      human();
      const d = get(command.decisionId);
      ensure(!d.selection && !d.committed, "STATE", "Resolved decision cannot be deferred");
      if (command.revision !== undefined)
        ensure(d.revision === command.revision, "STALE", "Question changed");
      update("QuestionChanged", {
        ...d,
        question: "deferred",
        reason: "Deferred by the human; no answer assumed",
      });
      break;
    }
    case "schedule":
      break;
    case "fork": {
      const h = s.hypotheses[command.hypothesisId];
      const d = get(command.decisionId);
      ensure(
        h?.status === "active" && !h.convergenceDecision && !h.assignments[d.id] && !d.selection,
        "STATE",
        "Only unresolved alternatives can be forked",
      );
      ensure(
        d.dependencies.every((id) => h.assignments[id] || s.decisions[id]?.committed),
        "DEPENDENCY",
        "Hypothesis lacks prerequisite assignments",
      );
      ensure(
        Object.entries(d.when).every(
          ([id, value]) => (h.assignments[id] ?? s.decisions[id]?.selection?.optionId) === value,
        ),
        "DEPENDENCY",
        "Decision is outside this hypothesis",
      );
      const active = Object.values(s.hypotheses).filter((x) => x.status === "active").length - 1;
      emit({
        type: "HypothesisChanged",
        hypothesis: { ...h, status: "expanded", reason: "Replaced by alternative worlds" },
      });
      for (const [i, o] of d.options.entries()) {
        const id = `h_${createHash("sha256").update(`${h.id}:${d.id}:${o.id}`).digest("hex").slice(0, 24)}`;
        ensure(!s.hypotheses[id], "DUPLICATE", "Hypothesis already explored");
        emit({
          type: "HypothesisChanged",
          hypothesis: {
            id,
            assignments: { ...h.assignments, [d.id]: o.id },
            status: active + i < s.budget.maxHypotheses ? "active" : "suspended",
            reason:
              active + i < s.budget.maxHypotheses
                ? "Speculative alternative"
                : "Compute budget; not disproved",
            mergedInto: null,
            parents: [h.id],
          },
        });
      }
      break;
    }
    case "converge": {
      ensure(actor === "system", "AUTHORITY", "Convergence is an internal policy operation");
      if (!s.policy.semanticConvergence) break;
      for (const d of Object.values(s.decisions)) {
        const assessment = s.assessments[d.id];
        if (
          d.selection ||
          d.question === "withdrawn" ||
          d.authority !== "user_preference" ||
          !d.reversible ||
          d.impact > s.policy.convergenceMaxImpact ||
          !applicable(s, d) ||
          !assessment ||
          assessment.revision !== d.revision ||
          assessment.materiality > s.policy.convergenceMaxMateriality
        )
          continue;
        if (
          Object.values(s.decisions).some(
            (child) => child.dependencies.includes(d.id) && child.question !== "withdrawn",
          )
        )
          continue;
        const worlds = Object.values(s.hypotheses).filter((h) => h.status === "active");
        if (
          worlds.length < 2 ||
          worlds.some(
            (h) =>
              !h.assignments[d.id] ||
              h.convergenceDecision ||
              Object.keys(h.assignments).some((id) => id !== d.id && !s.decisions[id]?.committed),
          )
        )
          continue;
        if (
          Object.values(s.hypotheses).some((h) => h.status === "suspended" && h.assignments[d.id])
        )
          continue;
        const options = new Set(worlds.map((h) => h.assignments[d.id]));
        if (!d.options.every((option) => options.has(option.id))) continue;
        const results = worlds.map((h) =>
          Object.values(s.work)
            .filter((w) => w.hypothesisId === h.id && w.kind === "reasoning")
            .at(-1),
        );
        if (
          results.some(
            (w) =>
              w?.status !== "completed" ||
              !w.exhausted ||
              !w.observableEffects.length ||
              w.provider === "unspecified" ||
              w.epoch !== s.epoch ||
              w.dependencies[d.id] !== d.revision,
          )
        )
          continue;
        const signatures = results.map((w) =>
          JSON.stringify([...new Set(w!.observableEffects.map((item) => item.trim()))].sort()),
        );
        if (!signatures.every((signature) => signature === signatures[0])) continue;
        const target = worlds[0]!;
        for (const h of worlds)
          emit({
            type: "HypothesisChanged",
            hypothesis: {
              ...h,
              status: h.id === target.id ? "active" : "merged",
              mergedInto: h.id === target.id ? null : target.id,
              convergenceDecision: d.id,
              reason: "Converged recorded outcomes; all alternatives preserved",
            },
          });
        update("QuestionChanged", {
          ...d,
          question: "withdrawn",
          reason: `Converged recorded outcomes under opt-in policy; judgment ${assessment.model}; no user answer inferred`,
        });
      }
      break;
    }
    case "merge": {
      const seen = new Map<string, string>();
      for (const h of Object.values(s.hypotheses).filter((h) => h.status === "active")) {
        // Once a choice is committed, its matching assignment is common context.
        // Other unresolved obligations remain part of the exact equivalence key.
        const key = JSON.stringify(
          Object.entries(h.assignments)
            .filter(([id]) => !s.decisions[id]?.committed)
            .sort(([a], [b]) => a.localeCompare(b)),
        );
        const target = seen.get(key);
        if (target)
          emit({
            type: "HypothesisChanged",
            hypothesis: {
              ...h,
              status: "merged",
              mergedInto: target,
              reason: "Exact assignment equivalence; provenance preserved",
            },
          });
        else seen.set(key, h.id);
      }
      break;
    }
    case "pause":
    case "resume": {
      emit({
        type: "ExplorationChanged",
        state: command.type === "pause" ? "paused" : "ready",
        epoch: s.epoch + 1,
      });
      if (command.type === "pause")
        for (const work of Object.values(s.work))
          if (work.status === "running")
            emit({
              type: "WorkChanged",
              work: { ...work, status: "cancelled", summary: "Exploration paused" },
            });
      break;
    }
    case "startWork": {
      ensure(!s.work[command.workId], "DUPLICATE", "Work ID already exists");
      ensure(s.state !== "paused", "PAUSED", "Exploration is paused");
      const h = s.hypotheses[command.hypothesisId];
      ensure(h?.status === "active", "STATE", "Hypothesis is not active");
      ensure(
        !h.convergenceDecision,
        "STATE",
        "Converged leaf must be reopened before further expansion",
      );
      ensure(
        Object.values(s.work).filter((w) => w.status === "running").length < s.budget.maxConcurrent,
        "BUDGET",
        "Concurrency budget exhausted",
      );
      ensure(
        s.calls < s.budget.maxCalls &&
          s.tokensReserved + command.reserveTokens <= s.budget.maxTokens,
        "BUDGET",
        "Provider budget exhausted",
      );
      emit({
        type: "BudgetReserved",
        calls: s.calls + 1,
        tokensReserved: s.tokensReserved + command.reserveTokens,
      });
      emit({
        type: "WorkChanged",
        work: {
          id: command.workId,
          kind: command.kind,
          hypothesisId: h.id,
          epoch: s.epoch,
          dependencies: Object.fromEntries(
            Object.values(s.decisions).map((d) => [d.id, d.revision]),
          ),
          status: "running",
          summary: "",
          reservedTokens: command.reserveTokens,
          observableEffects: [],
          exhausted: false,
          provider: "unspecified",
        },
      });
      emit({ type: "ExplorationChanged", state: "exploring", epoch: s.epoch });
      break;
    }
    case "completeWork":
    case "failWork": {
      const work = s.work[command.workId];
      ensure(work, "NOT_FOUND", "Work not found");
      if (work.status !== "running") break;
      const stale =
        work.epoch !== s.epoch ||
        s.hypotheses[work.hypothesisId]?.status !== "active" ||
        Object.entries(work.dependencies).some(
          ([id, revision]) => s.decisions[id]?.revision !== revision,
        );
      const status = stale ? "stale" : command.type === "failWork" ? "failed" : "completed";
      if (command.type === "completeWork" && !stale) {
        const h = s.hypotheses[work.hypothesisId]!;
        const scopedIds = new Map(
          command.decisions.map((input) => [
            input.id,
            Object.keys(h.assignments).length
              ? `${input.id.slice(0, 70)}_${createHash("sha256").update(h.id).digest("hex").slice(0, 12)}`
              : input.id,
          ]),
        );
        for (const input of command.decisions) {
          // Every branch-local proposal carries all assumptions that produced it.
          const candidate = {
            ...input,
            id: scopedIds.get(input.id)!,
            dependencies: [
              ...new Set([
                ...input.dependencies.map((id) => scopedIds.get(id) ?? id),
                ...Object.keys(h.assignments),
              ]),
            ],
            when: {
              ...Object.fromEntries(
                Object.entries(input.when).map(([id, value]) => [scopedIds.get(id) ?? id, value]),
              ),
              ...h.assignments,
            },
          };
          const existing = s.decisions[candidate.id];
          if (existing) {
            const {
              revision: _revision,
              selection: _selection,
              committed: _committed,
              delegated: _delegated,
              question: _question,
              reason: _reason,
              ...definition
            } = existing;
            ensure(
              JSON.stringify(definition) === JSON.stringify(candidate),
              "DUPLICATE",
              "Conflicting proposal for an existing decision",
            );
          } else propose(candidate);
        }
      }
      emit({
        type: "WorkChanged",
        work: {
          ...work,
          status,
          observableEffects:
            command.type === "completeWork" && !stale ? command.observableEffects : [],
          exhausted:
            command.type === "completeWork" &&
            !stale &&
            command.decisions.length === 0 &&
            command.exhausted,
          provider: command.type === "completeWork" ? command.provider : work.provider,
          summary:
            command.type === "completeWork" && !stale
              ? command.summary
              : "Provider result unavailable or no longer applicable",
        },
      });
      emit({
        type: "ExplorationChanged",
        state: Object.values(s.work).some((w) => w.status === "running") ? "exploring" : "waiting",
        epoch: s.epoch,
      });
      break;
    }
  }
  reconcile();
  return events;
}

export function exportSpec(s: Session): string {
  const lines = [`# Committed specification`, "", `Revision: ${s.revision}`, ""];
  for (const d of Object.values(s.decisions))
    if (d.committed && d.selection) {
      const label = d.options.find((o) => o.id === d.selection!.optionId)!.label;
      lines.push(
        `## ${d.prompt.replace(/[\r\n]/g, " ")}`,
        "",
        label,
        "",
        `Basis: ${d.selection.basis}.`,
        "",
      );
    }
  return lines.join("\n");
}
