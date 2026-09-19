/* No framework state owns decisions: every accepted action goes through the shared service. */
const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
let current,
  view = "questions",
  renderedKey = "",
  busy = false;
const drafts = new Map();
const views = {
  questions: ["Needs you", "Answer in any order. Independent work can continue while you decide."],
  deferred: ["Deferred", "Set aside for now. No answer has been assumed."],
  resolved: ["Decisions", "Recorded choices and questions that no longer need your attention."],
  graph: [
    "Decision graph",
    "Dependencies and branch conditions. Speculation stays separate from committed choices.",
  ],
  spec: ["Specification", "Only committed decisions appear in this export."],
};
function error(message) {
  $("#error").hidden = !message;
  $("#error").textContent = message;
}
async function request(path, value) {
  const response = await fetch(
    path,
    value === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
async function act(value) {
  if (busy) return;
  busy = true;
  error("");
  try {
    const data = await request("/api/action", value);
    if (value.id) drafts.delete(value.id);
    render(data);
  } catch (e) {
    error(e.message);
    try {
      render(await request("/api/state"));
    } catch {}
  } finally {
    busy = false;
  }
}
function label(s, id, option) {
  return s.decisions[id]?.options.find((o) => o.id === option)?.label ?? option;
}
function branchLabel(s, h) {
  return (
    Object.entries(h.assignments)
      .map(([id, option]) => label(s, id, option))
      .join(" · ") || "Common ground"
  );
}
function effects(s, id, option) {
  return Object.values(s.work)
    .filter(
      (w) =>
        w.status === "completed" &&
        w.epoch === s.epoch &&
        w.kind === "reasoning" &&
        s.hypotheses[w.hypothesisId]?.reason !== "Premise reopened" &&
        s.hypotheses[w.hypothesisId]?.assignments[id] === option,
    )
    .flatMap((w) => w.observableEffects.map((text) => ({ text, workId: w.id })))
    .filter((v, i, a) => a.findIndex((x) => x.text === v.text) === i);
}
function question(d, q, s, index) {
  const draft = drafts.get(d.id) ?? { option: "", other: "" };
  const dependent = Object.values(s.decisions).filter((x) => x.dependencies.includes(d.id));
  return `<article class="question" data-id="${escape(d.id)}"><div class="question-head"><span>QUESTION ${String(index + 1).padStart(2, "0")} · ${d.authority === "approval_required" ? "Approval required" : d.authority === "user_required" ? "Your decision" : "Your preference"}</span><strong>${dependent.length ? `${dependent.length} dependent decision${dependent.length > 1 ? "s" : ""}` : "Independent choice"}</strong></div><h3>${escape(d.prompt)}</h3><p class="why">${escape(q.whyNow || d.reason)}</p><form data-question="${escape(d.id)}"><fieldset class="options"><legend class="sr-only">${escape(d.prompt)}</legend>${d.options
    .map((o) => {
      const consequences = effects(s, d.id, o.id);
      const otherFindings = new Set(
        d.options
          .filter((x) => x.id !== o.id)
          .flatMap((x) => effects(s, d.id, x.id).map((e) => e.text)),
      );
      const distinctive = consequences.filter((e) => !otherFindings.has(e.text));
      return `<label class="option"><input type="radio" name="choice" value="${escape(o.id)}" ${draft.option === o.id ? "checked" : ""}><span><strong>${escape(o.label)}</strong><span class="consequence">${escape(distinctive.length ? "Branch finding: " + distinctive[0].text : consequences.length ? "Recorded findings overlap with other options. Inspect the evidence below." : "Consequences have not been recorded for this option yet.")}</span></span></label>`;
    })
    .join(
      "",
    )}</fieldset><label class="other-label">Or give your own answer<textarea name="other" rows="2" placeholder="Describe what you want instead…" maxlength="20000">${escape(draft.other)}</textarea></label><div class="actions"><button class="primary" type="submit">Use this answer</button><button class="quiet" type="button" data-action="defer">Decide later</button>${q.mayDelegate ? '<button class="quiet" type="button" data-action="delegate">Let the agent decide</button>' : ""}</div></form><details><summary>Why this question · evidence and consequences</summary><div class="evidence"><p>${escape(d.reason)}</p><p>${dependent.length ? `Unlocks: ${dependent.map((x) => escape(x.prompt)).join("; ")}` : "No dependent decisions recorded yet."}</p>${d.options
    .map(
      (o) =>
        `<p><strong>${escape(o.label)}</strong></p>${
          effects(s, d.id, o.id)
            .map(
              (e) =>
                `<p>${escape(e.text)} <small>Source: branch work ${escape(e.workId.slice(0, 8))}</small></p>`,
            )
            .join("") || "<p>No completed branch analysis recorded.</p>"
        }`,
    )
    .join("")}${Object.values(s.evidence)
    .filter((e) => e.valid && d.id in e.supports)
    .map((e) => `<p>${escape(e.summary)} — ${escape(e.source)}</p>`)
    .join(
      "",
    )}<p>No recommendation has been recorded. An explored option is not an approved choice.</p></div></details></article>`;
}
function render(data) {
  current = data;
  const s = data.state,
    decisions = Object.values(s.decisions),
    deferred = decisions.filter((d) => d.question === "deferred"),
    resolved = decisions.filter((d) => d.committed || d.question === "withdrawn");
  $("#mode").textContent = data.demo ? "Interactive example" : "Private local session";
  $("#notice").textContent = data.demo
    ? "Synthetic example · no API calls. Your choices update the real decision graph; branch analysis is scripted."
    : "Private session · exploration sends the brief, relevant decisions and evidence to configured providers. Keys stay on the server.";
  $("#brief-text").textContent = s.brief;
  $("#question-count").textContent = data.questions.length;
  $("#deferred-count").textContent = deferred.length;
  $("#resolved-count").textContent = resolved.length;
  $("#activity-state").textContent = data.running
    ? "Working"
    : s.state === "paused"
      ? "Paused"
      : s.state === "budget_exhausted"
        ? "Budget reached"
        : "Ready";
  $("#worker-description").textContent =
    data.workerError ||
    (data.demo
      ? "Explore both deletion policies before deciding. You can answer while the example worker runs."
      : data.canExplore
        ? "Explore plausible answers within this session’s budget. You can keep answering while work runs."
        : "No background model configured. A connected agent can add decisions and analysis to this workspace.");
  $("#explore").textContent = data.running
    ? "Pause exploration"
    : s.state === "paused"
      ? "Resume exploration"
      : "Explore alternatives";
  $("#explore").disabled = !data.canExplore;
  $("#budget").textContent =
    `${s.calls} / ${s.budget.maxCalls} ${data.demo ? "simulated " : ""}calls · ${s.tokensReserved.toLocaleString()} / ${s.budget.maxTokens.toLocaleString()} tokens reserved`;
  $("#branches").innerHTML = Object.values(s.hypotheses)
    .filter((h) => h.status !== "expanded")
    .map(
      (h) =>
        `<div class="branch ${escape(h.status)}"><span class="status">${escape(h.status)}</span><p>${escape(branchLabel(s, h))}</p>${h.status === "pruned" || h.status === "suspended" ? `<p class="small">${escape(h.reason)}</p>` : ""}</div>`,
    )
    .join("");
  $("#work").innerHTML =
    Object.values(s.work)
      .reverse()
      .slice(0, 6)
      .map(
        (w) =>
          `<div class="work-item"><small>${escape(w.status)} · ${escape(w.kind)}</small><p>${escape(w.summary || (w.status === "running" ? "Comparing consequences…" : w.failureCode || "No result recorded"))}</p></div>`,
      )
      .join("") ||
    '<p class="small">No analysis yet. Start exploration to compare the alternatives.</p>';
  $("#context").innerHTML =
    s.context.map((c) => `<p>${escape(c)}</p>`).join("") || "<p>No additional direction.</p>";
  // Work events must not replace a form while someone is typing or navigating it.
  const key = JSON.stringify([
    view,
    decisions,
    data.questions,
    Object.values(s.work)
      .filter((w) => w.status === "completed")
      .map((w) => w.id),
  ]);
  $("#reviews").innerHTML = (data.reviews || [])
    .map(
      (r) =>
        `<article class="question"><h3>Review your answer</h3><p>${escape(r.sourceText)}</p>${r.answers.map((a) => `<p>${escape(s.decisions[a.decisionId]?.prompt)} → <strong>${escape(a.other || label(s, a.decisionId, a.optionId))}</strong></p>`).join("")}<p class="small">Accepting commits every choice above. Check the interpretation first.</p><div class="actions"><button data-review="${escape(r.id)}" data-accept="true">Accept these interpretations</button><button data-review="${escape(r.id)}" data-accept="false">Dismiss proposal</button></div></article>`,
    )
    .join("");
  if (key !== renderedKey) {
    const focused = document.activeElement?.closest("[data-id]")?.dataset.id;
    const field = document.activeElement?.getAttribute("name");
    const focusedValue = document.activeElement?.value;
    const selection = document.activeElement?.selectionStart;
    const expanded = [...document.querySelectorAll(".question details[open]")].map(
      (el) => el.closest("[data-id]").dataset.id,
    );
    renderedKey = key;
    $("#view-title").textContent = views[view][0];
    $("#view-description").textContent = views[view][1];
    if (view === "questions")
      $("#items").innerHTML =
        data.questions.map((q, i) => question(s.decisions[q.id], q, s, i)).join("") ||
        `<div class="empty"><h2>${data.running ? "Exploration is still running" : "Nothing needs your input right now"}</h2><p>${deferred.length ? `${deferred.length} decision(s) are deferred. You can return to them at any time.` : "An empty queue does not mean the design is complete. Inspect the graph or continue exploration."}</p></div>`;
    else if (view === "deferred")
      $("#items").innerHTML =
        deferred
          .map(
            (d) =>
              `<article class="record"><h3>${escape(d.prompt)}</h3><p>${escape(d.reason)}</p><button data-reopen="${escape(d.id)}">Bring back to queue</button></article>`,
          )
          .join("") || '<p class="empty">No questions set aside.</p>';
    else if (view === "resolved")
      $("#items").innerHTML =
        resolved
          .map(
            (d) =>
              `<article class="record"><span class="small">${d.committed ? "Committed" : "No answer assumed"}</span><h3>${escape(d.prompt)}</h3><p class="selected">${d.selection ? escape(label(s, d.id, d.selection.optionId)) : "Question no longer needed"}</p><p>${escape(d.reason)}</p><button data-reopen="${escape(d.id)}">Reopen decision</button></article>`,
          )
          .join("") ||
        '<p class="empty">Your accepted answers will appear here. Hypotheses are not decisions.</p>';
    else if (view === "graph")
      $("#items").innerHTML =
        decisions
          .map(
            (d) =>
              `<article class="graph-node"><code>${escape(d.id)}</code> <span class="small">· ${d.committed ? "committed" : escape(d.question)}</span><h3>${escape(d.prompt)}</h3><div class="edge">${d.dependencies.length ? "↳ Depends on: " + d.dependencies.map((id) => escape(s.decisions[id]?.prompt ?? id)).join("; ") : "Independent decision"}</div>${Object.entries(
                d.when,
              )
                .map(
                  ([id, option]) =>
                    `<div class="edge">Only when: ${escape(label(s, id, option))}</div>`,
                )
                .join(
                  "",
                )}${d.selection ? `<p>${escape(label(s, d.id, d.selection.optionId))}</p>` : ""}</article>`,
          )
          .join("") || '<p class="empty">No decisions recorded yet.</p>';
    else $("#items").innerHTML = `<pre>${escape(data.specification)}</pre>`;
    for (const id of expanded) {
      const el = [...document.querySelectorAll("[data-id]")].find((e) => e.dataset.id === id);
      if (el) el.querySelector("details").open = true;
    }
    if (focused && field) {
      const form = [...document.querySelectorAll("[data-question]")].find(
        (e) => e.dataset.question === focused,
      );
      const el =
        field === "choice"
          ? [...(form?.querySelectorAll("input") || [])].find((i) => i.value === focusedValue)
          : form?.elements.namedItem(field);
      if (el instanceof HTMLElement) {
        el.focus({ preventScroll: true });
        if (typeof selection === "number" && el.setSelectionRange)
          el.setSelectionRange(selection, selection);
      }
    }
  }
}
document.addEventListener("input", (e) => {
  const form = e.target.closest("[data-question]");
  if (!form) return;
  const values = new FormData(form);
  let option = String(values.get("choice") || ""),
    other = String(values.get("other") || "");
  if (e.target.name === "other" && other.trim()) {
    form.querySelectorAll("input").forEach((i) => (i.checked = false));
    option = "";
  }
  if (e.target.name === "choice") {
    form.elements.other.value = "";
    other = "";
  }
  drafts.set(form.dataset.question, { option, other });
});
document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-question]");
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.question,
    d = current.state.decisions[id],
    draft = drafts.get(id);
  if (!draft?.option && !draft?.other.trim()) {
    error("Choose an option or write your own answer first.");
    return;
  }
  void act({
    type: "answer",
    id,
    revision: d.revision,
    response: {
      action: draft.other.trim() ? "other" : "answer",
      answer: draft.other.trim() || draft.option,
    },
  });
});
document.addEventListener("click", (e) => {
  const review = e.target.closest("[data-review]");
  if (review) {
    void act({
      type: "review",
      id: review.dataset.review,
      accept: review.dataset.accept === "true",
    });
    return;
  }
  const nav = e.target.closest("[data-view]");
  if (nav) {
    view = nav.dataset.view;
    document
      .querySelectorAll("[data-view]")
      .forEach((n) => n.setAttribute("aria-current", n === nav ? "page" : "false"));
    render(current);
    return;
  }
  const reopen = e.target.closest("[data-reopen]");
  if (reopen) {
    const id = reopen.dataset.reopen;
    void act({ type: "reopen", id, revision: current.state.decisions[id].revision });
    return;
  }
  const button = e.target.closest("[data-action]");
  if (button) {
    const id = button.closest("[data-id]").dataset.id;
    void act({
      type: "answer",
      id,
      revision: current.state.decisions[id].revision,
      response: { action: button.dataset.action },
    });
  }
});
$("#explore").onclick = () => void act({ type: current.running ? "pause" : "explore" });
$("#steer-open").onclick = () => $("#steer-dialog").showModal();
$("#steer-close").onclick = () => $("#steer-dialog").close();
$("#steer-form").onsubmit = async (e) => {
  e.preventDefault();
  await act({ type: "steer", text: $("#steer-text").value.trim() });
  if (!$("#error").textContent) {
    $("#steer-text").value = "";
    $("#steer-dialog").close();
  }
};
$("#export").onclick = () => {
  if (!current) return;
  const url = URL.createObjectURL(new Blob([current.specification], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "specification.md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
(async () => {
  try {
    const token = location.hash.slice(1);
    history.replaceState(null, "", location.pathname);
    if (token) await request("/api/connect", { token });
    render(await request("/api/state"));
    const events = new EventSource("/api/events");
    events.onmessage = (e) => {
      render(JSON.parse(e.data));
      $("#connection").textContent = "Connected locally";
    };
    events.onerror = () => {
      $("#connection").textContent = "Reconnecting…";
    };
  } catch (e) {
    error(e.message);
    $("#connection").textContent = "Not connected";
  }
})();
