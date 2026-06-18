# Experts → Plugin Migration — Design & Plan

> **Status:** Design for review. **No core changes have been made.** This repo is a
> scaffold only. Nothing is pushed. Read §11 (Open Questions) — several decisions
> are yours before implementation starts.

## 1. Objective

Move the **entire** experts feature out of `peckboard` core into this WASM plugin
(`PeckBoard/experts`): the 7 MCP tools, the expert/PM data, the lifecycle
services, and the **left-sidebar entry**. Core keeps only **generic**
plugin-platform capabilities — no experts-specific logic remains in core.

## 2. Principles (confirmed)

- **Generic in core, specific in the plugin.** Core gains generic "a plugin can
  provide an MCP tool", "a plugin can add a sidebar button", and the host
  functions a feature like this needs — never `expert`-shaped code.
- **Reuse the existing approval model.** Per-plugin interactive approval at
  startup; plugin inert until approved. New **permissions** plug into that same
  prompt; the plugin stays inert until its permission set is approved.
- **Preserve scope safety.** Core's MCP scope proof-tokens (`ScopedProjectId`,
  folder boundary) must not be weakened by routing a tool through a plugin. Host
  functions re-verify scope server-side against the invoking session.
- **No data loss.** Follows the repo's migration rules: add new tables, backfill,
  stop *reading* old columns — never drop in a forward migration.

## 3. Current footprint (what moves)

| Area | Files | ~LOC |
| --- | --- | --- |
| Backend services | `service/question_expert.rs`, `service/pm_expert.rs`, `service/delivery.rs` | 944 |
| MCP tool handlers | `mcp_server/handlers/{experts,ask_expert,pm_expert}.rs` | 1,793 |
| MCP wiring | `mcp_server/{schemas,context,mod}.rs` (expert tool defs, `ExpertDispatcher`, dispatch), `routes/mcp.rs` | ~300 |
| DB | `sessions` expert columns + `pm_decisions` table, 2 CRUD modules, 2 migrations | ~900 |
| HTTP routes | `/api/experts`, expert bootstrap on project create, Q&A feedback | ~120 |
| Frontend | `ExpertsView.tsx`, `PmExpertView.tsx`, `store/{sessions,pmStore}.ts`, `App.tsx` sidebar + routing, types | ~900 |
| Tests | `tests/*expert*.rs`, `web/e2e/tests/{expert*,pm-expert}.spec.ts` | ~700 |

**7 MCP tools:** `spin_up_experts`, `list_experts`, `ask_expert` (ask + reply
modes), `pm_record_decision`, `pm_check_decisions`, `pm_escalate_to_user`.

## 4. Platform capabilities to add to core (all generic)

### 4.1 Plugin-provided MCP tools

- **Declaration (manifest).** New field:
  ```jsonc
  "mcp_tools": [
    { "name": "spin_up_experts", "title": "Spin up experts",
      "description": "...", "input_schema": { /* JSON Schema */ } }
  ]
  ```
  Static + inspectable at approval time. Maps 1:1 to core's `McpToolDef
  { name, description, input_schema }`.
- **Aggregation.** The MCP `tools/list` becomes `core_tools ∪ active_plugin_tools`.
  Collision rule: a plugin tool name that duplicates a core tool **or** another
  plugin's tool fails load/approval with a clear error (no silent shadowing).
- **Dispatch.** New **terminal** hook `mcp.tool.invoke` (added to `ALLOWED_HOOKS`),
  modeled on `http.request.before`: the plugin **owns** the call.
  `McpToolRegistry::handle_tool_call` checks plugin-owned names first; if matched,
  it dispatches `mcp.tool.invoke` to the owning plugin with
  `{ tool, arguments, context }` and returns the plugin's MCP result (content
  blocks) or maps a `Cancel` to a tool error.
- **Context across the WASM boundary.** The invoke payload carries a
  *serializable* slice of `ToolCallContext`: `session_id`, `project_id`,
  `card_id`, `folder_id`, and the user id. The non-serializable handles
  (`Db`, `Broadcaster`, `ExpertDispatcher`, `pm_authorizations`) are **not**
  passed; the plugin acts back on core through host functions (§4.3), which
  re-derive those handles in-process.
- **Permission gate:** declaring `mcp_tools` requires the `provide_mcp_tools`
  permission (§4.5).

### 4.2 Sidebar contribution

- **Declaration (manifest).** New field:
  ```jsonc
  "sidebar_items": [
    { "id": "experts", "label": "Experts", "icon": "<svg.../>",
      "path": "/plugin-api/v1/experts" }
  ]
  ```
- **Backend.** `/api/plugins` already surfaces active-plugin `ui_panels`; add
  `sidebar_items` to that catalog the same way (active plugins only).
- **Frontend.** The rail in `App.tsx` renders core buttons, then appends
  plugin `sidebar_items` (icon + label). Click opens the plugin page — either a
  full content pane (preferred for experts, which is a primary view) or the
  existing `PluginPanelModal` iframe. Icon: inline SVG supplied by the plugin
  (sandbox-safe) **or** a named entry from a core icon set — **decision in §11**.
- **Badges** (e.g. PM "pending questions" count on the current Experts button):
  not in the first cut. Generic badge channel proposed for a later phase (a
  small polled `/plugin-api` count, or a generic ws "sidebar badge" event).
- **Permission gate:** `contribute_sidebar`.

### 4.3 Host functions the plugin needs (generic, permission-gated)

A WASM plugin reaches core only through host functions. Today 6 exist
(list/create cards, list projects, plugin-settings KV). Experts needs these
**new generic** ones:

| Host fn | Purpose | Permission |
| --- | --- | --- |
| `peckboard_create_session` | Create a (possibly long-lived) session with plugin metadata | `session_write` |
| `peckboard_get_session` / `peckboard_list_sessions` | Read/query sessions, incl. by plugin-meta predicate (§4.4) | `session_read` |
| `peckboard_update_session` | Update plugin-owned session metadata | `session_write` |
| `peckboard_dispatch_capture(session_id, prompt)` | Spawn a capture run on an expert session (maps to `ExpertDispatcher::dispatch_capture`) | `session_dispatch` |
| `peckboard_resume_session(session_id, text)` | Deliver a user message + resume (maps to `resume_session` + `delivery::persist_user_message`) | `session_dispatch` |
| `peckboard_append_event(session_id, kind, data)` | Persist a session event | `event_append` |
| `peckboard_store_{put,get,list,delete}` | Plugin-owned **document store** (beyond the 64 KB settings KV) for PM decisions etc., persisted in a generic core `plugin_data` table keyed by plugin id | `data_store` |
| `peckboard_broadcast(event)` | Push a namespaced ws event to the UI (e.g. "experts changed") | `broadcast` |
| `peckboard_list_project_files` / `peckboard_read_file` | (Only if `spin_up_experts` partitioning stays in the plugin — see §7.3) | `project_files_read` |

These are **generic** — nothing says "expert". `ExpertDispatcher` already proves
the live-dispatch seam is narrow and abstractable; it becomes two host calls.

### 4.4 "Expert-ness" without core columns

Experts today are `sessions` rows with `is_expert`, `expert_kind`,
`knowledge_summary`, `knowledge_area`, `scope_path`, `is_permanent`. To keep
"what is an expert" **plugin-defined**, add a generic, plugin-namespaced session
metadata store:

- New core table `plugin_session_meta(session_id, plugin_id, json)`.
- `create_session` / `update_session` / `list_sessions` host fns read & write it
  and can filter by a JSON predicate.
- Migration backfills the existing expert columns into this blob; core stops
  reading the columns (kept, per migration rules — not dropped).

### 4.5 WASM plugin permissions

- New manifest field `permissions: ["provide_mcp_tools", "session_dispatch", ...]`.
- Extend the existing built-in `Permission` model to a WASM-facing set with the
  variants referenced above. Each host function checks its permission at call
  time and refuses if not granted.
- **Approval UX:** the startup approval prompt already lists hooks (and the
  Settings card already shows permissions for built-ins). Extend the prompt to
  also list the plugin's requested **permissions**; the plugin stays inert until
  both hooks and permissions are approved — same model, no new UX paradigm.

## 5. The experts plugin (this repo)

- All 7 MCP tools declared via `mcp_tools`, dispatched via `mcp.tool.invoke`
  into the plugin's `handle`.
- Expert/PM business logic (question + PM experts, `ask_expert`, partitioning,
  PM decisions, durable `.md` exports) ported to Rust-on-Extism, using host
  functions for DB/session/dispatch/storage.
- Data: expert sessions created via host fns; expert metadata in
  `plugin_session_meta`; PM decisions + authorizations in the plugin document
  store; `.md` exports written via a host fn (or rehydrated from the store).
- Frontend: `ExpertsView` + `PmExpertView` rebuilt as pages the plugin serves at
  `/plugin-api/v1/...`, reached via a `sidebar_items` "Experts" entry. The
  `sessions`/`pmStore` slices move into the plugin's own web bundle.

## 6. What stays in core

Only the generic platform from §4, plus the generic session/provider/event
machinery (experts are still *real* sessions). No experts-specific code.

## 7. Hard parts / feasibility risks

1. **PM authorizations (`AppState` singleton).** The in-memory grant store gating
   PM-decision supersession, plus the core HTTP route that issues grants, must
   move into the plugin's document store and a `/plugin-api` flow. Feasible, real
   work.
2. **Async / timeout model — biggest risk.** WASM `handle` calls are synchronous
   with a **2 s** timeout. `spin_up_experts` does long, concurrent codebase
   gathering (semaphore, 3 concurrent). A WASM tool call can't block on that.
   Design: the tool handler returns quickly after *scheduling* work via
   fire-and-forget host calls (`dispatch_capture`), and core runs the heavy
   concurrency — i.e. the **orchestration stays in core-side host functions**,
   the *policy* (how to partition, what prompts) lives in the plugin. Needs
   careful API design so the plugin isn't doing long work inside `handle`.
3. **Filesystem access for partitioning.** `spin_up_experts` reads project files
   to size-balance scopes. WASM has no FS. Either add
   `peckboard_list_project_files`/`read_file` host fns (scoped), or keep the
   partitioning step core-side behind a generic host call. **Decision in §11.**
4. **Scope escalation.** A plugin tool must not let a caller reach another
   folder/project. Host functions re-verify scope from the **invoking session id**
   (carried in the host-call context), never trusting plugin-supplied ids.
5. **Output size & memory.** `list_experts` can return ~85 KB; WASM has a 128 MB
   cap and result marshaling cost. Tools should paginate / summarize.

## 8. Data migration

- Add generic `plugin_session_meta` and `plugin_data` tables.
- Backfill expert columns → `plugin_session_meta`; `pm_decisions` rows →
  `plugin_data` (or keep the `pm_decisions` table but expose it via host fns —
  **decision in §11**).
- Per repo rules: **no drops**; core stops reading the old columns once the
  plugin owns the data; `repair.rs` ensures the new tables exist.

## 9. Phasing

- **Phase A — Platform (core only, no behavior change):** MCP tool provisioning
  (manifest field + `mcp.tool.invoke` + aggregation + dispatch + collision
  checks); `permissions` manifest field + approval-prompt UX + host-fn gating;
  the new host functions (§4.3); `plugin_session_meta` + `plugin_data` +
  `sidebar_items`. Fully tested; nothing uses it yet.
- **Phase B — Experts plugin, knowledge + question experts:** port
  `spin_up_experts` / `list_experts` / `ask_expert` + the question expert; serve
  `ExpertsView`; add the sidebar item. Validate end-to-end against a dev
  instance. (PM expert still in core, dual-run.)
- **Phase C — PM expert:** move `pm_*` tools, the decisions store, the
  authorization flow, and `PmExpertView` into the plugin.
- **Phase D — Cutover:** remove experts-specific code from core (leave DB
  columns), update `docs/architecture/plugins.md`, publish a release + registry
  entry (mirroring the api-plugin flow).
- **Phase E — Tests:** port `expert*`/`pm-expert` e2e to drive the plugin UI; add
  core platform tests.

## 10. Test strategy

- **Core:** unit tests for tool aggregation, name-collision rejection,
  `mcp.tool.invoke` dispatch, permission gating, and each host fn (using
  `Db::in_memory()` + the public API).
- **Plugin:** Rust unit tests for the ported logic; a small harness that feeds
  `handle` synthetic invoke payloads.
- **e2e:** port the existing expert/PM Playwright specs to drive the
  plugin-served pages and the plugin sidebar item, using `mock:*` models.

## 11. Open questions (decide before Phase A)

1. **Async model for `spin_up_experts`:** OK for the heavy partition/gather
   orchestration to live in a **generic core-side host function** the plugin
   calls (policy in plugin, execution in core), given the WASM 2 s/handle limit?
   (Recommended — alternative is a much larger async-WASM design.)
2. **Filesystem for partitioning:** add scoped `list_project_files`/`read_file`
   host fns, or fold file reading into the orchestration host fn (Q1)?
3. **PM expert timing:** move it in Phase C as planned, or keep PM expert in core
   indefinitely (it's the most `AppState`-coupled piece) and only move
   knowledge/question experts?
4. **PM decisions storage:** migrate `pm_decisions` into the generic plugin
   document store, or keep the table and expose it via host fns?
5. **Sidebar icon mechanism:** plugin supplies inline SVG, or picks from a named
   core icon set?
6. **Sidebar surface:** experts open as a **full content pane** (like the current
   Experts view) or inside the existing iframe modal?
7. **Data-migration acceptance:** OK to backfill-and-leave the expert columns /
   `pm_decisions` (no drop), accepting some dormant core schema permanently?

---

*Appendix: see `README.md` for repo layout and the `src/lib.rs` manifest stub
showing the proposed `mcp_tools` / `sidebar_items` / `permissions` fields.*
