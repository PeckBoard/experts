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

const EXPERTS_PAGE =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<title>Experts</title><meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#222}h1{font-size:1.4rem}</style>" +
  "</head><body><h1>Experts</h1>" +
  "<p>Knowledge experts are created with the <code>spin_up_experts</code> tool and consulted via <code>ask_expert</code>.</p>" +
  "<p>The live experts list renders here once the frontend page is wired.</p>" +
  "</body></html>";

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
