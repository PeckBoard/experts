//! Experts plugin — knowledge-expert MCP tools served as a WASM plugin.
//!
//! Implements three MCP tools, declared in [`manifest`] and dispatched by
//! [`handle`] via the terminal `mcp.tool.invoke` hook:
//!
//! - **`spin_up_experts`** — partition the caller's project files (read through
//!   the `peckboard_list_project_files` host fn) into size-balanced slices,
//!   create one long-lived KNOWLEDGE-EXPERT session per slice
//!   (`peckboard_create_session`), tag it with this plugin's session metadata
//!   (`peckboard_session_meta_set`), and fire a capture run on each
//!   (`peckboard_dispatch_capture`) so it reads and summarizes its slice.
//! - **`list_experts`** — list the expert sessions this plugin manages that the
//!   caller may see (`peckboard_list_sessions`), as compact summaries.
//! - **`ask_expert`** — deliver a question to an expert (ask mode) or an answer
//!   back to the asker (reply mode) via `peckboard_resume_session`.
//!
//! "Expert-ness" is the plugin's own session metadata (kind / area / scope /
//! summary), never a core column — core stores the underlying rows as ordinary
//! sessions. Every host function re-derives the caller's scope from the trusted
//! invocation context, so the plugin can only ever reach sessions in the
//! caller's reach.
//!
//! This plugin is becoming the SOLE owner of the experts feature — knowledge,
//! question, AND PM experts — so core ends up with no experts logic at all.
//! `spin_up_experts` ensures the durable question + PM experts; the PM decision
//! store, the user-authorization grant flow, and the Q&A feedback loop move here
//! over the cutover increments (some switch over only when core's versions are
//! removed, to avoid double-feeding the experts during the transition).
//!
//! The Extism entry points (`#[plugin_fn]`) and host-import bindings
//! (`#[host_fn]`) only link against the wasm runtime's intrinsics, so they are
//! gated to `wasm32`. The pure partition/resolve logic is always compiled and
//! is what the unit tests (run on the host target) exercise.

// On the host (test) target the wasm glue is cfg'd out, leaving some pure
// helpers used only by that glue — allow that rather than scatter per-item cfgs.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use std::collections::BTreeMap;

#[cfg(target_arch = "wasm32")]
use extism_pdk::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

// ── Host functions (provided by Peckboard core; see peckboard/src/plugin/host.rs)
//
// Each is JSON-string-in / JSON-string-out and returns an `{"error": ...}`
// envelope on failure rather than trapping. The session/file/dispatch
// functions are scope-checked host-side against the *caller's* trusted context,
// so the ids this plugin passes can never reach outside the caller's folder/
// project.
#[cfg(target_arch = "wasm32")]
#[host_fn]
extern "ExtismHost" {
    /// `{"project_only"?: bool}` → `{"sessions": [{"session": {...}, "meta": {...}}]}`.
    fn peckboard_list_sessions(input: String) -> String;
    /// `{"session_id"}` → `{"session": {...}}` (refused unless owned + visible).
    fn peckboard_get_session(input: String) -> String;
    /// `{"name", "id"?, "model"?, "effort"?}` → `{"session": {...}}` in the caller's scope.
    fn peckboard_create_session(input: String) -> String;
    /// `{"session_id", "data": <json>}` → `{"ok": true}` (this plugin's namespace).
    fn peckboard_session_meta_set(input: String) -> String;
    /// `{}` → `{"files": [{"path", "size"}], "truncated": bool}` for the caller's folder.
    fn peckboard_list_project_files(input: String) -> String;
    /// `{"session_id", "prompt"}` → `{"ok": true}`; fire-and-forget capture run.
    fn peckboard_dispatch_capture(input: String) -> String;
    /// `{"session_id", "text"}` → `{"ok": true}`; deliver + resume.
    fn peckboard_resume_session(input: String) -> String;
    /// `{"collection", "key", "data"}` → `{"ok": true}`; plugin document store.
    fn peckboard_store_put(input: String) -> String;
    /// `{"collection", "key"}` → `{"value": <json|null>}`.
    fn peckboard_store_get(input: String) -> String;
    /// `{"collection"}` → `{"items": [{"key", "value"}]}`.
    fn peckboard_store_list(input: String) -> String;
}

// WASI imports the Extism host provides (plugins load with WASI enabled). The
// sandbox has no other entropy or wall-clock, so PM decision ids and timestamps
// come from here. Both return a WASI errno (`0` = ok).
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    /// Fill `buf[0..buf_len]` with cryptographically secure random bytes.
    fn random_get(buf: *mut u8, buf_len: usize) -> i32;
    /// Write the current time (nanoseconds) for clock `id` to `*time`
    /// (`id = 0` = realtime).
    fn clock_time_get(id: u32, precision: u64, time: *mut u64) -> i32;
}

/// Default upper bound on experts created by `spin_up_experts`.
const DEFAULT_MAX_EXPERTS: usize = 4;
/// Hard ceiling regardless of request (keeps a pathological call bounded).
const MAX_EXPERTS_CAP: usize = 12;
/// Target bytes per expert when auto-sizing the partition count.
const PARTITION_WINDOW_BYTES: u64 = 50_000;
/// Cap on a `knowledge_summary` returned by `list_experts`, so a big listing
/// stays well under the MCP result-size limits.
const SUMMARY_LIST_CAP: usize = 600;

/// Answer-only role framing dispatched to the QUESTION expert when it is first
/// created. This re-homes core's old question-expert system prompt, which used
/// to be appended at spawn time keyed on the now-removed `expert_kind` column
/// (core no longer knows what an expert is). It shapes BEHAVIOR — answer from
/// accumulated memory, never investigate. NOTE: core's old *hard* tool lockdown
/// (CLI `--disallowedTools` denying code/web/shell) is not re-homed here; that
/// would need a generic per-session "restricted spawn" capability. The framing
/// keeps the expert acting answer-only without that machinery.
const QUESTION_EXPERT_PRIMING: &str = "You are a long-lived QUESTION EXPERT \
running in answer-only mode. Your ONLY job is to answer questions from the \
knowledge accumulated in THIS conversation — the answers the user has given over \
time — so other sessions don't have to re-ask something already settled.\n\n\
Hard rules:\n\
- Answer ONLY from your accumulated Q&A history. Do NOT investigate, explore, \
read the codebase, search the web, or run commands.\n\
- If you don't already have a recorded answer, say so plainly (e.g. \"I don't \
have a recorded answer for that yet\") — do not guess. The asking session falls \
back to the human, whose answer is then recorded with you for next time.\n\
- When another session consults you, reply by calling `mcp__peckboard__ask_expert` \
with `reply_to_session_id` set to the asking session and `answer` set to your reply.\n\n\
Acknowledge this role briefly.";

/// This plugin's per-session metadata blob (stored via `peckboard_session_meta_set`,
/// read back from `peckboard_list_sessions`). This — not any core column — is
/// what makes a session an "expert".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ExpertMeta {
    /// `"knowledge"` | `"question"` | `"pm"`.
    #[serde(default)]
    kind: String,
    /// Human label, e.g. `"auth + ws"`.
    #[serde(default)]
    area: String,
    /// Comma-joined directories the expert covers.
    #[serde(default)]
    scope_path: String,
    /// Plaintext summary of the expert's slice (files, languages).
    #[serde(default)]
    summary: String,
    /// Whether the expert survives restarts (question/PM experts do).
    #[serde(default)]
    permanent: bool,
}

/// `manifest` — identity (from `Cargo.toml`), the terminal `mcp.tool.invoke`
/// hook, the three MCP tools with their input schemas, the sidebar entry, the
/// served page route, and the permissions the host functions require.
#[cfg(target_arch = "wasm32")]
#[plugin_fn]
pub fn manifest() -> FnResult<String> {
    let manifest = json!({
        "description": env!("CARGO_PKG_DESCRIPTION"),
        "version": env!("CARGO_PKG_VERSION"),
        "repository": env!("CARGO_PKG_REPOSITORY"),

        "hooks": [
            "mcp.tool.invoke",
            "http.request.before",
            "http.request.authed",
            "session.user.answer"
        ],

        "mcp_tools": [
            {
                "name": "spin_up_experts",
                "title": "Spin up experts",
                "description": "Partition a project's codebase across several long-lived KNOWLEDGE-EXPERT sessions and have each eagerly read and summarize its slice. The split is size-balanced, grouping adjacent top-level directories together. Returns the created experts (session id, area, scope_path). Experts are consulted later via ask_expert. Pass `scopes` to create one expert per explicit path instead of the automatic split.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "project_id": { "type": "string", "description": "Project to spin experts up for (optional if the session already has project context)." },
                        "max_experts": { "type": "integer", "description": "Upper bound on how many experts to create (default 4). Ignored when `scopes` is given." },
                        "scopes": {
                            "type": "array",
                            "items": { "type": ["string", "array"], "items": { "type": "string" } },
                            "description": "Explicit scope entries; each becomes one expert. An entry is a single folder-relative path or an array of paths the expert covers together."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "list_experts",
                "title": "List experts",
                "description": "List the long-lived EXPERT sessions you may consult (your project's experts plus globals). Each entry returns session_id, name, expert_kind, knowledge_area, a compact knowledge_summary, scope_path, project_id, is_permanent, and last_activity. Use this to pick a target session_id for ask_expert.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "project_id": { "type": "string", "description": "Project whose experts to list (optional). Globals are always included." }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "ask_expert",
                "title": "Ask an expert",
                "description": "Ask a long-lived EXPERT session a question, ASYNCHRONOUSLY — the answer arrives as an event you read on a later turn. Target by explicit `expert_id` (from list_experts) or by an `area`/topic string. EXPERTS answering use the same tool in reply mode by setting `answer` + `reply_to_session_id`.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "question": { "type": "string", "description": "The question to ask (required when asking)." },
                        "expert_id": { "type": "string", "description": "Explicit target expert session id. Takes precedence over `area`." },
                        "area": { "type": "string", "description": "Topic/area hint used to resolve the best in-scope expert." },
                        "answer": { "type": "string", "description": "REPLY MODE: answer text to deliver back to the asking session. Requires `reply_to_session_id`." },
                        "reply_to_session_id": { "type": "string", "description": "REPLY MODE: the session id to deliver the answer to. Requires `answer`." }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "pm_record_decision",
                "title": "Record PM decision",
                "description": "Record a project-direction or business-logic decision in the project's durable PM decision log. Workers may only ADD new decisions; changing/superseding an existing decision (supersedes_decision_id) is restricted to the PM expert acting on explicit user authorization. The PM expert is notified of decisions recorded by other sessions.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Short title naming what was decided" },
                        "decision": { "type": "string", "description": "The decision itself — the rule future changes must respect" },
                        "rationale": { "type": "string", "description": "Why this was decided (optional)" },
                        "supersedes_decision_id": { "type": "string", "description": "Id of an existing decision this replaces. RESTRICTED: PM expert + user authorization only." },
                        "project_id": { "type": "string", "description": "Target project; only used by an unscoped session." }
                    },
                    "required": ["title", "decision"],
                    "additionalProperties": false
                }
            },
            {
                "name": "pm_check_decisions",
                "title": "Check PM decisions",
                "description": "Check a planned change against the project's active (non-superseded) PM decisions BEFORE making it. Synchronous — returns the active decision set (id, title, decision, decided_at) immediately. Optionally narrow with topic_keywords; a non-matching keyword returns the full set rather than hiding decisions.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "planned_change": { "type": "string", "description": "Plain-language description of the change you are about to make" },
                        "topic_keywords": { "type": "array", "items": { "type": "string" }, "description": "Optional keywords to narrow the returned decisions (matched against title + decision)." },
                        "project_id": { "type": "string", "description": "Target project; only used by an unscoped session." }
                    },
                    "required": ["planned_change"],
                    "additionalProperties": false
                }
            },
            {
                "name": "pm_escalate_to_user",
                "title": "Escalate to user",
                "description": "PM EXPERT ONLY: escalate a project-direction question you cannot answer from recorded decisions to the user. It lands in the project's PM log as PENDING; when the user answers, their answer authorizes superseding a decision. Other sessions are rejected — route questions through the PM expert via ask_expert (\"pm\").",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "question": { "type": "string", "description": "The decision question the user must answer" },
                        "context": { "type": "string", "description": "Optional context: why this is asked, options, impact" },
                        "asking_session_id": { "type": "string", "description": "Optional worker session that triggered the escalation, to relay the answer back." }
                    },
                    "required": ["question"],
                    "additionalProperties": false
                }
            }
        ],

        "sidebar_items": [
            { "id": "experts", "label": "Experts", "path": "/plugin-api/v1/experts" }
        ],

        "http_routes": ["GET /plugin-api/v1/experts"],

        // Authenticated app-UI endpoints (behind core's require_auth, served
        // under the logged-in user's authority). The React Experts/PM views
        // call these.
        "ui_routes": [
            "GET /api/plugin-ui/experts",
            "GET /api/plugin-ui/pm/decisions",
            "POST /api/plugin-ui/pm/answer",
            "PUT /api/plugin-ui/pm/decisions/:id"
        ],

        "permissions": [
            "provide_mcp_tools",
            "contribute_sidebar",
            "session_read",
            "session_write",
            "session_dispatch",
            "project_files_read",
            "data_store",
            "user_authority"
        ]
    });
    Ok(manifest.to_string())
}

/// `init` — no per-plugin config needed yet. Returns the standard ok envelope.
#[cfg(target_arch = "wasm32")]
#[plugin_fn]
pub fn init(_config: String) -> FnResult<String> {
    Ok(json!({ "ok": true }).to_string())
}

/// `shutdown` — nothing to tear down.
#[cfg(target_arch = "wasm32")]
#[plugin_fn]
pub fn shutdown(_input: String) -> FnResult<String> {
    Ok(json!({ "ok": true }).to_string())
}

/// The `{ "hook", "payload" }` envelope core passes to `handle`.
#[derive(Debug, Deserialize)]
struct HookCall {
    hook: String,
    #[serde(default)]
    payload: Value,
}

/// The `mcp.tool.invoke` payload: which tool, its arguments, and the trusted
/// caller context (echoed for the plugin's own use — host functions re-derive
/// scope independently, so this is informational here).
#[derive(Debug, Default, Deserialize)]
struct InvokePayload {
    #[serde(default)]
    tool: String,
    #[serde(default)]
    arguments: Value,
    #[serde(default)]
    context: InvokeContext,
}

#[derive(Debug, Default, Deserialize)]
struct InvokeContext {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    #[serde(rename = "projectId", default)]
    project_id: Option<String>,
}

/// `handle` — dispatch on hook. For `mcp.tool.invoke`, run the named tool and
/// return its result as a `Verdict::Allow` payload (core wraps it as the tool's
/// content). For `http.request.before`, serve the experts page.
#[cfg(target_arch = "wasm32")]
#[plugin_fn]
pub fn handle(input: String) -> FnResult<String> {
    let call: HookCall = serde_json::from_str(&input)?;
    match call.hook.as_str() {
        "mcp.tool.invoke" => Ok(handle_invoke(call.payload)),
        "http.request.before" => Ok(serve_http(call.payload)),
        "http.request.authed" => Ok(serve_authed(call.payload)),
        "session.user.answer" => Ok(handle_user_answer(call.payload)),
        _ => Ok(json!({ "verdict": "skip" }).to_string()),
    }
}

/// Dispatch an `mcp.tool.invoke` to the right tool. Every tool returns a JSON
/// `Value`; a tool-level failure is returned as an `{"error": ...}` value
/// (surfaced to the calling agent as the tool result), while an unknown tool —
/// which shouldn't happen, since core only routes our declared names here — is
/// a `Cancel`.
#[cfg(target_arch = "wasm32")]
fn handle_invoke(payload: Value) -> String {
    let p: InvokePayload = match serde_json::from_value(payload) {
        Ok(p) => p,
        Err(e) => return cancel(format!("malformed invoke payload: {e}")),
    };
    let result = match p.tool.as_str() {
        "spin_up_experts" => spin_up_experts(&p.arguments),
        "list_experts" => list_experts(),
        "ask_expert" => ask_expert(&p.arguments, &p.context),
        "pm_record_decision" => pm_record_decision(&p.arguments, &p.context),
        "pm_check_decisions" => pm_check_decisions(&p.arguments, &p.context),
        "pm_escalate_to_user" => pm_escalate_to_user(&p.arguments, &p.context),
        other => return cancel(format!("experts plugin does not provide tool '{other}'")),
    };
    let value = result.unwrap_or_else(|e| json!({ "error": e }));
    allow(value)
}

/// `session.user.answer` notification: a user just answered a worker's question.
/// Feed the readable Q&A to the project's question expert(s) so future workers
/// don't re-ask. Core fires this under the answering user's authority, so we may
/// resume any of this plugin's question-expert sessions (the `session_dispatch`
/// permission gate passes under user authority). Payload:
/// `{ "asker_session_id", "project_id", "qa_text" }`. The verdict is ignored by
/// core — this is a one-way notification — so we just report how many experts
/// were fed for logging/testing.
#[cfg(target_arch = "wasm32")]
fn handle_user_answer(payload: Value) -> String {
    let project_id = payload
        .get("project_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let qa_text = payload.get("qa_text").and_then(|v| v.as_str()).unwrap_or("");
    if project_id.is_empty() || qa_text.trim().is_empty() {
        return json!({ "verdict": "skip" }).to_string();
    }

    let experts = match load_experts(false) {
        Ok(e) => e,
        // A read failure here must not look like a cancel of the user's answer
        // (core ignores the verdict regardless); skip quietly.
        Err(_) => return json!({ "verdict": "skip" }).to_string(),
    };

    let msg = format!(
        "[Knowledge update] The user just answered a worker's question in this \
         project. Record this so future workers don't have to ask the same thing \
         again:\n\n{qa_text}"
    );
    let mut fed = 0u32;
    for e in &experts {
        if e.meta.kind != "question" {
            continue;
        }
        if e.session.get("project_id").and_then(|v| v.as_str()) != Some(project_id) {
            continue;
        }
        if let Some(id) = e.session.get("id").and_then(|v| v.as_str()) {
            let _ = host_call("peckboard_resume_session", || unsafe {
                peckboard_resume_session(json!({ "session_id": id, "text": msg }).to_string())
            });
            fed += 1;
        }
    }
    allow(json!({ "fed": fed }))
}

// ── Tool: list_experts ────────────────────────────────────────────────

/// One expert session this plugin manages, paired with its metadata.
struct ExpertSession {
    session: Value,
    meta: ExpertMeta,
}

/// Load the expert sessions visible to the caller (host filters to this
/// plugin's owned + caller-visible sessions). Sessions whose metadata doesn't
/// parse as an [`ExpertMeta`] with a `kind` are skipped.
#[cfg(target_arch = "wasm32")]
fn load_experts(project_only: bool) -> Result<Vec<ExpertSession>, String> {
    let out = host_call("peckboard_list_sessions", || unsafe {
        peckboard_list_sessions(json!({ "project_only": project_only }).to_string())
    })?;
    let mut experts = Vec::new();
    if let Some(items) = out.get("sessions").and_then(|s| s.as_array()) {
        for item in items {
            let meta: ExpertMeta = item
                .get("meta")
                .and_then(|m| serde_json::from_value(m.clone()).ok())
                .unwrap_or_default();
            if meta.kind.is_empty() {
                continue; // a session this plugin marked for something else
            }
            experts.push(ExpertSession {
                session: item.get("session").cloned().unwrap_or(Value::Null),
                meta,
            });
        }
    }
    Ok(experts)
}

#[cfg(target_arch = "wasm32")]
fn list_experts() -> Result<Value, String> {
    let experts = load_experts(false)?;
    let out: Vec<Value> = experts
        .iter()
        .map(|e| {
            let s = &e.session;
            json!({
                "session_id": s.get("id"),
                "name": s.get("name"),
                "expert_kind": e.meta.kind,
                "knowledge_area": e.meta.area,
                "knowledge_summary": truncate(&e.meta.summary, SUMMARY_LIST_CAP),
                "scope_path": e.meta.scope_path,
                "project_id": s.get("project_id"),
                "is_permanent": e.meta.permanent,
                "last_activity": s.get("last_activity"),
            })
        })
        .collect();
    Ok(json!({ "experts": out }))
}

// ── Tool: ask_expert ──────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
struct AskArgs {
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    expert_id: Option<String>,
    #[serde(default)]
    area: Option<String>,
    #[serde(default)]
    answer: Option<String>,
    #[serde(default)]
    reply_to_session_id: Option<String>,
}

#[cfg(target_arch = "wasm32")]
fn ask_expert(args: &Value, ctx: &InvokeContext) -> Result<Value, String> {
    let a: AskArgs = serde_json::from_value(args.clone())
        .map_err(|e| format!("invalid ask_expert arguments: {e}"))?;

    // Reply mode: an expert delivering its answer back to the asker.
    if let (Some(answer), Some(reply_to)) = (a.answer.as_deref(), a.reply_to_session_id.as_deref())
    {
        let msg = format!("[Expert answer]\n\n{answer}");
        host_call("peckboard_resume_session", || unsafe {
            peckboard_resume_session(json!({ "session_id": reply_to, "text": msg }).to_string())
        })?;
        return Ok(json!({ "delivered": true, "reply_to_session_id": reply_to }));
    }

    let question = a
        .question
        .as_deref()
        .filter(|q| !q.trim().is_empty())
        .ok_or("question is required (or provide answer + reply_to_session_id to reply)")?;

    let experts = load_experts(false)?;
    if experts.is_empty() {
        return Err("no experts are available in your scope; run spin_up_experts first".into());
    }
    // The "pm" shorthand resolves to the project's PM expert (kind == "pm").
    let target = if is_pm_hint(a.expert_id.as_deref()) || is_pm_hint(a.area.as_deref()) {
        experts
            .iter()
            .find(|e| e.meta.kind == "pm")
            .ok_or("no PM expert found in your scope; run spin_up_experts first")?
    } else {
        resolve_expert(&experts, a.expert_id.as_deref(), a.area.as_deref())
            .ok_or("no matching expert found in your scope")?
    };
    let target_id = target
        .session
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("resolved expert has no id")?;

    let msg = format!(
        "[Consultation from session {asker}]\n\n{question}\n\nReply with ask_expert: set `answer` and `reply_to_session_id` = \"{asker}\".",
        asker = ctx.session_id,
    );
    host_call("peckboard_resume_session", || unsafe {
        peckboard_resume_session(json!({ "session_id": target_id, "text": msg }).to_string())
    })?;

    Ok(json!({
        "delivered": true,
        "expert_id": target_id,
        "area": target.meta.area,
        "expert_kind": target.meta.kind,
        "question": question,
    }))
}

/// Pick the expert to consult: an explicit `expert_id` (must be in scope), else
/// the best `area` match (substring of area/scope, case-insensitive), else the
/// most recently active expert as a fallback.
fn resolve_expert<'a>(
    experts: &'a [ExpertSession],
    expert_id: Option<&str>,
    area: Option<&str>,
) -> Option<&'a ExpertSession> {
    if let Some(id) = expert_id.map(str::trim).filter(|s| !s.is_empty()) {
        return experts
            .iter()
            .find(|e| e.session.get("id").and_then(|v| v.as_str()) == Some(id));
    }
    if let Some(hint) = area.map(str::trim).filter(|s| !s.is_empty()) {
        let needle = hint.to_ascii_lowercase();
        if let Some(found) = experts.iter().find(|e| {
            e.meta.area.to_ascii_lowercase().contains(&needle)
                || e.meta.scope_path.to_ascii_lowercase().contains(&needle)
        }) {
            return Some(found);
        }
    }
    // Fallback: the first (host returns newest-activity first).
    experts.first()
}

fn is_pm_hint(s: Option<&str>) -> bool {
    matches!(
        s.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
        Some("pm")
    )
}

// ── PM expert: the project-decision store ─────────────────────────────
//
// The PM expert is the durable store of project-direction / business-logic
// decisions. Decisions live in this plugin's document store (collection
// `pm_decisions`), keyed by a generated id; the one-shot user authorizations
// that gate *superseding* an existing decision live in collection `pm_grants`
// (one count per project). Both replace core's `pm_decisions` table and the
// in-memory `PmUserAuthorizations`.

/// Document-store collection for PM decisions.
const PM_DECISIONS: &str = "pm_decisions";
/// Document-store collection for per-project supersession grants.
const PM_GRANTS: &str = "pm_grants";

/// One PM decision (or pending question) as stored. `answer` is `None` while a
/// question is pending; `status` is `"pending"` | `"answered"` | `"superseded"`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PmDecision {
    id: String,
    project_id: String,
    question: String,
    #[serde(default)]
    answer: Option<String>,
    status: String,
    #[serde(default)]
    superseded_by: Option<String>,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    answered_at: Option<i64>,
    #[serde(default)]
    asked_by: Option<String>,
}

/// Active = answered and not superseded — the set `pm_check_decisions` returns.
fn pm_is_active(d: &PmDecision) -> bool {
    d.status == "answered"
}

/// Case-insensitive match of `keywords` against a decision's question + answer.
/// An empty keyword list matches everything (a bad keyword never hides a
/// relevant decision — the caller falls back to the full set).
fn pm_matches_keywords(d: &PmDecision, keywords: &[String]) -> bool {
    if keywords.is_empty() {
        return true;
    }
    let hay = format!(
        "{} {}",
        d.question.to_ascii_lowercase(),
        d.answer.as_deref().unwrap_or("").to_ascii_lowercase()
    );
    keywords
        .iter()
        .any(|k| hay.contains(&k.trim().to_ascii_lowercase()))
}

/// Narrow `active` decisions by `keywords`, returning their compact JSON. A
/// non-matching keyword set falls back to the full active set so a bad keyword
/// can never hide a relevant decision.
fn pm_filter_decisions(active: &[PmDecision], keywords: &[String]) -> Vec<Value> {
    let narrowed: Vec<&PmDecision> = active
        .iter()
        .filter(|d| pm_matches_keywords(d, keywords))
        .collect();
    if narrowed.is_empty() {
        active.iter().map(pm_decision_json).collect()
    } else {
        narrowed.into_iter().map(pm_decision_json).collect()
    }
}

/// The compact JSON shape returned to callers (mirrors core's `decision_json`:
/// `title`/`decision`/`decided_at`).
fn pm_decision_json(d: &PmDecision) -> Value {
    json!({
        "id": d.id,
        "title": d.question,
        "decision": d.answer,
        "status": d.status,
        "decided_at": d.answered_at.unwrap_or(d.created_at),
    })
}

#[derive(Debug, Default, Deserialize)]
struct PmRecordArgs {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    decision: Option<String>,
    #[serde(default)]
    supersedes_decision_id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PmCheckArgs {
    #[serde(default)]
    topic_keywords: Vec<String>,
    #[serde(default)]
    project_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PmEscalateArgs {
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    asking_session_id: Option<String>,
}

/// `pm_check_decisions` — return the caller project's active decisions
/// (optionally keyword-narrowed). Synchronous; consults no expert.
#[cfg(target_arch = "wasm32")]
fn pm_check_decisions(args: &Value, ctx: &InvokeContext) -> Result<Value, String> {
    let a: PmCheckArgs = serde_json::from_value(args.clone())
        .map_err(|e| format!("invalid pm_check_decisions arguments: {e}"))?;
    let project = resolve_pm_project(a.project_id.as_deref(), ctx)?;
    let active: Vec<PmDecision> = pm_list_decisions()?
        .into_iter()
        .filter(|d| d.project_id == project && pm_is_active(d))
        .collect();
    Ok(json!({ "decisions": pm_filter_decisions(&active, &a.topic_keywords) }))
}

/// `pm_record_decision` — ADD a decision, or (PM expert + user authorization
/// only) SUPERSEDE an existing one.
#[cfg(target_arch = "wasm32")]
fn pm_record_decision(args: &Value, ctx: &InvokeContext) -> Result<Value, String> {
    let a: PmRecordArgs = serde_json::from_value(args.clone())
        .map_err(|e| format!("invalid pm_record_decision arguments: {e}"))?;
    let title = a
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("title is required")?
        .to_string();
    let decision = a
        .decision
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("decision is required")?
        .to_string();
    let project = resolve_pm_project(a.project_id.as_deref(), ctx)?;
    let now = now_ms();

    let new = PmDecision {
        id: gen_id(),
        project_id: project.clone(),
        question: title,
        answer: Some(decision),
        status: "answered".into(),
        superseded_by: None,
        created_at: now,
        answered_at: Some(now),
        asked_by: Some(ctx.session_id.clone()),
    };

    if let Some(old_id) = a
        .supersedes_decision_id
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        // Supersession is restricted to the PM expert acting on a consumed
        // one-shot user authorization.
        if !caller_is_pm_expert(&project, ctx)? {
            return Err("only the PM expert may supersede a decision".into());
        }
        let mut old = pm_get_decision(old_id)?
            .filter(|d| d.project_id == project)
            .ok_or("decision to supersede not found in this project")?;
        if old.status != "answered" {
            return Err("only an answered decision can be superseded".into());
        }
        if !pm_consume_grant(&project)? {
            return Err(
                "no outstanding user authorization to supersede a decision; escalate to the user first"
                    .into(),
            );
        }
        old.status = "superseded".into();
        old.superseded_by = Some(new.id.clone());
        pm_put_decision(&old)?;
        pm_put_decision(&new)?;
    } else {
        pm_put_decision(&new)?;
        // Notify the project's PM expert that another session recorded a
        // decision (best-effort; skipped when the recorder IS the PM expert).
        if !caller_is_pm_expert(&project, ctx).unwrap_or(false) {
            if let Some(pm_id) = pm_expert_id(&project)? {
                let msg = format!(
                    "[PM decision recorded by session {who}]\n\n{title}\n\n{dec}",
                    who = ctx.session_id,
                    title = new.question,
                    dec = new.answer.as_deref().unwrap_or(""),
                );
                let _ = host_call("peckboard_resume_session", || unsafe {
                    peckboard_resume_session(
                        json!({ "session_id": pm_id, "text": msg }).to_string(),
                    )
                });
            }
        }
    }
    Ok(json!({ "decision": pm_decision_json(&new) }))
}

/// `pm_escalate_to_user` — PM expert only: park a decision question as PENDING
/// for the user to answer (the UI surfaces it).
#[cfg(target_arch = "wasm32")]
fn pm_escalate_to_user(args: &Value, ctx: &InvokeContext) -> Result<Value, String> {
    let a: PmEscalateArgs = serde_json::from_value(args.clone())
        .map_err(|e| format!("invalid pm_escalate_to_user arguments: {e}"))?;
    let question = a
        .question
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("question is required")?
        .to_string();
    // The escalation is project-scoped via the caller's context.
    let project = resolve_pm_project(None, ctx)?;
    if !caller_is_pm_expert(&project, ctx)? {
        return Err("only the project's PM expert may escalate to the user".into());
    }
    let pending = PmDecision {
        id: gen_id(),
        project_id: project.clone(),
        question,
        answer: None,
        status: "pending".into(),
        superseded_by: None,
        created_at: now_ms(),
        answered_at: None,
        asked_by: a.asking_session_id,
    };
    pm_put_decision(&pending)?;
    let pending_count = pm_list_decisions()?
        .iter()
        .filter(|d| d.project_id == project && d.status == "pending")
        .count();
    Ok(json!({ "pending_id": pending.id, "pending_count": pending_count }))
}

// ── PM plumbing (store, id, time, scope) ──────────────────────────────

/// Resolve the PM project: the caller's project context is authoritative; an
/// explicit `project_id` is only honored for an unscoped caller, and a
/// conflicting one is rejected (mirrors core's `resolve_pm_project`).
#[cfg(target_arch = "wasm32")]
fn resolve_pm_project(arg_project: Option<&str>, ctx: &InvokeContext) -> Result<String, String> {
    match (ctx.project_id.as_deref(), arg_project) {
        (Some(p), Some(a)) if p != a => {
            Err("project_id does not match the calling session's project".into())
        }
        (Some(p), _) => Ok(p.to_string()),
        (None, Some(a)) if !a.trim().is_empty() => Ok(a.trim().to_string()),
        _ => Err("no project context; pass project_id from an unscoped session".into()),
    }
}

/// The session id of the project's PM expert (kind == "pm"), if the plugin
/// manages one the caller can see.
#[cfg(target_arch = "wasm32")]
fn pm_expert_id(project: &str) -> Result<Option<String>, String> {
    Ok(load_experts(false)?
        .into_iter()
        .find(|e| {
            e.meta.kind == "pm"
                && e.session.get("project_id").and_then(|v| v.as_str()) == Some(project)
        })
        .and_then(|e| {
            e.session
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        }))
}

/// Whether the calling session IS the project's PM expert.
#[cfg(target_arch = "wasm32")]
fn caller_is_pm_expert(project: &str, ctx: &InvokeContext) -> Result<bool, String> {
    Ok(pm_expert_id(project)?.as_deref() == Some(ctx.session_id.as_str()))
}

#[cfg(target_arch = "wasm32")]
fn pm_put_decision(d: &PmDecision) -> Result<(), String> {
    host_call("peckboard_store_put", || unsafe {
        peckboard_store_put(
            json!({ "collection": PM_DECISIONS, "key": d.id, "data": d }).to_string(),
        )
    })
    .map(|_| ())
}

#[cfg(target_arch = "wasm32")]
fn pm_get_decision(id: &str) -> Result<Option<PmDecision>, String> {
    let out = host_call("peckboard_store_get", || unsafe {
        peckboard_store_get(json!({ "collection": PM_DECISIONS, "key": id }).to_string())
    })?;
    match out.get("value") {
        Some(Value::Null) | None => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("corrupt decision {id}: {e}")),
    }
}

#[cfg(target_arch = "wasm32")]
fn pm_list_decisions() -> Result<Vec<PmDecision>, String> {
    let out = host_call("peckboard_store_list", || unsafe {
        peckboard_store_list(json!({ "collection": PM_DECISIONS }).to_string())
    })?;
    let mut decisions = Vec::new();
    if let Some(items) = out.get("items").and_then(|i| i.as_array()) {
        for item in items {
            if let Some(v) = item.get("value") {
                if let Ok(d) = serde_json::from_value::<PmDecision>(v.clone()) {
                    decisions.push(d);
                }
            }
        }
    }
    Ok(decisions)
}

/// Consume one supersession grant for `project`, returning whether one was
/// available. Grants are issued by the answer HTTP flow (Cutover 2 part 2).
#[cfg(target_arch = "wasm32")]
fn pm_consume_grant(project: &str) -> Result<bool, String> {
    let out = host_call("peckboard_store_get", || unsafe {
        peckboard_store_get(json!({ "collection": PM_GRANTS, "key": project }).to_string())
    })?;
    let count = out.get("value").and_then(|v| v.as_u64()).unwrap_or(0);
    if count == 0 {
        return Ok(false);
    }
    host_call("peckboard_store_put", || unsafe {
        peckboard_store_put(
            json!({ "collection": PM_GRANTS, "key": project, "data": count - 1 }).to_string(),
        )
    })?;
    Ok(true)
}

/// A random 128-bit hex id for a new decision (WASI entropy).
#[cfg(target_arch = "wasm32")]
fn gen_id() -> String {
    let mut buf = [0u8; 16];
    unsafe {
        random_get(buf.as_mut_ptr(), buf.len());
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Current realtime clock in milliseconds (WASI).
#[cfg(target_arch = "wasm32")]
fn now_ms() -> i64 {
    let mut t: u64 = 0;
    unsafe {
        clock_time_get(0, 1, &mut t as *mut u64);
    }
    (t / 1_000_000) as i64
}

// ── Tool: spin_up_experts ─────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
struct SpinUpArgs {
    #[serde(default)]
    max_experts: Option<usize>,
    #[serde(default)]
    scopes: Option<Vec<Value>>,
}

/// A file the host reported under the caller's folder.
#[derive(Debug, Clone, Deserialize)]
struct ProjectFile {
    path: String,
    #[serde(default)]
    size: u64,
}

/// A planned expert slice before any session is created.
struct Partition {
    area: String,
    dirs: Vec<String>,
    files: Vec<ProjectFile>,
    est_bytes: u64,
}

#[cfg(target_arch = "wasm32")]
fn spin_up_experts(args: &Value) -> Result<Value, String> {
    let a: SpinUpArgs = serde_json::from_value(args.clone())
        .map_err(|e| format!("invalid spin_up_experts arguments: {e}"))?;

    let listing = host_call("peckboard_list_project_files", || unsafe {
        peckboard_list_project_files("{}".to_string())
    })?;
    let files: Vec<ProjectFile> = listing
        .get("files")
        .and_then(|f| serde_json::from_value(f.clone()).ok())
        .unwrap_or_default();
    if files.is_empty() {
        return Err("no readable project files found in the caller's folder".into());
    }

    let (partitions, skipped) = match a.scopes {
        Some(scopes) if !scopes.is_empty() => partition_explicit(&files, &scopes),
        _ => {
            let max = a
                .max_experts
                .unwrap_or(DEFAULT_MAX_EXPERTS)
                .clamp(1, MAX_EXPERTS_CAP);
            (partition_auto(&files, max), Vec::new())
        }
    };

    let mut created = Vec::new();
    for part in &partitions {
        if part.files.is_empty() {
            continue;
        }
        // 1) Create the underlying session in the caller's scope.
        let created_session = host_call("peckboard_create_session", || unsafe {
            peckboard_create_session(
                json!({ "name": format!("expert: {}", part.area) }).to_string(),
            )
        })?;
        let session_id = created_session
            .get("session")
            .and_then(|s| s.get("id"))
            .and_then(|v| v.as_str())
            .ok_or("create_session returned no id")?
            .to_string();

        // 2) Tag it as one of our knowledge experts.
        let summary = build_summary(part);
        let meta = ExpertMeta {
            kind: "knowledge".into(),
            area: part.area.clone(),
            scope_path: part.dirs.join(", "),
            summary: summary.clone(),
            permanent: false,
        };
        host_call("peckboard_session_meta_set", || unsafe {
            peckboard_session_meta_set(
                json!({ "session_id": session_id, "data": meta }).to_string(),
            )
        })?;

        // 3) Fire the capture run (fire-and-forget; returns immediately).
        let prompt = build_capture_prompt(part);
        let _ = host_call("peckboard_dispatch_capture", || unsafe {
            peckboard_dispatch_capture(
                json!({ "session_id": session_id, "prompt": prompt }).to_string(),
            )
        });

        created.push(json!({
            "session_id": session_id,
            "area": part.area,
            "scope_path": part.dirs.join(", "),
            "files": part.files.len(),
            "est_bytes": part.est_bytes,
        }));
    }

    if created.is_empty() {
        return Err("no experts were created (every partition was empty)".into());
    }

    // Ensure the caller's project has the permanent QUESTION + PM experts — the
    // durable Q&A store and the project-decision store every session consults.
    // Idempotent: only created if absent.
    let question_expert = ensure_permanent_expert(
        "question",
        "Question Expert",
        "User Q&A",
        "Durable store of answers to questions this project's sessions have asked the user. Consult before asking the user something that may already be settled.",
        Some(QUESTION_EXPERT_PRIMING),
    )?;
    let pm_expert = ensure_permanent_expert(
        "pm",
        "PM Expert",
        "Project Direction",
        "Durable store of project-direction and business-logic decisions. Consult before making a call that affects product direction; record decisions here.",
        None,
    )?;

    Ok(json!({
        "experts": created,
        "skipped": skipped,
        "question_expert": question_expert,
        "pm_expert": pm_expert,
    }))
}

/// Ensure a permanent expert of `kind` exists in the caller's scope, returning
/// its session id. Idempotent — reuses an existing one the plugin manages.
/// Backs the durable QUESTION and PM experts (knowledge experts are ephemeral
/// and created per spin-up instead).
#[cfg(target_arch = "wasm32")]
fn ensure_permanent_expert(
    kind: &str,
    name: &str,
    area: &str,
    summary: &str,
    prime: Option<&str>,
) -> Result<Value, String> {
    if let Some(existing) = load_experts(false)?.iter().find(|e| e.meta.kind == kind) {
        // Already exists — do NOT re-prime (priming is a one-time role setup).
        return Ok(existing.session.get("id").cloned().unwrap_or(Value::Null));
    }
    let created = host_call("peckboard_create_session", || unsafe {
        peckboard_create_session(json!({ "name": name }).to_string())
    })?;
    let session_id = created
        .get("session")
        .and_then(|s| s.get("id"))
        .and_then(|v| v.as_str())
        .ok_or("create_session returned no id")?
        .to_string();
    let meta = ExpertMeta {
        kind: kind.to_string(),
        area: area.to_string(),
        scope_path: String::new(),
        summary: summary.to_string(),
        permanent: true,
    };
    host_call("peckboard_session_meta_set", || unsafe {
        peckboard_session_meta_set(json!({ "session_id": session_id, "data": meta }).to_string())
    })?;
    // Establish the expert's role on creation (fire-and-forget), re-homing the
    // system-prompt framing core used to apply. One-time: only on first create.
    if let Some(prompt) = prime {
        host_call("peckboard_dispatch_capture", || unsafe {
            peckboard_dispatch_capture(
                json!({ "session_id": session_id, "prompt": prompt }).to_string(),
            )
        })?;
    }
    Ok(Value::String(session_id))
}

/// Auto-partition: group files by top-level directory, then bin-pack the
/// (alphabetically ordered, so adjacent/related) groups into a size-balanced
/// set of at most `max` experts.
fn partition_auto(files: &[ProjectFile], max: usize) -> Vec<Partition> {
    // Group by first path segment ("." for root-level files).
    let mut groups: BTreeMap<String, (Vec<ProjectFile>, u64)> = BTreeMap::new();
    for f in files {
        let top = f.path.split('/').next().filter(|s| !s.is_empty());
        let key = match top {
            Some(t) if f.path.contains('/') => t.to_string(),
            _ => ".".to_string(),
        };
        let entry = groups.entry(key).or_default();
        entry.0.push(f.clone());
        entry.1 += f.size.max(1);
    }

    let keys: Vec<String> = groups.keys().cloned().collect();
    let total: u64 = groups.values().map(|(_, b)| *b).sum();
    let desired = ((total / PARTITION_WINDOW_BYTES.max(1)) as usize + 1)
        .clamp(1, max)
        .min(keys.len().max(1));

    // Greedy contiguous split balancing bytes per bin.
    let target = (total / desired as u64).max(1);
    let mut parts: Vec<Partition> = Vec::new();
    let mut cur_dirs: Vec<String> = Vec::new();
    let mut cur_files: Vec<ProjectFile> = Vec::new();
    let mut cur_bytes: u64 = 0;
    for (i, key) in keys.iter().enumerate() {
        let (gfiles, gbytes) = groups.get(key).cloned().unwrap_or_default();
        cur_dirs.push(key.clone());
        cur_files.extend(gfiles);
        cur_bytes += gbytes;
        let remaining_bins = desired.saturating_sub(parts.len() + 1);
        let remaining_keys = keys.len() - (i + 1);
        // Close this bin when it's reached its target share and there are still
        // enough remaining groups to fill the remaining bins.
        if (cur_bytes >= target && remaining_bins > 0 && remaining_keys >= remaining_bins)
            || remaining_keys == 0
        {
            parts.push(Partition {
                area: area_label(&cur_dirs),
                dirs: std::mem::take(&mut cur_dirs),
                files: std::mem::take(&mut cur_files),
                est_bytes: cur_bytes,
            });
            cur_bytes = 0;
        }
    }
    parts
}

/// Explicit partition: each scope entry (a path or array of paths) becomes one
/// expert covering the files under those path prefixes. Entries that match no
/// files are reported in `skipped`.
fn partition_explicit(files: &[ProjectFile], scopes: &[Value]) -> (Vec<Partition>, Vec<Value>) {
    let mut parts = Vec::new();
    let mut skipped = Vec::new();
    for entry in scopes {
        let prefixes: Vec<String> = match entry {
            Value::String(s) => vec![s.clone()],
            Value::Array(arr) => arr
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect(),
            _ => Vec::new(),
        };
        let clean: Vec<String> = prefixes
            .into_iter()
            .map(|p| p.trim_matches('/').to_string())
            .filter(|p| !p.is_empty() && !p.contains(".."))
            .collect();
        if clean.is_empty() {
            skipped.push(entry.clone());
            continue;
        }
        let matched: Vec<ProjectFile> = files
            .iter()
            .filter(|f| clean.iter().any(|p| path_under(&f.path, p)))
            .cloned()
            .collect();
        if matched.is_empty() {
            skipped.push(json!(clean));
            continue;
        }
        let est = matched.iter().map(|f| f.size.max(1)).sum();
        parts.push(Partition {
            area: area_label(&clean),
            dirs: clean,
            files: matched,
            est_bytes: est,
        });
    }
    (parts, skipped)
}

/// Whether `path` is `prefix` itself or lives beneath it (segment-aware, so
/// `src/a` does not match prefix `src/ab`).
fn path_under(path: &str, prefix: &str) -> bool {
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

/// A short human label for a slice: the basenames of its dirs, joined with `+`.
fn area_label(dirs: &[String]) -> String {
    let names: Vec<String> = dirs
        .iter()
        .map(|d| {
            d.rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(d)
                .to_string()
        })
        .collect();
    if names.is_empty() {
        "project".to_string()
    } else {
        names.join(" + ")
    }
}

/// A readable summary of a slice: file count, total size, and a language
/// breakdown (by extension), plus a few representative files.
fn build_summary(part: &Partition) -> String {
    let mut langs: BTreeMap<String, usize> = BTreeMap::new();
    for f in &part.files {
        let lang = lang_for_path(&f.path);
        *langs.entry(lang.to_string()).or_default() += 1;
    }
    let mut lang_list: Vec<(String, usize)> = langs.into_iter().collect();
    lang_list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let langs_str = lang_list
        .iter()
        .take(6)
        .map(|(l, n)| format!("{l} {n}"))
        .collect::<Vec<_>>()
        .join(", ");
    let top: Vec<&str> = part
        .files
        .iter()
        .take(20)
        .map(|f| f.path.as_str())
        .collect();
    format!(
        "Knowledge expert for {area} ({dirs}). {n} files, ~{kb} KB. Languages: {langs}. Sample: {top}.",
        area = part.area,
        dirs = part.dirs.join(", "),
        n = part.files.len(),
        kb = part.est_bytes / 1024,
        langs = if langs_str.is_empty() {
            "n/a".into()
        } else {
            langs_str
        },
        top = top.join(", "),
    )
}

/// The system-style prompt handed to a freshly-spun expert: read your scope and
/// internalize it so you can answer consultations later.
fn build_capture_prompt(part: &Partition) -> String {
    format!(
        "You are a knowledge expert for {area}. Your scope is: {dirs}. Eagerly read the files in your scope now and build a durable understanding of how this code works — its responsibilities, key types, control flow, and gotchas — so you can answer questions about it later via ask_expert. Do not modify anything; you are read-only.",
        area = part.area,
        dirs = part.dirs.join(", "),
    )
}

/// Map a file path to a coarse language label by extension.
fn lang_for_path(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "rs" => "Rust",
        "ts" | "tsx" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "py" => "Python",
        "go" => "Go",
        "java" => "Java",
        "rb" => "Ruby",
        "c" | "h" => "C",
        "cpp" | "cc" | "hpp" => "C++",
        "cs" => "C#",
        "css" | "scss" => "CSS",
        "html" => "HTML",
        "json" => "JSON",
        "toml" => "TOML",
        "yaml" | "yml" => "YAML",
        "md" => "Markdown",
        "sh" | "bash" => "Shell",
        "sql" => "SQL",
        _ => "Other",
    }
}

// ── HTTP: the served Experts page ─────────────────────────────────────

/// The plugin-served HTTP request (mirrors core's `PluginHttpRequest`).
#[derive(Debug, Default, Deserialize)]
struct HttpRequest {
    #[serde(default)]
    method: String,
    #[serde(default)]
    path: String,
}

/// Serve the Experts page. NOTE: `http.request.before` runs *without* an MCP
/// invocation context, so the page cannot call the scoped session host
/// functions — the live, data-driven page (calling core's authenticated
/// `/api/experts` from the iframe) is wired in the frontend task. For now this
/// is a self-contained placeholder so the sidebar entry resolves.
fn serve_http(payload: Value) -> String {
    let req: HttpRequest = serde_json::from_value(payload).unwrap_or_default();
    if req.method.eq_ignore_ascii_case("GET") && req.path == "/plugin-api/v1/experts" {
        return html_response(200, EXPERTS_PAGE);
    }
    html_response(
        404,
        "<!doctype html><title>Not found</title><p>Not found.</p>",
    )
}

const EXPERTS_PAGE: &str = "<!doctype html><html><head><meta charset=\"utf-8\">\
<title>Experts</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#222}h1{font-size:1.4rem}</style>\
</head><body><h1>Experts</h1>\
<p>Knowledge experts are created with the <code>spin_up_experts</code> tool and consulted via <code>ask_expert</code>.</p>\
<p>The live experts list renders here once the frontend page is wired.</p>\
</body></html>";

// ── Authenticated app-UI endpoints (/api/plugin-ui/*) ─────────────────
//
// Served via `http.request.authed` under the logged-in user's authority, so
// the scoped host functions (list_sessions, resume_session, store_*) act on the
// user's behalf — that is what lets the answer flow grant a supersession
// authorization AND resume the PM expert, which the unauthenticated
// `/plugin-api` surface cannot do. Core's React Experts/PM views call these.

#[derive(Debug, Default, Deserialize)]
struct PmAnswerBody {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    question_id: Option<String>,
    #[serde(default)]
    answer: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PmEditBody {
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    answer: Option<String>,
}

#[cfg(target_arch = "wasm32")]
fn serve_authed(payload: Value) -> String {
    let method = payload
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let query = payload.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let body = payload.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let params = payload.get("params").cloned().unwrap_or(Value::Null);

    let result: Result<Value, String> = match (method.as_str(), path) {
        ("GET", "/api/plugin-ui/experts") => list_experts(),
        ("GET", "/api/plugin-ui/pm/decisions") => pm_decisions_view(query),
        ("POST", "/api/plugin-ui/pm/answer") => pm_answer(body),
        ("PUT", p) if p.starts_with("/api/plugin-ui/pm/decisions/") => {
            let id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
            pm_edit(id, body)
        }
        _ => return json_response(404, json!({ "error": "not found" })),
    };
    match result {
        Ok(v) => json_response(200, v),
        Err(e) => json_response(400, json!({ "error": e })),
    }
}

/// A project's PM decision board: active decisions + still-pending questions.
#[cfg(target_arch = "wasm32")]
fn pm_decisions_view(query: &str) -> Result<Value, String> {
    let project = query_param(query, "project_id").ok_or("project_id is required")?;
    let all = pm_list_decisions()?;
    let decisions: Vec<Value> = all
        .iter()
        .filter(|d| d.project_id == project && pm_is_active(d))
        .map(pm_decision_json)
        .collect();
    let pending: Vec<Value> = all
        .iter()
        .filter(|d| d.project_id == project && d.status == "pending")
        .map(pm_decision_json)
        .collect();
    Ok(json!({ "decisions": decisions, "pending": pending }))
}

/// Answer a pending PM question: mark it answered, ISSUE a one-shot supersession
/// authorization for the project, and resume the PM expert with the answer.
#[cfg(target_arch = "wasm32")]
fn pm_answer(body: &str) -> Result<Value, String> {
    let b: PmAnswerBody =
        serde_json::from_str(body).map_err(|e| format!("invalid request body: {e}"))?;
    let project = b
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("project_id is required")?
        .to_string();
    let qid = b
        .question_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("question_id is required")?;
    let answer = b.answer.unwrap_or_default();

    let mut decision = pm_get_decision(qid)?
        .filter(|d| d.project_id == project)
        .ok_or("pending question not found in this project")?;
    if decision.status != "pending" {
        return Err("question is no longer pending".into());
    }
    decision.answer = Some(answer.clone());
    decision.status = "answered".into();
    decision.answered_at = Some(now_ms());
    pm_put_decision(&decision)?;

    // The user has answered → authorize one supersession by the PM expert.
    pm_issue_grant(&project)?;

    // Deliver the answer to the PM expert so it can act on it now.
    if let Some(pm_id) = pm_expert_id(&project)? {
        let msg = format!(
            "[User answered a pending question]\n\nQ: {q}\nA: {a}\n\nYou now have one authorization to supersede an existing decision if this requires it (pm_record_decision with supersedes_decision_id).",
            q = decision.question,
            a = answer,
        );
        let _ = host_call("peckboard_resume_session", || unsafe {
            peckboard_resume_session(json!({ "session_id": pm_id, "text": msg }).to_string())
        });
    }

    let pending_count = pm_list_decisions()?
        .iter()
        .filter(|d| d.project_id == project && d.status == "pending")
        .count();
    Ok(json!({ "decision": pm_decision_json(&decision), "pending_count": pending_count }))
}

/// Directly edit/supersede a decision (the user editing it in the UI — no grant
/// needed, the user has authority). Marks the old one superseded and writes a
/// new answered decision.
#[cfg(target_arch = "wasm32")]
fn pm_edit(id: &str, body: &str) -> Result<Value, String> {
    if id.trim().is_empty() {
        return Err("decision id is required".into());
    }
    let b: PmEditBody =
        serde_json::from_str(body).map_err(|e| format!("invalid request body: {e}"))?;
    let answer = b
        .answer
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("answer is required")?
        .to_string();
    let mut old = pm_get_decision(id.trim())?.ok_or("decision not found")?;
    if old.status != "answered" {
        return Err("only an answered decision can be edited".into());
    }
    let now = now_ms();
    let new = PmDecision {
        id: gen_id(),
        project_id: old.project_id.clone(),
        question: b.question.unwrap_or_else(|| old.question.clone()),
        answer: Some(answer),
        status: "answered".into(),
        superseded_by: None,
        created_at: now,
        answered_at: Some(now),
        asked_by: old.asked_by.clone(),
    };
    old.status = "superseded".into();
    old.superseded_by = Some(new.id.clone());
    pm_put_decision(&old)?;
    pm_put_decision(&new)?;
    Ok(json!({ "decision": pm_decision_json(&new) }))
}

/// Issue (increment) one supersession authorization for `project`.
#[cfg(target_arch = "wasm32")]
fn pm_issue_grant(project: &str) -> Result<(), String> {
    let out = host_call("peckboard_store_get", || unsafe {
        peckboard_store_get(json!({ "collection": PM_GRANTS, "key": project }).to_string())
    })?;
    let count = out.get("value").and_then(|v| v.as_u64()).unwrap_or(0);
    host_call("peckboard_store_put", || unsafe {
        peckboard_store_put(
            json!({ "collection": PM_GRANTS, "key": project, "data": count + 1 }).to_string(),
        )
    })
    .map(|_| ())
}

/// Extract `name`'s value from a `&`-separated query string (no decoding beyond
/// the simple `key=value` split needed here).
fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

/// Wrap a JSON value as a same-origin `Verdict::Allow` HTTP response.
fn json_response(status: u16, value: Value) -> String {
    json!({
        "verdict": "allow",
        "payload": {
            "status": status,
            "headers": { "content-type": "application/json" },
            "body": value.to_string(),
        }
    })
    .to_string()
}

// ── Plumbing: host calls, verdicts, helpers ───────────────────────────

/// Call a host function and parse its JSON response, surfacing an
/// `{"error": ...}` envelope (or a trap) as an `Err(String)`.
#[cfg(target_arch = "wasm32")]
fn host_call(name: &str, f: impl FnOnce() -> Result<String, Error>) -> Result<Value, String> {
    let raw = f().map_err(|e| format!("{name} host call failed: {e}"))?;
    let v: Value =
        serde_json::from_str(&raw).map_err(|e| format!("{name} returned invalid JSON: {e}"))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    Ok(v)
}

/// A `Verdict::Allow` carrying `value` as the tool result payload.
fn allow(value: Value) -> String {
    json!({ "verdict": "allow", "payload": value }).to_string()
}

/// A `Verdict::Cancel` with a reason (maps to an MCP tool error in core).
fn cancel(reason: impl Into<String>) -> String {
    json!({ "verdict": "cancel", "reason": reason.into() }).to_string()
}

/// Truncate `s` to at most `max` chars, appending an ellipsis when clipped.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Wrap an HTML body as a `Verdict::Allow` HTTP response.
fn html_response(status: u16, body: &str) -> String {
    json!({
        "verdict": "allow",
        "payload": {
            "status": status,
            "headers": { "content-type": "text/html; charset=utf-8" },
            "body": body,
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pf(path: &str, size: u64) -> ProjectFile {
        ProjectFile {
            path: path.to_string(),
            size,
        }
    }

    #[test]
    fn auto_partition_groups_and_caps() {
        let files = vec![
            pf("src/auth/a.rs", 10_000),
            pf("src/auth/b.rs", 10_000),
            pf("src/ws/c.rs", 30_000),
            pf("web/x.ts", 40_000),
            pf("web/y.ts", 40_000),
            pf("docs/r.md", 1_000),
            pf("README.md", 500), // root-level → "." group
        ];
        let parts = partition_auto(&files, 3);
        assert!(
            !parts.is_empty() && parts.len() <= 3,
            "got {} parts",
            parts.len()
        );
        // Every file lands in exactly one partition.
        let total: usize = parts.iter().map(|p| p.files.len()).sum();
        assert_eq!(total, files.len());
        // Areas are human labels built from dir basenames.
        assert!(parts.iter().all(|p| !p.area.is_empty()));
    }

    #[test]
    fn explicit_partition_matches_prefixes_and_reports_skips() {
        let files = vec![
            pf("src/auth/a.rs", 1),
            pf("src/ws/c.rs", 1),
            pf("web/x.ts", 1),
        ];
        let scopes = vec![
            json!("src/auth"),
            json!(["src/ws", "web"]),
            json!("does/not/exist"),
        ];
        let (parts, skipped) = partition_explicit(&files, &scopes);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].files.len(), 1); // src/auth/a.rs
        assert_eq!(parts[1].files.len(), 2); // src/ws + web
        assert_eq!(skipped.len(), 1);
        // Segment-aware: "src/a" must not match prefix "src/ab".
        assert!(path_under("src/a/x.rs", "src/a"));
        assert!(!path_under("src/ab/x.rs", "src/a"));
    }

    #[test]
    fn area_label_uses_basenames() {
        assert_eq!(
            area_label(&["src/auth".into(), "src/ws".into()]),
            "auth + ws"
        );
        assert_eq!(area_label(&[".".into()]), ".");
        assert_eq!(area_label(&[]), "project");
    }

    #[test]
    fn resolve_prefers_explicit_then_area_then_fallback() {
        let experts = vec![
            ExpertSession {
                session: json!({ "id": "e1" }),
                meta: ExpertMeta {
                    area: "auth + ws".into(),
                    kind: "knowledge".into(),
                    ..Default::default()
                },
            },
            ExpertSession {
                session: json!({ "id": "e2" }),
                meta: ExpertMeta {
                    area: "frontend".into(),
                    kind: "knowledge".into(),
                    scope_path: "web".into(),
                    ..Default::default()
                },
            },
        ];
        // explicit id wins
        assert_eq!(
            resolve_expert(&experts, Some("e2"), Some("auth"))
                .unwrap()
                .session["id"],
            "e2"
        );
        // area substring match
        assert_eq!(
            resolve_expert(&experts, None, Some("AUTH"))
                .unwrap()
                .session["id"],
            "e1"
        );
        // area matches scope_path too
        assert_eq!(
            resolve_expert(&experts, None, Some("web")).unwrap().session["id"],
            "e2"
        );
        // fallback to first when nothing matches
        assert_eq!(
            resolve_expert(&experts, None, Some("nonsense"))
                .unwrap()
                .session["id"],
            "e1"
        );
    }

    #[test]
    fn truncate_clips_with_ellipsis() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 5), "hello…");
    }

    #[test]
    fn pm_hint_detected() {
        assert!(is_pm_hint(Some("pm")));
        assert!(is_pm_hint(Some(" PM ")));
        assert!(!is_pm_hint(Some("pmexpert")));
        assert!(!is_pm_hint(None));
    }

    fn dec(id: &str, q: &str, a: Option<&str>, status: &str) -> PmDecision {
        PmDecision {
            id: id.into(),
            project_id: "p1".into(),
            question: q.into(),
            answer: a.map(str::to_string),
            status: status.into(),
            superseded_by: None,
            created_at: 100,
            answered_at: a.map(|_| 200),
            asked_by: None,
        }
    }

    #[test]
    fn pm_active_and_keyword_filter() {
        assert!(pm_is_active(&dec(
            "d1",
            "auth",
            Some("use tokens"),
            "answered"
        )));
        assert!(!pm_is_active(&dec("d2", "x", Some("y"), "superseded")));
        assert!(!pm_is_active(&dec("d3", "x", None, "pending")));

        let active = vec![
            dec("d1", "Auth model", Some("use JWT tokens"), "answered"),
            dec("d2", "Billing", Some("monthly only"), "answered"),
        ];
        // No keywords → full set.
        assert_eq!(pm_filter_decisions(&active, &[]).len(), 2);
        // Matching keyword narrows.
        let only_auth = pm_filter_decisions(&active, &["token".into()]);
        assert_eq!(only_auth.len(), 1);
        assert_eq!(only_auth[0]["title"], "Auth model");
        // Non-matching keyword falls back to the full set (never hides).
        assert_eq!(pm_filter_decisions(&active, &["nonsense".into()]).len(), 2);
    }

    #[test]
    fn pm_decision_json_shape() {
        let v = pm_decision_json(&dec("d1", "Title here", Some("The decision"), "answered"));
        assert_eq!(v["id"], "d1");
        assert_eq!(v["title"], "Title here");
        assert_eq!(v["decision"], "The decision");
        assert_eq!(v["status"], "answered");
        assert_eq!(v["decided_at"], 200); // answered_at wins over created_at
        // A pending row has no decision and falls back to created_at.
        let p = pm_decision_json(&dec("d2", "Q?", None, "pending"));
        assert_eq!(p["decision"], Value::Null);
        assert_eq!(p["decided_at"], 100);
    }
}
