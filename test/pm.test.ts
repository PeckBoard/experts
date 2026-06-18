import { describe, it, expect } from "vitest";
import {
  PmDecision,
  pmIsActive,
  pmFilterDecisions,
  pmDecisionJson,
} from "../src/pm";

function dec(
  id: string,
  q: string,
  a: string | null,
  status: string,
): PmDecision {
  return {
    id,
    project_id: "p1",
    question: q,
    answer: a,
    status,
    superseded_by: null,
    created_at: 100,
    answered_at: a !== null ? 200 : null,
    asked_by: null,
  };
}

describe("pm pure helpers", () => {
  it("active and keyword filter", () => {
    expect(pmIsActive(dec("d1", "auth", "use tokens", "answered"))).toBe(true);
    expect(pmIsActive(dec("d2", "x", "y", "superseded"))).toBe(false);
    expect(pmIsActive(dec("d3", "x", null, "pending"))).toBe(false);

    const active = [
      dec("d1", "Auth model", "use JWT tokens", "answered"),
      dec("d2", "Billing", "monthly only", "answered"),
    ];
    // No keywords → full set.
    expect(pmFilterDecisions(active, []).length).toBe(2);
    // Matching keyword narrows.
    const onlyAuth = pmFilterDecisions(active, ["token"]);
    expect(onlyAuth.length).toBe(1);
    expect(onlyAuth[0].title).toBe("Auth model");
    // Non-matching keyword falls back to the full set (never hides).
    expect(pmFilterDecisions(active, ["nonsense"]).length).toBe(2);
  });

  it("decision_json shape", () => {
    const v = pmDecisionJson(dec("d1", "Title here", "The decision", "answered"));
    expect(v.id).toBe("d1");
    expect(v.title).toBe("Title here");
    expect(v.decision).toBe("The decision");
    expect(v.status).toBe("answered");
    expect(v.decided_at).toBe(200); // answered_at wins over created_at
    // A pending row has no decision and falls back to created_at.
    const p = pmDecisionJson(dec("d2", "Q?", null, "pending"));
    expect(p.decision).toBe(null);
    expect(p.decided_at).toBe(100);
  });
});
