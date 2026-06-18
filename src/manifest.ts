// The plugin manifest JSON body — identity, hooks, MCP tools, sidebar/page
// routes, and the permissions the host functions require. Mirrors `manifest.rs`.
//
// The Rust pulled description/version/repository from Cargo.toml via env!();
// those constants are reproduced verbatim here.

const DESCRIPTION =
  "Experts feature for Peckboard (knowledge / question / PM experts, MCP tools, and UI), served as a WASM plugin.";
const VERSION = "0.1.0";
const REPOSITORY = "https://github.com/PeckBoard/experts";

/// Build the manifest JSON string. `index.ts`'s `manifest()` export wraps this.
export function manifestJson(): string {
  const manifest = {
    description: DESCRIPTION,
    version: VERSION,
    repository: REPOSITORY,

    hooks: [
      "mcp.tool.invoke",
      "http.request.before",
      "http.request.authed",
      "session.user.answer",
    ],

    mcp_tools: [
      {
        name: "spin_up_experts",
        title: "Spin up experts",
        description:
          "Partition a project's codebase across several long-lived KNOWLEDGE-EXPERT sessions and have each eagerly read and summarize its slice. The split is size-balanced, grouping adjacent top-level directories together. Returns the created experts (session id, area, scope_path). Experts are consulted later via ask_expert. Pass `scopes` to create one expert per explicit path instead of the automatic split.",
        input_schema: {
          type: "object",
          properties: {
            project_id: {
              type: "string",
              description:
                "Project to spin experts up for (optional if the session already has project context).",
            },
            max_experts: {
              type: "integer",
              description:
                "Upper bound on how many experts to create (default 4). Ignored when `scopes` is given.",
            },
            scopes: {
              type: "array",
              items: { type: ["string", "array"], items: { type: "string" } },
              description:
                "Explicit scope entries; each becomes one expert. An entry is a single folder-relative path or an array of paths the expert covers together.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "list_experts",
        title: "List experts",
        description:
          "List the long-lived EXPERT sessions you may consult (your project's experts plus globals). Each entry returns session_id, name, expert_kind, knowledge_area, a compact knowledge_summary, scope_path, project_id, is_permanent, and last_activity. Use this to pick a target session_id for ask_expert.",
        input_schema: {
          type: "object",
          properties: {
            project_id: {
              type: "string",
              description:
                "Project whose experts to list (optional). Globals are always included.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "ask_expert",
        title: "Ask an expert",
        description:
          "Ask a long-lived EXPERT session a question, ASYNCHRONOUSLY — the answer arrives as an event you read on a later turn. Target by explicit `expert_id` (from list_experts) or by an `area`/topic string. EXPERTS answering use the same tool in reply mode by setting `answer` + `reply_to_session_id`.",
        input_schema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to ask (required when asking).",
            },
            expert_id: {
              type: "string",
              description:
                "Explicit target expert session id. Takes precedence over `area`.",
            },
            area: {
              type: "string",
              description:
                "Topic/area hint used to resolve the best in-scope expert.",
            },
            answer: {
              type: "string",
              description:
                "REPLY MODE: answer text to deliver back to the asking session. Requires `reply_to_session_id`.",
            },
            reply_to_session_id: {
              type: "string",
              description:
                "REPLY MODE: the session id to deliver the answer to. Requires `answer`.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "pm_record_decision",
        title: "Record PM decision",
        description:
          "Record a project-direction or business-logic decision in the project's durable PM decision log. Workers may only ADD new decisions; changing/superseding an existing decision (supersedes_decision_id) is restricted to the PM expert acting on explicit user authorization. The PM expert is notified of decisions recorded by other sessions.",
        input_schema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Short title naming what was decided",
            },
            decision: {
              type: "string",
              description:
                "The decision itself — the rule future changes must respect",
            },
            rationale: {
              type: "string",
              description: "Why this was decided (optional)",
            },
            supersedes_decision_id: {
              type: "string",
              description:
                "Id of an existing decision this replaces. RESTRICTED: PM expert + user authorization only.",
            },
            project_id: {
              type: "string",
              description: "Target project; only used by an unscoped session.",
            },
          },
          required: ["title", "decision"],
          additionalProperties: false,
        },
      },
      {
        name: "pm_check_decisions",
        title: "Check PM decisions",
        description:
          "Check a planned change against the project's active (non-superseded) PM decisions BEFORE making it. Synchronous — returns the active decision set (id, title, decision, decided_at) immediately. Optionally narrow with topic_keywords; a non-matching keyword returns the full set rather than hiding decisions.",
        input_schema: {
          type: "object",
          properties: {
            planned_change: {
              type: "string",
              description:
                "Plain-language description of the change you are about to make",
            },
            topic_keywords: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional keywords to narrow the returned decisions (matched against title + decision).",
            },
            project_id: {
              type: "string",
              description: "Target project; only used by an unscoped session.",
            },
          },
          required: ["planned_change"],
          additionalProperties: false,
        },
      },
      {
        name: "pm_escalate_to_user",
        title: "Escalate to user",
        description:
          'PM EXPERT ONLY: escalate a project-direction question you cannot answer from recorded decisions to the user. It lands in the project\'s PM log as PENDING; when the user answers, their answer authorizes superseding a decision. Other sessions are rejected — route questions through the PM expert via ask_expert ("pm").',
        input_schema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The decision question the user must answer",
            },
            context: {
              type: "string",
              description: "Optional context: why this is asked, options, impact",
            },
            asking_session_id: {
              type: "string",
              description:
                "Optional worker session that triggered the escalation, to relay the answer back.",
            },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
    ],

    sidebar_items: [
      { id: "experts", label: "Experts", path: "/plugin-api/v1/experts" },
    ],

    http_routes: ["GET /plugin-api/v1/experts"],

    // Authenticated app-UI endpoints (behind core's require_auth, served
    // under the logged-in user's authority). The React Experts/PM views
    // call these.
    ui_routes: [
      "GET /api/plugin-ui/experts",
      "GET /api/plugin-ui/pm/decisions",
      "POST /api/plugin-ui/pm/answer",
      "PUT /api/plugin-ui/pm/decisions/:id",
    ],

    permissions: [
      "provide_mcp_tools",
      "contribute_sidebar",
      "session_read",
      "session_write",
      "session_dispatch",
      "project_files_read",
      "data_store",
      "user_authority",
    ],
  };
  return JSON.stringify(manifest);
}
