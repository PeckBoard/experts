# PeckBoard Experts Plugin

The **experts** feature of Peckboard — knowledge / question / PM experts, their
MCP tools, data, and authenticated UI endpoints — packaged as an
[Extism](https://extism.org) WASM plugin written in **TypeScript** (compiled
with the [js-pdk](https://github.com/extism/js-pdk)). Core carries no experts
logic; it loads and dispatches to this plugin.

## What this plugin provides

- **MCP tools** (via the `mcp_tools` manifest field + the `mcp.tool.invoke`
  hook): `spin_up_experts`, `list_experts`, `ask_expert`, `pm_record_decision`,
  `pm_check_decisions`, `pm_escalate_to_user`.
- **Authenticated app-UI endpoints** (`http.request.authed` hook + `ui_routes`,
  served under `/api/plugin-ui/*`): the experts list and the PM
  decisions / answer / edit endpoints, run under the user's authority.
- **Hooks it handles:** `mcp.tool.invoke`, `http.request.before` (the served
  Experts page), `http.request.authed`, and `session.user.answer` (feeds the
  question expert when a user answers a worker's question).

"Expert-ness" is the plugin's own per-session metadata (kind / area / scope /
summary), never a core column. PM decisions and the one-shot supersession grants
live in the plugin's document store (`pm_decisions` / `pm_grants` collections).

## Layout

```
DESIGN.md         Migration design & open questions
src/index.ts      Wasm entry points (manifest/init/shutdown/handle)
src/lib.ts        Hook dispatch
src/host.ts       Host-function wrappers (peckboard_* via Extism memory marshaling)
src/manifest.ts   The plugin manifest (tools, hooks, permissions, ui_routes)
src/experts.ts    Knowledge experts: spin-up, partitioning, list, resolve
src/ask.ts        ask_expert (consult / reply)
src/pm.ts         PM expert: tools, decision store, authorization grants
src/http.ts       Served Experts page + authenticated /api/plugin-ui endpoints
src/verdict.ts    allow / cancel / skip / response helpers
src/index.d.ts    Wasm interface for extism-js (exports + host imports)
test/             vitest unit tests for the pure logic
```

## Build

Requires Node + the [`extism-js`](https://github.com/extism/js-pdk) compiler on
`PATH`.

```bash
./build.sh        # esbuild bundles src/ → dist/index.js, then extism-js → dist/plugin.wasm
npm test          # vitest unit tests
```

The compiled `dist/plugin.wasm` is loaded by the Peckboard core host; the
end-to-end test lives in the core repo at `tests/experts_plugin.rs` and drives
the real wasm through every tool and endpoint.
