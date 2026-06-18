// FFI layer: the host functions Peckboard core provides, the host_call
// marshaling helper, and the small id/time helpers every other module reaches
// through. Mirrors the Rust `host.rs`.
//
// All host calls are kept LAZY (inside functions) so the pure modules that
// import these helpers can be loaded under vitest without an Extism runtime.

type HostFn = (offset: bigint) => bigint;

/// Call a host function and parse its JSON response, surfacing an
/// `{"error": ...}` envelope (or a trap) as a thrown Error — mirrors the Rust
/// `host_call`, which returned the parsed JSON and mapped an `{"error":...}`
/// envelope to `Err(String)`.
export function hostCall(name: string, input: unknown): any {
  const f = (Host.getFunctions() as Record<string, HostFn>)[name];
  const mem = Memory.fromString(JSON.stringify(input));
  const out = f(mem.offset);
  const parsed = JSON.parse(Memory.find(out).readString());
  if (parsed && parsed.error !== undefined && parsed.error !== null) {
    throw new Error(String(parsed.error));
  }
  return parsed;
}

// ── Typed wrappers for each peckboard_* host function ──────────────────

export function listSessions(input: { project_only: boolean }): any {
  return hostCall("peckboard_list_sessions", input);
}

export function getSession(input: { session_id: string }): any {
  return hostCall("peckboard_get_session", input);
}

export function createSession(input: {
  name: string;
  id?: string;
  model?: string;
  effort?: string;
}): any {
  return hostCall("peckboard_create_session", input);
}

export function sessionMetaSet(input: { session_id: string; data: unknown }): any {
  return hostCall("peckboard_session_meta_set", input);
}

export function listProjectFiles(input: Record<string, never>): any {
  return hostCall("peckboard_list_project_files", input);
}

export function dispatchCapture(input: { session_id: string; prompt: string }): any {
  return hostCall("peckboard_dispatch_capture", input);
}

export function resumeSession(input: { session_id: string; text: string }): any {
  return hostCall("peckboard_resume_session", input);
}

export function storePut(input: { collection: string; key: string; data: unknown }): any {
  return hostCall("peckboard_store_put", input);
}

export function storeGet(input: { collection: string; key: string }): any {
  return hostCall("peckboard_store_get", input);
}

export function storeList(input: { collection: string }): any {
  return hostCall("peckboard_store_list", input);
}

// ── IDs / time (sandbox-provided; no WASI needed) ─────────────────────

/// A random 128-bit hex id for a new decision. The Rust used WASI entropy to
/// build a 32-char lowercase-hex string; `crypto.randomUUID()` is the sandbox
/// equivalent for a collision-free id (semantics: a unique opaque id string).
export function genId(): string {
  return crypto.randomUUID();
}

/// Current realtime clock in milliseconds.
export function nowMs(): number {
  return Date.now();
}
