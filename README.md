# PeckBoard Experts Plugin

The **experts** feature of Peckboard — knowledge / question / PM experts, their
MCP tools, data, and UI — packaged as a WASM plugin.

> **Status:** scaffold + design only. See [`DESIGN.md`](DESIGN.md) for the full
> migration plan and the open questions to resolve before implementation. This
> repo does not yet build a working plugin; `src/lib.rs` is a manifest stub.

## What this plugin will provide

- **MCP tools:** `spin_up_experts`, `list_experts`, `ask_expert`,
  `pm_record_decision`, `pm_check_decisions`, `pm_escalate_to_user`
  (via the proposed `mcp_tools` manifest field + `mcp.tool.invoke` hook).
- **Sidebar item:** an "Experts" entry in the left rail (via the proposed
  `sidebar_items` manifest field).
- **UI pages:** the experts list + PM expert views, served under
  `/plugin-api/v1/...`.

## Requires (new) core platform capabilities

This plugin depends on generic platform extensions that do **not exist in core
yet** — they are the subject of Phase A in `DESIGN.md`:

- Plugin-provided MCP tools (`mcp_tools` manifest + `mcp.tool.invoke` hook).
- `sidebar_items` manifest field + rail rendering.
- New host functions (session create/dispatch/resume, event append, document
  store, broadcast) — see `DESIGN.md` §4.3.
- A WASM `permissions` manifest field wired into the approval prompt.

## Layout

```
DESIGN.md         Full migration design & open questions (read this first)
Cargo.toml        Extism PDK crate (cdylib → wasm32-unknown-unknown)
src/lib.rs        Plugin entry points (manifest/init/handle/shutdown) — STUB
build.sh          Build the .wasm
web/              (later) the experts UI bundle served at /plugin-api/*
```

## Build (once implemented)

```bash
./build.sh   # → target/wasm32-unknown-unknown/release/peckboard_experts_plugin.wasm
```
