const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
let current,
  selected,
  view = "decision",
  detailKey = "",
  queueKey = "",
  reviewKey = "",
  busy = false,
  zoom = 1,
  feedbackTimer;
const drafts = new Map();
const label = (s, id, option) =>
  s.decisions[id]?.options.find((o) => o.id === option)?.label ?? option;
function notify(message) {
  clearTimeout(feedbackTimer);
  $("#feedback").textContent = message;
  feedbackTimer = setTimeout(() => ($("#feedback").textContent = ""), 3500);
}
function error(message) {
  $("#error").hidden = !message;
  $("#error").textContent = message;
}
async function request(path, value) {
  const r = await fetch(
    path,
    value === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function act(value) {
  if (busy) return;
  busy = true;
  error("");
  try {
    const data = await request("/api/action", value);
    if (value.id) drafts.delete(value.id);
    if (value.type === "answer") {
      selected = data.questions[0]?.id ?? value.id;
      notify(
        value.response.action === "defer"
          ? "Moved to Later"
          : value.response.action === "delegate"
            ? "Delegated"
            : "Answer saved",
      );
    } else if (value.type === "reopen") {
      selected = value.id;
      notify("Reopened");
    }
    render(data);
    return true;
  } catch (e) {
    error(e.message);
    try {
      render(await request("/api/state"));
    } catch {}
    return false;
  } finally {
    busy = false;
  }
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
function uniqueEffects(s, d, option) {
  const other = new Set(
    d.options
      .filter((o) => o.id !== option)
      .flatMap((o) => effects(s, d.id, o.id).map((e) => e.text)),
  );
  return effects(s, d.id, option).filter((e) => !other.has(e.text));
}
function stateLabel(d) {
  return d.committed
    ? "Decided"
    : d.question === "deferred"
      ? "Later"
      : d.delegated
        ? "Delegated"
        : d.question === "withdrawn"
          ? "Not needed"
          : current.questions.some((q) => q.id === d.id)
            ? "To decide"
            : "Waiting";
}
function rows(s) {
  const ds = Object.values(s.decisions),
    queued = current.questions.map((q) => s.decisions[q.id]);
  const groups = [
    ["To decide", queued],
    ["Waiting", ds.filter((d) => stateLabel(d) === "Waiting")],
    ["Later", ds.filter((d) => d.question === "deferred")],
    ["Decided", ds.filter((d) => d.committed)],
    ["Delegated", ds.filter((d) => d.delegated && !d.committed)],
    ["Not needed", ds.filter((d) => d.question === "withdrawn" && !d.committed)],
  ];
  return (
    groups
      .filter(([, list]) => list.length)
      .map(
        ([name, list]) =>
          `<div class="group-title">${name}<span>${list.length}</span></div>${list.map((d) => `<button class="queue-row" data-select="${esc(d.id)}" aria-current="${d.id === selected}" aria-label="${esc(d.prompt)} — ${name}"><span class="ordinal ${d.committed ? "done" : ""}">${d.committed ? "✓" : String(ds.indexOf(d) + 1).padStart(2, "0")}</span><span>${esc(d.prompt)}${d.selection ? `<small>${esc(label(s, d.id, d.selection.optionId))}</small>` : d.dependencies.length ? "<small>Depends on another decision</small>" : ""}</span></button>`).join("")}`,
      )
      .join("") || '<p class="group-title">No decisions yet</p>'
  );
}
function sources(s, d) {
  const findings = d.options.flatMap((o) =>
    effects(s, d.id, o.id).map(
      (e) =>
        `<li><strong>${esc(o.label)}</strong><br>${esc(e.text)} <code>· ${esc(e.workId.slice(0, 8))}</code></li>`,
    ),
  );
  const evidence = Object.values(s.evidence)
    .filter((e) => e.valid && d.id in e.supports)
    .map((e) => `<li>${esc(e.summary)}<br>${esc(e.source)}</li>`);
  return `<details class="sources" data-keep="sources"><summary>Evidence & reasoning</summary><p>${esc(d.reason)}</p>${findings.length || evidence.length ? `<ul>${[...findings, ...evidence].join("")}</ul>` : "<p>No evidence recorded.</p>"}</details>`;
}
function decision(s) {
  const d = s.decisions[selected];
  if (!d)
    return `<p class="empty">${current.running ? "Exploring your brief…" : "No decisions to review."}</p>`;
  const q = current.questions.find((q) => q.id === d.id),
    draft = drafts.get(d.id) || "";
  const ds = Object.values(s.decisions),
    next = ds.filter((x) => x.dependencies.includes(d.id));
  let body = "";
  if (d.committed)
    body = `<p class="committed">${esc(label(s, d.id, d.selection.optionId))}</p><button class="choose" data-reopen="${esc(d.id)}">Change answer</button>`;
  else if (d.question === "deferred")
    body = `<p class="waiting">Set aside for later.</p><button class="choose" data-reopen="${esc(d.id)}">Return to queue</button>`;
  else if (q)
    body = `<div class="comparison">${d.options
      .map((o, i) => {
        const findings = uniqueEffects(s, d, o.id);
        return `<section class="alternative"><p class="option-letter">${String.fromCharCode(65 + i)}</p><h3>${esc(o.label)}</h3><p class="finding ${findings.length ? "" : "missing"}">${esc(findings[0]?.text ?? (current.running ? "Comparing this option…" : "Not explored yet."))}</p><button class="choose" data-option="${esc(o.id)}" aria-label="Choose ${esc(o.label)}">Choose ${String.fromCharCode(65 + i)} <span aria-hidden="true">↗</span></button></section>`;
      })
      .join(
        "",
      )}</div><div class="question-footer"><details class="other" data-keep="other" ${draft ? "open" : ""}><summary>Write another answer</summary><form id="other-form"><label for="other-text" class="sr-only">Your answer</label><textarea id="other-text" name="other" rows="3" maxlength="20000" placeholder="Your answer" required>${esc(draft)}</textarea><button class="primary">Save answer</button></form></details><button data-action="defer">Later</button>${q.mayDelegate ? '<button data-action="delegate">Delegate</button>' : ""}</div>`;
  else if (d.delegated)
    body = '<p class="waiting">Delegated. The agent has not selected an option yet.</p>';
  else if (d.question === "withdrawn")
    body = `<p class="waiting">${esc(d.reason)}</p><button class="choose" data-reopen="${esc(d.id)}">Reopen</button>`;
  else
    body = `<div class="waiting">${d.dependencies.map((id) => `<p>First: <button data-select="${esc(id)}">${esc(s.decisions[id]?.prompt ?? id)}</button></p>`).join("") || "<p>This decision is not ready for an answer.</p>"}${Object.entries(
      d.when,
    )
      .map(([id, o]) => `<p>Only if you choose “${esc(label(s, id, o))}”.</p>`)
      .join("")}</div>`;
  return `<div data-id="${esc(d.id)}"><div class="decision-top"><span class="eyebrow">${String(ds.indexOf(d) + 1).padStart(2, "0")} / ${String(ds.length).padStart(2, "0")} · ${stateLabel(d)}</span><div class="decision-actions"><button id="previous" aria-label="Previous decision">←</button><button id="next" aria-label="Next decision">→</button></div></div><h2 class="question-title">${esc(d.prompt)}</h2>${next.length ? `<p class="impact">Affects: ${next.map((x) => esc(x.prompt)).join(" ")}</p>` : ""}${body}${sources(s, d)}</div>`;
}
function wrap(text, limit = 28) {
  const lines = [];
  let line = "";
  const words = text.split(/\s+/).flatMap((word) => {
    const chunks = [];
    for (let i = 0; i < word.length; i += limit) chunks.push(word.slice(i, i + limit));
    return chunks;
  });
  for (const word of words) {
    if ((line + " " + word).length > limit && line) {
      lines.push(line);
      line = word;
    } else line += (line ? " " : "") + word;
  }
  if (line) lines.push(line);
  return lines;
}
function graph(s) {
  const ds = Object.values(s.decisions);
  if (!ds.length) return '<p class="empty">No decisions yet.</p>';
  const depths = new Map();
  const depth = (d) => {
    if (depths.has(d.id)) return depths.get(d.id);
    depths.set(d.id, 0);
    const n = d.dependencies.length
      ? 1 + Math.max(...d.dependencies.map((id) => (s.decisions[id] ? depth(s.decisions[id]) : 0)))
      : 0;
    depths.set(d.id, n);
    return n;
  };
  ds.forEach(depth);
  const groups = new Map();
  ds.forEach((d) => {
    const n = depths.get(d.id);
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(d);
  });
  const positions = new Map();
  for (const [level, list] of groups)
    list.forEach((d, i) => positions.set(d.id, { x: 36 + level * 450, y: 40 + i * 180 }));
  const width = 320 + Math.max(...depths.values()) * 450,
    height = Math.max(440, Math.max(...[...groups.values()].map((l) => l.length)) * 180 + 50);
  const edges = ds
    .flatMap((d) =>
      d.dependencies.map((id) => {
        const p = positions.get(id),
          c = positions.get(d.id);
        if (!p) return "";
        const x = p.x + 250,
          y = p.y + 60,
          cx = c.x,
          cy = c.y + 60,
          mid = (x + cx) / 2;
        const condition = d.when[id] ? label(s, id, d.when[id]) : "requires";
        const allLines = wrap(condition, 23),
          lines = allLines.slice(0, 2);
        return `<g><title>${esc(condition)}</title><path class="edge" marker-end="url(#arrow)" d="M${x},${y} C${mid},${y} ${mid},${cy} ${cx},${cy}"/>${lines.map((line, i) => `<text class="edge-label" x="${mid}" y="${(y + cy) / 2 - 12 + (i - lines.length + 1) * 14}" text-anchor="middle">${esc(line)}${i === 1 && allLines.length > 2 ? "…" : ""}</text>`).join("")}</g>`;
      }),
    )
    .join("");
  const nodes = ds
    .map((d) => {
      const p = positions.get(d.id),
        lines = wrap(d.prompt, 30);
      const status = d.committed
        ? "committed"
        : current.questions.some((q) => q.id === d.id)
          ? "queued"
          : "waiting";
      return `<g class="node" role="button" tabindex="0" data-select="${esc(d.id)}" data-status="${status}" aria-label="${esc(d.prompt)} — ${stateLabel(d)}" transform="translate(${p.x},${p.y})"><title>${esc(d.prompt)}</title><rect width="250" height="120" rx="3"/><text class="node-status" x="16" y="23">${stateLabel(d)}</text><text x="16" y="48">${lines
        .slice(0, 3)
        .map(
          (line, i) =>
            `<tspan x="16" dy="${i ? 18 : 0}">${esc(line)}${i === 2 && lines.length > 3 ? "…" : ""}</tspan>`,
        )
        .join("")}</text></g>`;
    })
    .join("");
  return `<div class="graph-toolbar"><h2>Decision graph</h2><button data-zoom="out" aria-label="Zoom out">−</button><button data-zoom="in" aria-label="Zoom in">+</button><button data-zoom="fit">Fit</button></div><div class="graph-scroll"><svg xmlns="http://www.w3.org/2000/svg" width="${width * zoom}" height="${height * zoom}" viewBox="0 0 ${width} ${height}" aria-label="Decision dependencies" role="group" data-width="${width}" data-height="${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a19d8b"/></marker></defs>${edges}${nodes}</svg></div><div class="graph-legend"><span class="open">To decide</span><span class="answered">Decided</span><span>Waiting</span></div><p class="graph-help">Select a decision to inspect it. Arrows show dependencies.</p>`;
}
function specification(s) {
  const ds = Object.values(s.decisions).filter((d) => d.committed);
  return `<h2 class="question-title">Specification</h2>${ds.length ? ds.map((d) => `<div class="spec-row"><h3>${esc(d.prompt)}</h3><p>${esc(label(s, d.id, d.selection.optionId))}</p></div>`).join("") : '<p class="empty">No answers saved yet.</p>'}`;
}
function render(data) {
  current = data;
  const s = data.state,
    ds = Object.values(s.decisions);
  selected ??= data.questions[0]?.id ?? ds[0]?.id;
  $("#mode").textContent = data.demo ? "Example" : "";
  $("#mode").hidden = !data.demo;
  $("#brief-text").textContent = s.brief;
  $("#brief-open").textContent = data.demo ? "Shared notebook" : s.brief;
  $("#brief-open").title = s.brief;
  $("#context").innerHTML = s.context.map((c) => `<p>${esc(c)}</p>`).join("");
  $("#provider-note").textContent = data.demo
    ? "Synthetic example. No model calls."
    : "Exploration sends this brief, relevant decisions and evidence to your configured providers.";
  $("#total").textContent = `${ds.filter((d) => d.committed).length} / ${ds.length}`;
  $("#explore").textContent = data.running ? "Pause" : s.state === "paused" ? "Resume" : "Explore";
  $("#explore").disabled = !data.canExplore;
  $("#explore").title = data.canExplore
    ? "Explore alternatives within the session budget"
    : "No reasoning provider configured";
  $("#activity-count").textContent = data.running ? "●" : Object.keys(s.work).length || "";
  if (data.workerError) error(data.workerError);
  $("#activity").innerHTML =
    `<p class="muted">${s.calls} / ${s.budget.maxCalls} calls${data.demo ? " (simulated)" : ""} · ${s.tokensReserved.toLocaleString()} tokens reserved</p>` +
    Object.values(s.work)
      .reverse()
      .map(
        (w) =>
          `<div class="activity-row"><span>${esc(w.status)}</span><p>${esc(w.summary || w.failureCode || "Exploring…")}</p></div>`,
      )
      .join("");
  const qk = JSON.stringify([ds, data.questions, selected]);
  if (qk !== queueKey) {
    queueKey = qk;
    $("#queue-list").innerHTML = rows(s);
  }
  const rk = JSON.stringify(data.reviews || []);
  if (rk !== reviewKey) {
    reviewKey = rk;
    $("#reviews").innerHTML = (data.reviews || [])
      .map(
        (r) =>
          `<section class="review"><h2>Check this interpretation</h2><p>${esc(r.sourceText)}</p>${r.answers.map((a) => `<p>${esc(s.decisions[a.decisionId]?.prompt)} → <strong>${esc(a.other || label(s, a.decisionId, a.optionId))}</strong></p>`).join("")}<button data-review="${esc(r.id)}" data-accept="true">Accept answers</button><button data-review="${esc(r.id)}" data-accept="false">Dismiss</button></section>`,
      )
      .join("");
  }
  const key = JSON.stringify([
    view,
    selected,
    ds,
    data.questions,
    Object.values(s.work).map((w) => [w.id, w.status]),
  ]);
  if (key === detailKey) return;
  detailKey = key;
  const focused = document.activeElement?.id,
    selectionStart = document.activeElement?.selectionStart,
    selectionEnd = document.activeElement?.selectionEnd;
  const open = [...document.querySelectorAll("details[open][data-keep]")].map(
    (e) => e.dataset.keep,
  );
  const previousId = $("#detail [data-id]")?.dataset.id;
  const scroll = $(".graph-scroll"),
    scrollLeft = scroll?.scrollLeft,
    scrollTop = scroll?.scrollTop;
  $("#detail").innerHTML =
    view === "graph" ? graph(s) : view === "spec" ? specification(s) : decision(s);
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false"));
  if (previousId === selected) {
    for (const name of open) {
      const el = $(`[data-keep="${name}"]`);
      if (el) el.open = true;
    }
    if (focused) {
      const el = document.getElementById(focused);
      if (el) {
        el.focus({ preventScroll: true });
        if (typeof selectionStart === "number" && el.setSelectionRange)
          el.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
  if (view === "graph" && scrollLeft !== undefined) {
    $(".graph-scroll").scrollLeft = scrollLeft;
    $(".graph-scroll").scrollTop = scrollTop;
  } else if (view === "graph") {
    const svg = $(".graph-scroll svg");
    if (svg) {
      zoom =
        $(".graph-scroll").clientWidth < 500
          ? 1
          : Math.min(1, $(".graph-scroll").clientWidth / Number(svg.dataset.width));
      svg.setAttribute("width", Number(svg.dataset.width) * zoom);
      svg.setAttribute("height", Number(svg.dataset.height) * zoom);
    }
  }
}
function select(id) {
  selected = id;
  view = "decision";
  render(current);
}
document.addEventListener("input", (e) => {
  if (e.target.id === "other-text") drafts.set(selected, e.target.value);
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "other-form") return;
  e.preventDefault();
  const d = current.state.decisions[selected],
    answer = $("#other-text").value.trim();
  if (answer)
    void act({
      type: "answer",
      id: d.id,
      revision: d.revision,
      response: { action: "other", answer },
    });
});
document.addEventListener("keydown", (e) => {
  const node = e.target.closest(".node");
  if (node && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    select(node.dataset.select);
  }
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("button,[data-select]");
  if (!b) return;
  if (b.dataset.select) {
    select(b.dataset.select);
    return;
  }
  if (b.dataset.view) {
    view = b.dataset.view;
    render(current);
    return;
  }
  if (b.dataset.option) {
    const d = current.state.decisions[selected];
    void act({
      type: "answer",
      id: d.id,
      revision: d.revision,
      response: { action: "answer", answer: b.dataset.option },
    });
    return;
  }
  if (b.dataset.action) {
    const d = current.state.decisions[selected];
    void act({
      type: "answer",
      id: d.id,
      revision: d.revision,
      response: { action: b.dataset.action },
    });
    return;
  }
  if (b.dataset.reopen) {
    const d = current.state.decisions[b.dataset.reopen];
    void act({ type: "reopen", id: d.id, revision: d.revision });
    return;
  }
  if (b.dataset.review) {
    void act({ type: "review", id: b.dataset.review, accept: b.dataset.accept === "true" });
    return;
  }
  if (b.hasAttribute("data-close")) {
    b.closest("dialog").close();
    return;
  }
  if (b.dataset.zoom) {
    const svg = $(".graph-scroll svg");
    zoom =
      b.dataset.zoom === "fit"
        ? $(".graph-scroll").clientWidth / Number(svg.dataset.width)
        : Math.max(0.3, Math.min(2.5, zoom + (b.dataset.zoom === "in" ? 0.2 : -0.2)));
    svg.setAttribute("width", Number(svg.dataset.width) * zoom);
    svg.setAttribute("height", Number(svg.dataset.height) * zoom);
    return;
  }
  if (b.id === "next" || b.id === "previous") {
    const ds = Object.values(current.state.decisions),
      i = ds.findIndex((d) => d.id === selected);
    select(ds[(i + (b.id === "next" ? 1 : -1) + ds.length) % ds.length].id);
  }
});
$("#explore").onclick = () => void act({ type: current.running ? "pause" : "explore" });
$("#activity-open").onclick = () => $("#activity-dialog").showModal();
$("#brief-open").onclick = () => $("#brief-dialog").showModal();
$("#steer-open").onclick = () => $("#steer-dialog").showModal();
$("#mode").onclick = () => $("#brief-dialog").showModal();
$("#constraint-brief").onclick = () => {
  $("#brief-dialog").close();
  $("#steer-dialog").showModal();
};
$("#steer-form").onsubmit = async (e) => {
  e.preventDefault();
  if (await act({ type: "steer", text: $("#steer-text").value.trim() })) {
    $("#steer-text").value = "";
    $("#steer-dialog").close();
    notify("Constraint saved");
  }
};
$("#export").onclick = () => {
  if (!current) return;
  const url = URL.createObjectURL(new Blob([current.specification], { type: "text/markdown" })),
    a = document.createElement("a");
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
    };
    events.onerror = () => error("Connection lost. Reconnecting…");
    events.onopen = () => error("");
  } catch (e) {
    error(e.message);
  }
})();
let graphPan;
document.addEventListener("pointerdown", (e) => {
  const surface = e.target.closest(".graph-scroll");
  if (!surface || e.target.closest(".node") || e.button !== 0 || e.pointerType === "touch") return;
  graphPan = {
    surface,
    x: e.clientX,
    y: e.clientY,
    left: surface.scrollLeft,
    top: surface.scrollTop,
  };
  surface.setPointerCapture(e.pointerId);
});
document.addEventListener("pointermove", (e) => {
  if (!graphPan) return;
  graphPan.surface.scrollLeft = graphPan.left - (e.clientX - graphPan.x);
  graphPan.surface.scrollTop = graphPan.top - (e.clientY - graphPan.y);
});
document.addEventListener("pointerup", () => {
  graphPan = undefined;
});
document.addEventListener("pointercancel", () => {
  graphPan = undefined;
});
