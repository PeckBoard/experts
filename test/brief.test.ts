import { describe, it, expect } from "vitest";
import { parseBrief, briefJson, ExpertBrief } from "../src/brief";
import { ExpertSession } from "../src/experts";

describe("parseBrief", () => {
  it("parses a well-formed blob with defaults", () => {
    const b = parseBrief({ session_id: "e1", brief: "hello" });
    expect(b).not.toBeNull();
    expect(b!.session_id).toBe("e1");
    expect(b!.brief).toBe("hello");
    expect(b!.area).toBe("");
    expect(b!.updated_at).toBe(0);
  });

  it("rejects blobs missing required fields", () => {
    expect(parseBrief(null)).toBeNull();
    expect(parseBrief({ brief: "x" })).toBeNull(); // no session_id
    expect(parseBrief({ session_id: "e1" })).toBeNull(); // no brief
  });
});

describe("briefJson", () => {
  const stored: ExpertBrief = {
    session_id: "e1",
    area: "stored-area",
    scope_path: "stored/scope",
    brief: "the brief",
    updated_at: 123,
  };

  it("prefers live expert meta over stored values", () => {
    const e: ExpertSession = {
      session: { id: "e1" },
      meta: {
        kind: "knowledge",
        area: "live-area",
        scope_path: "live/scope",
        summary: "",
        permanent: false,
      },
    };
    const j = briefJson(stored, e);
    expect(j.expert_id).toBe("e1");
    expect(j.area).toBe("live-area");
    expect(j.scope_path).toBe("live/scope");
    expect(j.brief).toBe("the brief");
    expect(j.updated_at).toBe(123);
  });

  it("falls back to stored values when no expert is given", () => {
    const j = briefJson(stored, undefined);
    expect(j.area).toBe("stored-area");
    expect(j.scope_path).toBe("stored/scope");
  });
});
