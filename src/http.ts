// HTTP surfaces: the unauthenticated served Experts page (`http.request.before`)
// and the authenticated app-UI endpoints (`http.request.authed`, served under
// the logged-in user's authority). Mirrors `http.rs`.

import { htmlResponse, jsonResponse } from "./verdict";
import { listExperts } from "./experts";
import {
  PmDecision,
  pmIsActive,
  pmDecisionJson,
  pmListDecisions,
  pmGetDecision,
  pmPutDecision,
  pmIssueGrant,
  pmExpertId,
} from "./pm";
import { resumeSession, nowMs, genId } from "./host";
import { errMsg } from "./lib";

// ── HTTP: the served Experts page ─────────────────────────────────────

/// Serve the Experts page (self-contained placeholder so the sidebar resolves).
export function serveHttp(payload: any): string {
  const method =
    payload && typeof payload.method === "string" ? payload.method : "";
  const path = payload && typeof payload.path === "string" ? payload.path : "";
  if (method.toUpperCase() === "GET" && path === "/plugin-api/v1/experts") {
    return htmlResponse(200, EXPERTS_PAGE);
  }
  return htmlResponse(
    404,
    "<!doctype html><title>Not found</title><p>Not found.</p>",
  );
}

const EXPERTS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Experts</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --fg: #1f2328;
    --muted: #57606a;
    --border: #d0d7de;
    --bg: #ffffff;
    --bg-subtle: #f6f8fa;
    --accent: #0969da;
    --danger: #cf222e;
    --radius: 8px;
  }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0;
    padding: 1.5rem;
    color: var(--fg);
    background: var(--bg);
  }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
  h3 {
    font-size: .85rem;
    text-transform: uppercase;
    letter-spacing: .04em;
    color: var(--muted);
    margin: 1.25rem 0 .5rem;
    display: flex;
    align-items: center;
    gap: .5rem;
  }
  .count {
    font-size: .75rem;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 .5rem;
    color: var(--muted);
    text-transform: none;
    letter-spacing: 0;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    padding: .75rem .9rem;
    margin-bottom: .6rem;
  }
  .expert-head {
    display: flex;
    align-items: center;
    gap: .5rem;
    margin-bottom: .25rem;
  }
  .expert-name { font-weight: 600; }
  .badge {
    font-size: .72rem;
    font-weight: 600;
    padding: .1rem .45rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--muted);
  }
  .badge.knowledge { background: #ddf4ff; color: #0a5cad; border-color: #b6e3ff; }
  .badge.question { background: #fff8c5; color: #7d4e00; border-color: #f0e08a; }
  .badge.pm { background: #dafbe1; color: #1a7f37; border-color: #aceebb; }
  .expert-meta {
    display: flex;
    flex-wrap: wrap;
    gap: .75rem;
    font-size: .82rem;
    color: var(--muted);
    margin-bottom: .25rem;
  }
  .expert-summary { margin: .35rem 0 .25rem; }
  .expert-scope { font-size: .8rem; color: var(--muted); }
  .pill {
    margin-left: auto;
    font-size: .72rem;
    color: var(--danger);
    display: inline-flex;
    align-items: center;
    gap: .3rem;
  }
  .dot {
    width: .5rem; height: .5rem;
    border-radius: 50%;
    background: var(--danger);
    display: inline-block;
  }
  textarea, input[type=text] {
    width: 100%;
    font: inherit;
    padding: .45rem .55rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    resize: vertical;
  }
  label { display: block; font-size: .8rem; color: var(--muted); margin: .5rem 0 .2rem; }
  .actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .5rem; }
  button {
    font: inherit;
    font-weight: 500;
    padding: .35rem .8rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--fg);
    cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  .empty { color: var(--muted); font-style: italic; padding: .5rem 0; }
  .error {
    color: var(--danger);
    background: #ffebe9;
    border: 1px solid #ffcecb;
    border-radius: 6px;
    padding: .5rem .6rem;
    margin: .5rem 0;
    font-size: .85rem;
    white-space: pre-wrap;
  }
  .pm-decision-answer { margin: .35rem 0; }
  .pm-meta { font-size: .78rem; color: var(--muted); }
  .row-head { display: flex; align-items: center; gap: .5rem; }
  .row-head .grow { flex: 1; }
  select {
    font: inherit;
    padding: .3rem .4rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
  }
  .pm-project { margin-bottom: 1.25rem; }
  .pm-project > h2 { display: flex; align-items: center; gap: .5rem; }
</style>
</head>
<body>
<h1>Experts</h1>
<div id="root"><p class="empty">Loading…</p></div>
<script>
(function () {
  "use strict";

  // ── Parent-proxied fetch bridge (the iframe is sandboxed w/o
  // allow-same-origin, so it cannot fetch the authed API directly). ──
  var _pending = {};
  var _seq = 0;
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (m && m.type === "plugin-ui-fetch-result" && _pending[m.requestId]) {
      _pending[m.requestId]({ status: m.status, body: m.body });
      delete _pending[m.requestId];
    }
  });
  function apiFetch(path, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var requestId = ++_seq;
      _pending[requestId] = resolve;
      window.parent.postMessage(
        { type: "plugin-ui-fetch", requestId, method: opts.method || "GET", path, body: opts.body },
        "*"
      );
    });
  }

  // ── tiny DOM helpers (no innerHTML with data — textContent only) ──
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function kindLabel(k) {
    if (k === "question") return "Question";
    if (k === "knowledge") return "Knowledge";
    if (k === "pm") return "PM";
    return "Expert";
  }
  function kindClass(k) {
    return k === "question" || k === "knowledge" || k === "pm" ? k : "";
  }
  // decided_at is a unix-ish number; treat < ~1e12 as seconds.
  function formatDate(ts) {
    if (ts == null) return "";
    var ms = ts < 1e12 ? ts * 1000 : ts;
    var d = new Date(ms);
    return isNaN(d.getTime()) ? "" : d.toLocaleString();
  }

  var root = document.getElementById("root");

  function showError(msg) {
    clear(root);
    var e = el("div", "error", msg || "Something went wrong.");
    root.appendChild(e);
  }

  // ── data ──
  var experts = [];
  // project_id -> { decisions, pending } (cached after first fetch)
  var pmState = {};

  function projectLabel(pid) {
    return pid ? "Project " + pid : "Global";
  }

  // ── Experts list ──
  function renderExpertRow(e) {
    var card = el("div", "card");
    var head = el("div", "expert-head");
    head.appendChild(el("span", "expert-name", e.name || "(unnamed)"));
    var badge = el("span", "badge " + kindClass(e.expert_kind), kindLabel(e.expert_kind));
    head.appendChild(badge);
    var pid = e.project_id;
    if (e.expert_kind === "pm" && pid && pmState[pid]) {
      var pc = pmState[pid].pending ? pmState[pid].pending.length : 0;
      if (pc > 0) {
        var pill = el("span", "pill");
        pill.appendChild(el("span", "dot"));
        pill.appendChild(el("span", null, pc + " question" + (pc === 1 ? "" : "s") + " waiting"));
        head.appendChild(pill);
      }
    }
    card.appendChild(head);

    var meta = el("div", "expert-meta");
    if (e.knowledge_area) meta.appendChild(el("span", null, e.knowledge_area));
    meta.appendChild(el("span", null, projectLabel(pid)));
    if (e.is_permanent) meta.appendChild(el("span", null, "permanent"));
    card.appendChild(meta);

    if (e.knowledge_summary) card.appendChild(el("p", "expert-summary", e.knowledge_summary));

    var scope = el("div", "expert-scope");
    scope.appendChild(el("strong", null, "Boundaries: "));
    scope.appendChild(document.createTextNode(e.scope_path || "whole project"));
    card.appendChild(scope);
    return card;
  }

  function renderExperts(container) {
    var section = el("div");
    section.appendChild(el("h2", null, "Expert Sessions"));
    if (experts.length === 0) {
      section.appendChild(el("p", "empty", "No expert sessions yet."));
      container.appendChild(section);
      return;
    }
    // Group: globals (project_id null) first, then per project_id.
    var groups = {};
    var order = [];
    experts.forEach(function (e) {
      var key = e.project_id || "__global__";
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(e);
    });
    // globals first
    order.sort(function (a, b) {
      if (a === "__global__") return -1;
      if (b === "__global__") return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    order.forEach(function (key) {
      var list = groups[key];
      var title = key === "__global__" ? "Global · Chat Sessions" : projectLabel(key);
      var h = el("h3", null, title);
      h.appendChild(el("span", "count", String(list.length)));
      section.appendChild(h);
      list.forEach(function (e) { section.appendChild(renderExpertRow(e)); });
    });
    container.appendChild(section);
  }

  // ── PM: pending question row ──
  function renderPending(pid, q) {
    var card = el("div", "card");
    card.appendChild(el("p", null, q.title || "(question)"));
    var ta = el("textarea");
    ta.rows = 3;
    ta.placeholder = "Your answer…";
    card.appendChild(ta);
    var errBox = el("div");
    card.appendChild(errBox);
    var actions = el("div", "actions");
    var btn = el("button", "primary", "Answer");
    actions.appendChild(btn);
    card.appendChild(actions);

    btn.addEventListener("click", function () {
      var ans = ta.value.trim();
      if (!ans) return;
      btn.disabled = true; ta.disabled = true; btn.textContent = "Answering…";
      clear(errBox);
      apiFetch("/api/plugin-ui/pm/answer", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, question_id: q.id, answer: ans }),
      }).then(function (res) {
        if (res.status < 200 || res.status >= 300) {
          btn.disabled = false; ta.disabled = false; btn.textContent = "Answer";
          errBox.appendChild(el("div", "error", res.body || ("HTTP " + res.status)));
          return;
        }
        // refetch this project's state and re-render the whole app.
        loadPm(pid).then(render);
      });
    });
    return card;
  }

  // ── PM: decision row with inline edit ──
  function renderDecision(pid, d) {
    var card = el("div", "card");

    function viewMode() {
      clear(card);
      var head = el("div", "row-head");
      var t = el("p", "grow"); t.style.margin = "0"; t.textContent = d.title || "(decision)";
      head.appendChild(t);
      var editBtn = el("button", null, "Edit");
      head.appendChild(editBtn);
      card.appendChild(head);
      card.appendChild(el("p", "pm-decision-answer", d.decision || ""));
      var meta = "Status: " + (d.status || "") ;
      if (d.decided_at) meta += " · Decided " + formatDate(d.decided_at);
      card.appendChild(el("div", "pm-meta", meta));
      editBtn.addEventListener("click", editMode);
    }

    function editMode() {
      clear(card);
      card.appendChild(el("label", null, "Title"));
      var titleIn = el("input"); titleIn.type = "text"; titleIn.value = d.title || "";
      card.appendChild(titleIn);
      card.appendChild(el("label", null, "Decision"));
      var ans = el("textarea"); ans.rows = 4; ans.value = d.decision || "";
      card.appendChild(ans);
      card.appendChild(el("p", "pm-meta", "Saving records your version and supersedes the one above."));
      var errBox = el("div");
      card.appendChild(errBox);
      var actions = el("div", "actions");
      var cancel = el("button", null, "Cancel");
      var save = el("button", "primary", "Save");
      actions.appendChild(cancel); actions.appendChild(save);
      card.appendChild(actions);

      cancel.addEventListener("click", viewMode);
      save.addEventListener("click", function () {
        var answer = ans.value.trim();
        if (!answer) return;
        save.disabled = true; cancel.disabled = true; save.textContent = "Saving…";
        clear(errBox);
        apiFetch("/api/plugin-ui/pm/decisions/" + encodeURIComponent(d.id), {
          method: "PUT",
          body: JSON.stringify({ title: titleIn.value.trim(), decision: answer }),
        }).then(function (res) {
          if (res.status < 200 || res.status >= 300) {
            save.disabled = false; cancel.disabled = false; save.textContent = "Save";
            errBox.appendChild(el("div", "error", res.body || ("HTTP " + res.status)));
            return;
          }
          loadPm(pid).then(render);
        });
      });
    }

    viewMode();
    return card;
  }

  function renderPmProject(container, pid, pmExperts) {
    var wrap = el("div", "pm-project");
    var h2 = el("h2", null, "PM · " + (pmExperts[0] && pmExperts[0].name ? pmExperts[0].name : projectLabel(pid)));
    h2.appendChild(el("span", "badge pm", "PM"));
    wrap.appendChild(h2);

    var st = pmState[pid];
    if (!st) {
      wrap.appendChild(el("p", "empty", "Loading…"));
      container.appendChild(wrap);
      return;
    }
    if (st.error) {
      wrap.appendChild(el("div", "error", st.error));
      container.appendChild(wrap);
      return;
    }

    var pendH = el("h3", null, "Pending Questions");
    if (st.pending.length) pendH.appendChild(el("span", "count", String(st.pending.length)));
    wrap.appendChild(pendH);
    if (st.pending.length === 0) {
      wrap.appendChild(el("p", "empty", "No questions waiting for an answer."));
    } else {
      st.pending.forEach(function (q) { wrap.appendChild(renderPending(pid, q)); });
    }

    wrap.appendChild(el("h3", null, "Decisions"));
    if (st.decisions.length === 0) {
      wrap.appendChild(el("p", "empty", "No decisions recorded yet."));
    } else {
      st.decisions.forEach(function (d) { wrap.appendChild(renderDecision(pid, d)); });
    }

    container.appendChild(wrap);
  }

  function renderPmSection(container) {
    // Projects that have a PM expert.
    var byProject = {};
    var order = [];
    experts.forEach(function (e) {
      if (e.expert_kind === "pm" && e.project_id) {
        if (!byProject[e.project_id]) { byProject[e.project_id] = []; order.push(e.project_id); }
        byProject[e.project_id].push(e);
      }
    });
    if (order.length === 0) return;
    container.appendChild(el("h2", null, "Project Management"));
    order.forEach(function (pid) {
      renderPmProject(container, pid, byProject[pid]);
    });
  }

  function render() {
    clear(root);
    renderExperts(root);
    renderPmSection(root);
  }

  // ── loaders ──
  function loadPm(pid) {
    return apiFetch("/api/plugin-ui/pm/decisions?project_id=" + encodeURIComponent(pid)).then(function (res) {
      if (res.status < 200 || res.status >= 300) {
        pmState[pid] = { decisions: [], pending: [], error: res.body || ("HTTP " + res.status) };
        return;
      }
      var data;
      try { data = JSON.parse(res.body); } catch (e) { data = {}; }
      pmState[pid] = {
        decisions: Array.isArray(data.decisions) ? data.decisions : [],
        pending: Array.isArray(data.pending) ? data.pending : [],
        error: null,
      };
    });
  }

  function init() {
    apiFetch("/api/plugin-ui/experts").then(function (res) {
      if (res.status < 200 || res.status >= 300) {
        showError(res.body || ("HTTP " + res.status));
        return;
      }
      var data;
      try { data = JSON.parse(res.body); }
      catch (e) { showError("Failed to parse experts response: " + e); return; }
      experts = Array.isArray(data.experts) ? data.experts : [];

      // Pre-fetch PM state for every project that has a PM expert.
      var pmProjects = {};
      experts.forEach(function (e) {
        if (e.expert_kind === "pm" && e.project_id) pmProjects[e.project_id] = true;
      });
      var ids = Object.keys(pmProjects);
      render(); // initial paint (PM cards show "Loading…")
      Promise.all(ids.map(loadPm)).then(render);
    });
  }

  init();
})();
</script>
</body>
</html>`;

// ── Authenticated app-UI endpoints (/api/plugin-ui/*) ─────────────────

export function serveAuthed(payload: any): string {
  const method = (
    payload && typeof payload.method === "string" ? payload.method : ""
  ).toUpperCase();
  const path = payload && typeof payload.path === "string" ? payload.path : "";
  const query = payload && typeof payload.query === "string" ? payload.query : "";
  const body = payload && typeof payload.body === "string" ? payload.body : "";
  const params =
    payload && payload.params !== undefined ? payload.params : null;

  let result: any;
  try {
    if (method === "GET" && path === "/api/plugin-ui/experts") {
      result = listExperts();
    } else if (method === "GET" && path === "/api/plugin-ui/pm/decisions") {
      result = pmDecisionsView(query);
    } else if (method === "POST" && path === "/api/plugin-ui/pm/answer") {
      result = pmAnswer(body);
    } else if (
      method === "PUT" &&
      path.startsWith("/api/plugin-ui/pm/decisions/")
    ) {
      const id =
        params && typeof params.id === "string" ? params.id : "";
      result = pmEdit(id, body);
    } else {
      return jsonResponse(404, { error: "not found" });
    }
  } catch (e) {
    return jsonResponse(400, { error: errMsg(e) });
  }
  return jsonResponse(200, result);
}

/// A project's PM decision board: active decisions + still-pending questions.
function pmDecisionsView(query: string): any {
  const project = queryParam(query, "project_id");
  if (project === undefined) {
    throw new Error("project_id is required");
  }
  const all = pmListDecisions();
  const decisions = all
    .filter((d) => d.project_id === project && pmIsActive(d))
    .map(pmDecisionJson);
  const pending = all
    .filter((d) => d.project_id === project && d.status === "pending")
    .map(pmDecisionJson);
  return { decisions, pending };
}

/// Answer a pending PM question: mark it answered, ISSUE a one-shot supersession
/// authorization, and resume the PM expert with the answer.
function pmAnswer(body: string): any {
  let b: any;
  try {
    b = JSON.parse(body);
  } catch (e) {
    throw new Error(`invalid request body: ${errMsg(e)}`);
  }
  const project = trimNonEmpty(b?.project_id);
  if (project === undefined) {
    throw new Error("project_id is required");
  }
  const qid = trimNonEmpty(b?.question_id);
  if (qid === undefined) {
    throw new Error("question_id is required");
  }
  const answer: string = typeof b?.answer === "string" ? b.answer : "";

  const decision = pmGetDecision(qid);
  if (decision === null || decision.project_id !== project) {
    throw new Error("pending question not found in this project");
  }
  if (decision.status !== "pending") {
    throw new Error("question is no longer pending");
  }
  decision.answer = answer;
  decision.status = "answered";
  decision.answered_at = nowMs();
  pmPutDecision(decision);

  // The user has answered → authorize one supersession by the PM expert.
  pmIssueGrant(project);

  // Deliver the answer to the PM expert so it can act on it now.
  const pmId = pmExpertId(project);
  if (pmId !== null) {
    const msg =
      `[User answered a pending question]\n\nQ: ${decision.question}\nA: ${answer}\n\n` +
      "You now have one authorization to supersede an existing decision if this requires it " +
      "(pm_record_decision with supersedes_decision_id).";
    try {
      resumeSession({ session_id: pmId, text: msg });
    } catch (_e) {
      // best-effort
    }
  }

  const pendingCount = pmListDecisions().filter(
    (d) => d.project_id === project && d.status === "pending",
  ).length;
  return { decision: pmDecisionJson(decision), pending_count: pendingCount };
}

/// Directly edit/supersede a decision (the user editing it in the UI).
function pmEdit(id: string, body: string): any {
  if (id.trim() === "") {
    throw new Error("decision id is required");
  }
  let b: any;
  try {
    b = JSON.parse(body);
  } catch (e) {
    throw new Error(`invalid request body: ${errMsg(e)}`);
  }
  const answer = trimNonEmpty(b?.answer);
  if (answer === undefined) {
    throw new Error("answer is required");
  }
  const old = pmGetDecision(id.trim());
  if (old === null) {
    throw new Error("decision not found");
  }
  if (old.status !== "answered") {
    throw new Error("only an answered decision can be edited");
  }
  const now = nowMs();
  const question: string =
    typeof b?.question === "string" ? b.question : old.question;
  const newDecision: PmDecision = {
    id: genId(),
    project_id: old.project_id,
    question,
    answer,
    status: "answered",
    superseded_by: null,
    created_at: now,
    answered_at: now,
    asked_by: old.asked_by,
  };
  old.status = "superseded";
  old.superseded_by = newDecision.id;
  pmPutDecision(old);
  pmPutDecision(newDecision);
  return { decision: pmDecisionJson(newDecision) };
}

function trimNonEmpty(v: any): string | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/// Extract `name`'s value from a `&`-separated query string.
export function queryParam(query: string, name: string): string | undefined {
  for (const pair of query.split("&")) {
    const idx = pair.indexOf("=");
    if (idx < 0) {
      continue;
    }
    const k = pair.slice(0, idx);
    const v = pair.slice(idx + 1);
    if (k === name) {
      return v;
    }
  }
  return undefined;
}
