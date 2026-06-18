// The PM expert: the durable project-decision store, its three MCP tools, the
// supersession-grant flow, and the store/scope plumbing they share.
// Mirrors `pm.rs`.

import { InvokeContext } from "./lib";
import { loadExperts } from "./experts";
import {
  storePut,
  storeGet,
  storeList,
  resumeSession,
  genId,
  nowMs,
} from "./host";

/// Document-store collection for PM decisions.
export const PM_DECISIONS = "pm_decisions";
/// Document-store collection for per-project supersession grants.
export const PM_GRANTS = "pm_grants";

/// One PM decision (or pending question) as stored.
export interface PmDecision {
  id: string;
  project_id: string;
  question: string;
  answer: string | null;
  status: string;
  superseded_by: string | null;
  created_at: number;
  answered_at: number | null;
  asked_by: string | null;
}

/// Parse a stored decision blob, applying serde-style defaults.
function parseDecision(v: any): PmDecision | null {
  if (v === null || v === undefined || typeof v !== "object") {
    return null;
  }
  // The Rust struct required id/project_id/question/status (non-default).
  if (
    typeof v.id !== "string" ||
    typeof v.project_id !== "string" ||
    typeof v.question !== "string" ||
    typeof v.status !== "string"
  ) {
    return null;
  }
  return {
    id: v.id,
    project_id: v.project_id,
    question: v.question,
    answer: typeof v.answer === "string" ? v.answer : null,
    status: v.status,
    superseded_by: typeof v.superseded_by === "string" ? v.superseded_by : null,
    created_at: typeof v.created_at === "number" ? v.created_at : 0,
    answered_at: typeof v.answered_at === "number" ? v.answered_at : null,
    asked_by: typeof v.asked_by === "string" ? v.asked_by : null,
  };
}

/// Active = answered and not superseded — the set `pm_check_decisions` returns.
export function pmIsActive(d: PmDecision): boolean {
  return d.status === "answered";
}

/// Case-insensitive match of `keywords` against a decision's question + answer.
export function pmMatchesKeywords(d: PmDecision, keywords: string[]): boolean {
  if (keywords.length === 0) {
    return true;
  }
  const hay = `${d.question.toLowerCase()} ${(d.answer ?? "").toLowerCase()}`;
  return keywords.some((k) => hay.includes(k.trim().toLowerCase()));
}

/// Narrow `active` decisions by `keywords`, returning their compact JSON.
export function pmFilterDecisions(
  active: PmDecision[],
  keywords: string[],
): any[] {
  const narrowed = active.filter((d) => pmMatchesKeywords(d, keywords));
  if (narrowed.length === 0) {
    return active.map(pmDecisionJson);
  }
  return narrowed.map(pmDecisionJson);
}

/// The compact JSON shape returned to callers.
export function pmDecisionJson(d: PmDecision): any {
  return {
    id: d.id,
    title: d.question,
    decision: d.answer,
    status: d.status,
    decided_at: d.answered_at ?? d.created_at,
  };
}

/// `pm_check_decisions` — return the caller project's active decisions.
export function pmCheckDecisions(args: any, ctx: InvokeContext): any {
  const a = args && typeof args === "object" ? args : {};
  const keywords: string[] = Array.isArray(a.topic_keywords)
    ? a.topic_keywords.filter((k: any) => typeof k === "string")
    : [];
  const argProject: string | undefined =
    typeof a.project_id === "string" ? a.project_id : undefined;
  const project = resolvePmProject(argProject, ctx);
  const active = pmListDecisions().filter(
    (d) => d.project_id === project && pmIsActive(d),
  );
  return { decisions: pmFilterDecisions(active, keywords) };
}

/// `pm_record_decision` — ADD a decision, or (PM expert + user authorization
/// only) SUPERSEDE an existing one.
export function pmRecordDecision(args: any, ctx: InvokeContext): any {
  const a = args && typeof args === "object" ? args : {};
  const title = trimNonEmpty(a.title);
  if (title === undefined) {
    throw new Error("title is required");
  }
  const decision = trimNonEmpty(a.decision);
  if (decision === undefined) {
    throw new Error("decision is required");
  }
  const argProject: string | undefined =
    typeof a.project_id === "string" ? a.project_id : undefined;
  const project = resolvePmProject(argProject, ctx);
  const now = nowMs();

  const newDecision: PmDecision = {
    id: genId(),
    project_id: project,
    question: title,
    answer: decision,
    status: "answered",
    superseded_by: null,
    created_at: now,
    answered_at: now,
    asked_by: ctx.session_id,
  };

  const oldId =
    typeof a.supersedes_decision_id === "string" &&
    a.supersedes_decision_id.length > 0
      ? a.supersedes_decision_id
      : undefined;

  if (oldId !== undefined) {
    // Supersession is restricted to the PM expert acting on a consumed
    // one-shot user authorization.
    if (!callerIsPmExpert(project, ctx)) {
      throw new Error("only the PM expert may supersede a decision");
    }
    const old = pmGetDecision(oldId);
    if (old === null || old.project_id !== project) {
      throw new Error("decision to supersede not found in this project");
    }
    if (old.status !== "answered") {
      throw new Error("only an answered decision can be superseded");
    }
    if (!pmConsumeGrant(project)) {
      throw new Error(
        "no outstanding user authorization to supersede a decision; escalate to the user first",
      );
    }
    old.status = "superseded";
    old.superseded_by = newDecision.id;
    pmPutDecision(old);
    pmPutDecision(newDecision);
  } else {
    pmPutDecision(newDecision);
    // Notify the project's PM expert that another session recorded a decision
    // (best-effort; skipped when the recorder IS the PM expert).
    let isPm = false;
    try {
      isPm = callerIsPmExpert(project, ctx);
    } catch (_e) {
      isPm = false;
    }
    if (!isPm) {
      const pmId = pmExpertId(project);
      if (pmId !== null) {
        const msg =
          `[PM decision recorded by session ${ctx.session_id}]\n\n` +
          `${newDecision.question}\n\n${newDecision.answer ?? ""}`;
        try {
          resumeSession({ session_id: pmId, text: msg });
        } catch (_e) {
          // best-effort
        }
      }
    }
  }
  return { decision: pmDecisionJson(newDecision) };
}

/// `pm_escalate_to_user` — PM expert only: park a decision question as PENDING.
export function pmEscalateToUser(args: any, ctx: InvokeContext): any {
  const a = args && typeof args === "object" ? args : {};
  const question = trimNonEmpty(a.question);
  if (question === undefined) {
    throw new Error("question is required");
  }
  // The escalation is project-scoped via the caller's context.
  const project = resolvePmProject(undefined, ctx);
  if (!callerIsPmExpert(project, ctx)) {
    throw new Error("only the project's PM expert may escalate to the user");
  }
  const askingSessionId: string | null =
    typeof a.asking_session_id === "string" ? a.asking_session_id : null;
  const pending: PmDecision = {
    id: genId(),
    project_id: project,
    question,
    answer: null,
    status: "pending",
    superseded_by: null,
    created_at: nowMs(),
    answered_at: null,
    asked_by: askingSessionId,
  };
  pmPutDecision(pending);
  const pendingCount = pmListDecisions().filter(
    (d) => d.project_id === project && d.status === "pending",
  ).length;
  return { pending_id: pending.id, pending_count: pendingCount };
}

// ── PM plumbing (store, scope) ────────────────────────────────────────

function trimNonEmpty(v: any): string | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/// Resolve the PM project: the caller's project context is authoritative; an
/// explicit `project_id` is only honored for an unscoped caller, and a
/// conflicting one is rejected.
export function resolvePmProject(
  argProject: string | undefined,
  ctx: InvokeContext,
): string {
  const ctxProject = ctx.project_id;
  if (ctxProject !== null && ctxProject !== undefined) {
    if (
      argProject !== undefined &&
      argProject !== null &&
      ctxProject !== argProject
    ) {
      throw new Error("project_id does not match the calling session's project");
    }
    return ctxProject;
  }
  if (
    argProject !== undefined &&
    argProject !== null &&
    argProject.trim() !== ""
  ) {
    return argProject.trim();
  }
  throw new Error("no project context; pass project_id from an unscoped session");
}

/// The session id of the project's PM expert (kind == "pm"), if any.
export function pmExpertId(project: string): string | null {
  const found = loadExperts(false).find(
    (e) => e.meta.kind === "pm" && e.session?.project_id === project,
  );
  if (!found) {
    return null;
  }
  const id = found.session?.id;
  return typeof id === "string" ? id : null;
}

/// Whether the calling session IS the project's PM expert.
export function callerIsPmExpert(project: string, ctx: InvokeContext): boolean {
  return pmExpertId(project) === ctx.session_id;
}

export function pmPutDecision(d: PmDecision): void {
  storePut({ collection: PM_DECISIONS, key: d.id, data: d });
}

export function pmGetDecision(id: string): PmDecision | null {
  const out = storeGet({ collection: PM_DECISIONS, key: id });
  const v = out?.value;
  if (v === null || v === undefined) {
    return null;
  }
  const d = parseDecision(v);
  if (d === null) {
    throw new Error(`corrupt decision ${id}`);
  }
  return d;
}

export function pmListDecisions(): PmDecision[] {
  const out = storeList({ collection: PM_DECISIONS });
  const decisions: PmDecision[] = [];
  const items = out?.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      const d = parseDecision(item?.value);
      if (d !== null) {
        decisions.push(d);
      }
    }
  }
  return decisions;
}

/// Consume one supersession grant for `project`, returning whether one was
/// available.
export function pmConsumeGrant(project: string): boolean {
  const out = storeGet({ collection: PM_GRANTS, key: project });
  const count = asU64(out?.value);
  if (count === 0) {
    return false;
  }
  storePut({ collection: PM_GRANTS, key: project, data: count - 1 });
  return true;
}

/// Issue (increment) one supersession authorization for `project`.
export function pmIssueGrant(project: string): void {
  const out = storeGet({ collection: PM_GRANTS, key: project });
  const count = asU64(out?.value);
  storePut({ collection: PM_GRANTS, key: project, data: count + 1 });
}

/// Mirror serde's `as_u64().unwrap_or(0)`: a non-numeric/negative value → 0.
function asU64(v: any): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
    return v;
  }
  return 0;
}
