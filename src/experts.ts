// Knowledge experts: spinning them up, the durable question/PM expert ensurer,
// file partitioning, and the shared expert session/metadata types.
// Mirrors `experts.rs`. Host calls are kept lazy (inside the wasm-only
// functions) so the pure partition/resolve helpers import cleanly under vitest.

import {
  listSessions,
  createSession,
  sessionMetaSet,
  listProjectFiles,
  dispatchCapture,
} from "./host";
import { truncate } from "./verdict";

/// Default upper bound on experts created by `spin_up_experts`.
export const DEFAULT_MAX_EXPERTS = 4;
/// Hard ceiling regardless of request (keeps a pathological call bounded).
export const MAX_EXPERTS_CAP = 12;
/// Target bytes per expert when auto-sizing the partition count.
export const PARTITION_WINDOW_BYTES = 50_000;
/// Cap on a `knowledge_summary` returned by `list_experts`.
export const SUMMARY_LIST_CAP = 600;

/// Answer-only role framing dispatched to the QUESTION expert when first created.
export const QUESTION_EXPERT_PRIMING =
  "You are a long-lived QUESTION EXPERT " +
  "running in answer-only mode. Your ONLY job is to answer questions from the " +
  "knowledge accumulated in THIS conversation — the answers the user has given over " +
  "time — so other sessions don't have to re-ask something already settled.\n\n" +
  "Hard rules:\n" +
  "- Answer ONLY from your accumulated Q&A history. Do NOT investigate, explore, " +
  "read the codebase, search the web, or run commands.\n" +
  '- If you don\'t already have a recorded answer, say so plainly (e.g. "I don\'t ' +
  'have a recorded answer for that yet") — do not guess. The asking session falls ' +
  "back to the human, whose answer is then recorded with you for next time.\n" +
  "- When another session consults you, reply by calling `mcp__peckboard__ask_expert` " +
  "with `reply_to_session_id` set to the asking session and `answer` set to your reply.\n\n" +
  "Acknowledge this role briefly.";

/// This plugin's per-session metadata blob.
export interface ExpertMeta {
  kind: string;
  area: string;
  scope_path: string;
  summary: string;
  permanent: boolean;
}

export function defaultMeta(): ExpertMeta {
  return { kind: "", area: "", scope_path: "", summary: "", permanent: false };
}

/// Parse a stored meta blob, applying serde-style defaults for missing fields.
function parseMeta(m: any): ExpertMeta {
  if (m === null || m === undefined || typeof m !== "object") {
    return defaultMeta();
  }
  return {
    kind: typeof m.kind === "string" ? m.kind : "",
    area: typeof m.area === "string" ? m.area : "",
    scope_path: typeof m.scope_path === "string" ? m.scope_path : "",
    summary: typeof m.summary === "string" ? m.summary : "",
    permanent: typeof m.permanent === "boolean" ? m.permanent : false,
  };
}

/// One expert session this plugin manages, paired with its metadata.
export interface ExpertSession {
  session: any;
  meta: ExpertMeta;
}

/// Load the expert sessions visible to the caller.
export function loadExperts(projectOnly: boolean): ExpertSession[] {
  const out = listSessions({ project_only: projectOnly });
  const experts: ExpertSession[] = [];
  const items = out?.sessions;
  if (Array.isArray(items)) {
    for (const item of items) {
      const meta = parseMeta(item?.meta);
      if (meta.kind === "") {
        continue; // a session this plugin marked for something else
      }
      experts.push({
        session: item?.session ?? null,
        meta,
      });
    }
  }
  return experts;
}

export function listExperts(): any {
  const experts = loadExperts(false);
  const out = experts.map((e) => {
    const s = e.session;
    return {
      session_id: s?.id ?? null,
      name: s?.name ?? null,
      expert_kind: e.meta.kind,
      knowledge_area: e.meta.area,
      knowledge_summary: truncate(e.meta.summary, SUMMARY_LIST_CAP),
      scope_path: e.meta.scope_path,
      project_id: s?.project_id ?? null,
      is_permanent: e.meta.permanent,
      last_activity: s?.last_activity ?? null,
    };
  });
  return { experts: out };
}

/// A file the host reported under the caller's folder.
export interface ProjectFile {
  path: string;
  size: number;
}

/// A planned expert slice before any session is created.
export interface Partition {
  area: string;
  dirs: string[];
  files: ProjectFile[];
  est_bytes: number;
}

export function spinUpExperts(args: any): any {
  const a = args && typeof args === "object" ? args : {};
  const maxExpertsArg: number | undefined =
    typeof a.max_experts === "number" ? a.max_experts : undefined;
  const scopesArg: any[] | undefined = Array.isArray(a.scopes)
    ? a.scopes
    : undefined;

  const listing = listProjectFiles({});
  const files: ProjectFile[] = Array.isArray(listing?.files)
    ? listing.files.map((f: any) => ({
        path: typeof f?.path === "string" ? f.path : "",
        size: typeof f?.size === "number" ? f.size : 0,
      }))
    : [];
  if (files.length === 0) {
    throw new Error("no readable project files found in the caller's folder");
  }

  let partitions: Partition[];
  let skipped: any[];
  if (scopesArg !== undefined && scopesArg.length > 0) {
    const r = partitionExplicit(files, scopesArg);
    partitions = r.parts;
    skipped = r.skipped;
  } else {
    const max = clamp(
      maxExpertsArg ?? DEFAULT_MAX_EXPERTS,
      1,
      MAX_EXPERTS_CAP,
    );
    partitions = partitionAuto(files, max);
    skipped = [];
  }

  const created: any[] = [];
  for (const part of partitions) {
    if (part.files.length === 0) {
      continue;
    }
    // 1) Create the underlying session in the caller's scope.
    const createdSession = createSession({ name: `expert: ${part.area}` });
    const sessionId = createdSession?.session?.id;
    if (typeof sessionId !== "string") {
      throw new Error("create_session returned no id");
    }

    // 2) Tag it as one of our knowledge experts.
    const summary = buildSummary(part);
    const meta: ExpertMeta = {
      kind: "knowledge",
      area: part.area,
      scope_path: part.dirs.join(", "),
      summary,
      permanent: false,
    };
    sessionMetaSet({ session_id: sessionId, data: meta });

    // 3) Fire the capture run (fire-and-forget; returns immediately).
    const prompt = buildCapturePrompt(part);
    try {
      dispatchCapture({ session_id: sessionId, prompt });
    } catch (_e) {
      // ignored (best-effort, mirrors Rust `let _ =`)
    }

    created.push({
      session_id: sessionId,
      area: part.area,
      scope_path: part.dirs.join(", "),
      files: part.files.length,
      est_bytes: part.est_bytes,
    });
  }

  if (created.length === 0) {
    throw new Error("no experts were created (every partition was empty)");
  }

  // Ensure the caller's project has the permanent QUESTION + PM experts.
  const questionExpert = ensurePermanentExpert(
    "question",
    "Question Expert",
    "User Q&A",
    "Durable store of answers to questions this project's sessions have asked the user. Consult before asking the user something that may already be settled.",
    QUESTION_EXPERT_PRIMING,
  );
  const pmExpert = ensurePermanentExpert(
    "pm",
    "PM Expert",
    "Project Direction",
    "Durable store of project-direction and business-logic decisions. Consult before making a call that affects product direction; record decisions here.",
    null,
  );

  return {
    experts: created,
    skipped,
    question_expert: questionExpert,
    pm_expert: pmExpert,
  };
}

/// Ensure a permanent expert of `kind` exists in the caller's scope, returning
/// its session id. Idempotent — reuses an existing one the plugin manages.
export function ensurePermanentExpert(
  kind: string,
  name: string,
  area: string,
  summary: string,
  prime: string | null,
): any {
  const existing = loadExperts(false).find((e) => e.meta.kind === kind);
  if (existing) {
    // Already exists — do NOT re-prime (priming is a one-time role setup).
    return existing.session?.id ?? null;
  }
  const created = createSession({ name });
  const sessionId = created?.session?.id;
  if (typeof sessionId !== "string") {
    throw new Error("create_session returned no id");
  }
  const meta: ExpertMeta = {
    kind,
    area,
    scope_path: "",
    summary,
    permanent: true,
  };
  sessionMetaSet({ session_id: sessionId, data: meta });
  // Establish the expert's role on creation (one-time: only on first create).
  if (prime !== null) {
    dispatchCapture({ session_id: sessionId, prompt: prime });
  }
  return sessionId;
}

// ── Pure partition / resolve logic (vitest-tested) ─────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/// Auto-partition: group files by top-level directory, then bin-pack the
/// (alphabetically ordered) groups into a size-balanced set of at most `max`
/// experts.
export function partitionAuto(files: ProjectFile[], max: number): Partition[] {
  // Group by first path segment ("." for root-level files).
  const groups = new Map<string, { files: ProjectFile[]; bytes: number }>();
  for (const f of files) {
    const seg = f.path.split("/")[0];
    const top = seg && seg.length > 0 ? seg : undefined;
    let key: string;
    if (top !== undefined && f.path.includes("/")) {
      key = top;
    } else {
      key = ".";
    }
    let entry = groups.get(key);
    if (!entry) {
      entry = { files: [], bytes: 0 };
      groups.set(key, entry);
    }
    entry.files.push(f);
    entry.bytes += Math.max(f.size, 1);
  }

  // BTreeMap iterates keys in sorted order.
  const keys = Array.from(groups.keys()).sort();
  let total = 0;
  for (const entry of groups.values()) {
    total += entry.bytes;
  }
  const desired = Math.min(
    clamp(Math.floor(total / Math.max(PARTITION_WINDOW_BYTES, 1)) + 1, 1, max),
    Math.max(keys.length, 1),
  );

  // Greedy contiguous split balancing bytes per bin.
  const target = Math.max(Math.floor(total / desired), 1);
  const parts: Partition[] = [];
  let curDirs: string[] = [];
  let curFiles: ProjectFile[] = [];
  let curBytes = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const g = groups.get(key)!;
    curDirs.push(key);
    for (const f of g.files) {
      curFiles.push(f);
    }
    curBytes += g.bytes;
    const remainingBins = Math.max(desired - (parts.length + 1), 0);
    const remainingKeys = keys.length - (i + 1);
    if (
      (curBytes >= target && remainingBins > 0 && remainingKeys >= remainingBins) ||
      remainingKeys === 0
    ) {
      parts.push({
        area: areaLabel(curDirs),
        dirs: curDirs,
        files: curFiles,
        est_bytes: curBytes,
      });
      curDirs = [];
      curFiles = [];
      curBytes = 0;
    }
  }
  return parts;
}

/// Explicit partition: each scope entry (a path or array of paths) becomes one
/// expert covering the files under those path prefixes.
export function partitionExplicit(
  files: ProjectFile[],
  scopes: any[],
): { parts: Partition[]; skipped: any[] } {
  const parts: Partition[] = [];
  const skipped: any[] = [];
  for (const entry of scopes) {
    let prefixes: string[];
    if (typeof entry === "string") {
      prefixes = [entry];
    } else if (Array.isArray(entry)) {
      prefixes = entry.filter((v) => typeof v === "string") as string[];
    } else {
      prefixes = [];
    }
    const clean = prefixes
      .map((p) => trimMatches(p, "/"))
      .filter((p) => p.length > 0 && !p.includes(".."));
    if (clean.length === 0) {
      skipped.push(entry);
      continue;
    }
    const matched = files.filter((f) => clean.some((p) => pathUnder(f.path, p)));
    if (matched.length === 0) {
      skipped.push(clean);
      continue;
    }
    let est = 0;
    for (const f of matched) {
      est += Math.max(f.size, 1);
    }
    parts.push({
      area: areaLabel(clean),
      dirs: clean,
      files: matched,
      est_bytes: est,
    });
  }
  return { parts, skipped };
}

/// Trim all leading/trailing occurrences of a single-char `ch` (Rust
/// `trim_matches('/')`).
function trimMatches(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start++;
  while (end > start && s[end - 1] === ch) end--;
  return s.slice(start, end);
}

/// Whether `path` is `prefix` itself or lives beneath it (segment-aware).
export function pathUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/// A short human label for a slice: the basenames of its dirs, joined with `+`.
export function areaLabel(dirs: string[]): string {
  const names = dirs.map((d) => {
    const parts = d.split("/");
    const last = parts[parts.length - 1];
    return last && last.length > 0 ? last : d;
  });
  if (names.length === 0) {
    return "project";
  }
  return names.join(" + ");
}

/// A readable summary of a slice.
export function buildSummary(part: Partition): string {
  const langs = new Map<string, number>();
  for (const f of part.files) {
    const lang = langForPath(f.path);
    langs.set(lang, (langs.get(lang) ?? 0) + 1);
  }
  // Sort by count desc, then name asc (matches Rust b.1.cmp(a.1).then(a.0.cmp(b.0))).
  const langList = Array.from(langs.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const langsStr = langList
    .slice(0, 6)
    .map(([l, n]) => `${l} ${n}`)
    .join(", ");
  const top = part.files.slice(0, 20).map((f) => f.path);
  const kb = Math.floor(part.est_bytes / 1024);
  return (
    `Knowledge expert for ${part.area} (${part.dirs.join(", ")}). ` +
    `${part.files.length} files, ~${kb} KB. ` +
    `Languages: ${langsStr.length === 0 ? "n/a" : langsStr}. ` +
    `Sample: ${top.join(", ")}.`
  );
}

/// The system-style prompt handed to a freshly-spun expert.
export function buildCapturePrompt(part: Partition): string {
  return (
    `You are a knowledge expert for ${part.area}. Your scope is: ${part.dirs.join(", ")}. ` +
    "Eagerly read the files in your scope now and build a durable understanding of how this code works — " +
    "its responsibilities, key types, control flow, and gotchas — so you can answer questions about it later via ask_expert. " +
    "Do not modify anything; you are read-only."
  );
}

/// Map a file path to a coarse language label by extension.
export function langForPath(path: string): string {
  const parts = path.split(".");
  const ext = parts.length > 1 ? parts[parts.length - 1] : "";
  switch (ext) {
    case "rs":
      return "Rust";
    case "ts":
    case "tsx":
      return "TypeScript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "JavaScript";
    case "py":
      return "Python";
    case "go":
      return "Go";
    case "java":
      return "Java";
    case "rb":
      return "Ruby";
    case "c":
    case "h":
      return "C";
    case "cpp":
    case "cc":
    case "hpp":
      return "C++";
    case "cs":
      return "C#";
    case "css":
    case "scss":
      return "CSS";
    case "html":
      return "HTML";
    case "json":
      return "JSON";
    case "toml":
      return "TOML";
    case "yaml":
    case "yml":
      return "YAML";
    case "md":
      return "Markdown";
    case "sh":
    case "bash":
      return "Shell";
    case "sql":
      return "SQL";
    default:
      return "Other";
  }
}

/// Pick the expert to consult: explicit `expert_id` (in scope), else best
/// `area` match (substring, case-insensitive), else the first (most recent).
export function resolveExpert(
  experts: ExpertSession[],
  expertId: string | null | undefined,
  area: string | null | undefined,
): ExpertSession | undefined {
  const id =
    expertId !== null && expertId !== undefined ? expertId.trim() : "";
  if (id.length > 0) {
    return experts.find((e) => e.session?.id === id);
  }
  const hint = area !== null && area !== undefined ? area.trim() : "";
  if (hint.length > 0) {
    const needle = hint.toLowerCase();
    const found = experts.find(
      (e) =>
        e.meta.area.toLowerCase().includes(needle) ||
        e.meta.scope_path.toLowerCase().includes(needle),
    );
    if (found) {
      return found;
    }
  }
  // Fallback: the first (host returns newest-activity first).
  return experts[0];
}
