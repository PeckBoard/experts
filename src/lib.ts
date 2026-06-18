// Entry + hook dispatch. Mirrors `lib.rs`: parses the `{ hook, payload }`
// envelope and routes each hook to its handler. The wasm export functions
// themselves live in `index.ts`.

import { allow, cancel, skip } from "./verdict";
import { spinUpExperts, listExperts, loadExperts } from "./experts";
import { askExpert } from "./ask";
import {
  pmRecordDecision,
  pmCheckDecisions,
  pmEscalateToUser,
} from "./pm";
import { serveHttp } from "./http";
import { serveAuthed } from "./http";
import { resumeSession } from "./host";

/// The `mcp.tool.invoke` payload's trusted caller context. Matches the Rust
/// serde renames: `sessionId` / `projectId` (camelCase on the wire).
export interface InvokeContext {
  session_id: string;
  project_id: string | null;
}

function parseContext(ctx: any): InvokeContext {
  if (ctx === null || ctx === undefined || typeof ctx !== "object") {
    return { session_id: "", project_id: null };
  }
  return {
    session_id: typeof ctx.sessionId === "string" ? ctx.sessionId : "",
    project_id: typeof ctx.projectId === "string" ? ctx.projectId : null,
  };
}

/// Dispatch a hook call to the right handler, returning a verdict JSON string.
export function dispatch(hook: string, payload: any): string {
  switch (hook) {
    case "mcp.tool.invoke":
      return handleInvoke(payload);
    case "http.request.before":
      return serveHttp(payload);
    case "http.request.authed":
      return serveAuthed(payload);
    case "session.user.answer":
      return handleUserAnswer(payload);
    default:
      return skip();
  }
}

/// Dispatch an `mcp.tool.invoke` to the right tool. Every tool returns a value;
/// a tool-level failure becomes an `{"error": ...}` value, while an unknown
/// tool is a Cancel.
function handleInvoke(payload: any): string {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return cancel("malformed invoke payload: not an object");
  }
  const tool: string = typeof payload.tool === "string" ? payload.tool : "";
  const args = payload.arguments ?? {};
  const ctx = parseContext(payload.context);

  let value: any;
  try {
    switch (tool) {
      case "spin_up_experts":
        value = spinUpExperts(args);
        break;
      case "list_experts":
        value = listExperts();
        break;
      case "ask_expert":
        value = askExpert(args, ctx);
        break;
      case "pm_record_decision":
        value = pmRecordDecision(args, ctx);
        break;
      case "pm_check_decisions":
        value = pmCheckDecisions(args, ctx);
        break;
      case "pm_escalate_to_user":
        value = pmEscalateToUser(args, ctx);
        break;
      default:
        return cancel(`experts plugin does not provide tool '${tool}'`);
    }
  } catch (e) {
    value = { error: errMsg(e) };
  }
  return allow(value);
}

/// `session.user.answer` notification: a user just answered a worker's
/// question. Feed the readable Q&A to the project's question expert(s).
function handleUserAnswer(payload: any): string {
  const projectId =
    payload && typeof payload.project_id === "string" ? payload.project_id : "";
  const qaText =
    payload && typeof payload.qa_text === "string" ? payload.qa_text : "";
  if (projectId === "" || qaText.trim() === "") {
    return skip();
  }

  let experts;
  try {
    experts = loadExperts(false);
  } catch (_e) {
    // A read failure must not look like a cancel of the user's answer.
    return skip();
  }

  const msg =
    "[Knowledge update] The user just answered a worker's question in this " +
    "project. Record this so future workers don't have to ask the same thing " +
    `again:\n\n${qaText}`;
  let fed = 0;
  for (const e of experts) {
    if (e.meta.kind !== "question") {
      continue;
    }
    if (e.session?.project_id !== projectId) {
      continue;
    }
    const id = e.session?.id;
    if (typeof id === "string") {
      try {
        resumeSession({ session_id: id, text: msg });
      } catch (_e) {
        // best-effort (mirrors Rust `let _ =`)
      }
      fed += 1;
    }
  }
  return allow({ fed });
}

/// Stringify a caught error to the message string the Rust `Err(String)` carried.
export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
