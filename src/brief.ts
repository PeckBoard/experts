// Distilled knowledge briefs: a cheap, synchronous alternative to a live
// `ask_expert` round-trip. After a knowledge expert reads its scope it records
// a compact written brief (via `record_expert_brief`); any worker can then
// pull that brief in ONE turn (`read_expert_brief`) instead of paying the
// two-turn async consult just to get oriented. Briefs live in the plugin's
// document store, keyed by the expert's session id.

import { InvokeContext } from "./lib";
import { loadExperts, resolveExpert, ExpertSession } from "./experts";
import { storeGet, storePut, nowMs } from "./host";
import { truncate } from "./verdict";

/// Document-store collection for distilled knowledge briefs.
export const BRIEFS = "expert_briefs";
/// Upper bound on a stored brief — keeps a single read cheap and bounded.
export const MAX_BRIEF_CHARS = 8000;

/// One expert's distilled brief, as stored.
export interface ExpertBrief {
  session_id: string;
  area: string;
  scope_path: string;
  brief: string;
  updated_at: number;
}

/// Parse a stored brief blob, applying defaults for missing fields.
export function parseBrief(v: any): ExpertBrief | null {
  if (v === null || v === undefined || typeof v !== "object") {
    return null;
  }
  if (typeof v.session_id !== "string" || typeof v.brief !== "string") {
    return null;
  }
  return {
    session_id: v.session_id,
    area: typeof v.area === "string" ? v.area : "",
    scope_path: typeof v.scope_path === "string" ? v.scope_path : "",
    brief: v.brief,
    updated_at: typeof v.updated_at === "number" ? v.updated_at : 0,
  };
}

/// The compact JSON shape returned to callers — prefers the expert's live meta
/// (area/scope) over whatever was stored alongside the brief.
export function briefJson(b: ExpertBrief, e: ExpertSession | undefined): any {
  return {
    expert_id: b.session_id,
    area: e?.meta.area || b.area,
    scope_path: e?.meta.scope_path || b.scope_path,
    brief: b.brief,
    updated_at: b.updated_at,
  };
}

/// `record_expert_brief` — a knowledge expert persists its distilled brief.
/// Scoped to the CALLER: the brief is keyed by the caller's own session id, so
/// an expert can only write its own brief.
export function recordExpertBrief(args: any, ctx: InvokeContext): any {
  const a = args && typeof args === "object" ? args : {};
  const raw = typeof a.brief === "string" ? a.brief.trim() : "";
  if (raw === "") {
    throw new Error("brief is required");
  }
  const sessionId = ctx.session_id;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("no caller session context");
  }
  // Pick up the expert's own area/scope from its meta when visible; fall back
  // to an explicit `area` arg for an as-yet-untagged session.
  const me = loadExperts(false).find((e) => e.session?.id === sessionId);
  const area = me?.meta.area ?? (typeof a.area === "string" ? a.area : "");
  const scopePath = me?.meta.scope_path ?? "";
  const rec: ExpertBrief = {
    session_id: sessionId,
    area,
    scope_path: scopePath,
    brief: truncate(raw, MAX_BRIEF_CHARS),
    updated_at: nowMs(),
  };
  storePut({ collection: BRIEFS, key: sessionId, data: rec });
  return {
    recorded: true,
    session_id: sessionId,
    area,
    chars: rec.brief.length,
  };
}

/// `read_expert_brief` — fetch distilled brief(s) synchronously. With
/// `expert_id`/`area`, returns that one expert's brief; with neither, returns
/// every in-scope knowledge expert's brief (a cheap codebase orientation).
/// Only experts VISIBLE to the caller are read, so briefs never cross scope.
export function readExpertBrief(args: any, _ctx: InvokeContext): any {
  const a = args && typeof args === "object" ? args : {};
  const expertId: string | undefined =
    typeof a.expert_id === "string" ? a.expert_id : undefined;
  const area: string | undefined =
    typeof a.area === "string" ? a.area : undefined;

  const experts = loadExperts(false).filter((e) => e.meta.kind === "knowledge");
  if (experts.length === 0) {
    return {
      briefs: [],
      note: "no knowledge experts in your scope; run spin_up_experts first",
    };
  }

  // Targeted: resolve a single expert (only within the caller's scope).
  const wantId = expertId !== undefined && expertId.trim() !== "";
  const wantArea = area !== undefined && area.trim() !== "";
  if (wantId || wantArea) {
    const target = resolveExpert(experts, expertId, area);
    if (!target) {
      return { briefs: [], note: "no matching expert found in your scope" };
    }
    const id = target.session?.id;
    const b = typeof id === "string" ? getBrief(id) : null;
    if (b === null) {
      return {
        briefs: [],
        note: `no brief recorded yet for ${target.meta.area || "that expert"}; use ask_expert to consult it live`,
      };
    }
    return { briefs: [briefJson(b, target)] };
  }

  // Orientation: every in-scope knowledge expert's brief.
  const out: any[] = [];
  let missing = 0;
  for (const e of experts) {
    const id = e.session?.id;
    const b = typeof id === "string" ? getBrief(id) : null;
    if (b !== null) {
      out.push(briefJson(b, e));
    } else {
      missing += 1;
    }
  }
  const res: any = { briefs: out };
  if (missing > 0) {
    res.note = `${missing} expert(s) have no brief recorded yet; use ask_expert for those areas`;
  }
  return res;
}

function getBrief(id: string): ExpertBrief | null {
  const out = storeGet({ collection: BRIEFS, key: id });
  const v = out?.value;
  if (v === null || v === undefined) {
    return null;
  }
  return parseBrief(v);
}
