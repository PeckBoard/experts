// Shared response helpers: verdict envelopes and small formatting utilities.
// Mirrors `verdict.rs`. Pure — safe to import under vitest.

/// A `Verdict::Allow` carrying `value` as the tool result payload.
export function allow(value: unknown): string {
  return JSON.stringify({ verdict: "allow", payload: value });
}

/// A `Verdict::Cancel` with a reason (maps to an MCP tool error in core).
export function cancel(reason: string): string {
  return JSON.stringify({ verdict: "cancel", reason });
}

/// A `Verdict::Skip`.
export function skip(): string {
  return JSON.stringify({ verdict: "skip" });
}

/// Truncate `s` to at most `max` chars, appending an ellipsis when clipped.
/// Uses code points (Array.from) to match Rust's `chars()` semantics.
export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) {
    return s;
  }
  return chars.slice(0, max).join("") + "…";
}

/// Wrap a JSON value as a same-origin `Verdict::Allow` HTTP response.
export function jsonResponse(status: number, value: unknown): string {
  return JSON.stringify({
    verdict: "allow",
    payload: {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    },
  });
}

/// Wrap an HTML body as a `Verdict::Allow` HTTP response.
export function htmlResponse(status: number, body: string): string {
  return JSON.stringify({
    verdict: "allow",
    payload: {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
      body,
    },
  });
}
