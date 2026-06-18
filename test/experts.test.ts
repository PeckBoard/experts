import { describe, it, expect } from "vitest";
import {
  partitionAuto,
  partitionExplicit,
  pathUnder,
  areaLabel,
  resolveExpert,
  ProjectFile,
  ExpertSession,
} from "../src/experts";

function pf(path: string, size: number): ProjectFile {
  return { path, size };
}

describe("partition", () => {
  it("auto-partition groups and caps", () => {
    const files = [
      pf("src/auth/a.rs", 10_000),
      pf("src/auth/b.rs", 10_000),
      pf("src/ws/c.rs", 30_000),
      pf("web/x.ts", 40_000),
      pf("web/y.ts", 40_000),
      pf("docs/r.md", 1_000),
      pf("README.md", 500), // root-level → "." group
    ];
    const parts = partitionAuto(files, 3);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.length).toBeLessThanOrEqual(3);
    // Every file lands in exactly one partition.
    const total = parts.reduce((acc, p) => acc + p.files.length, 0);
    expect(total).toBe(files.length);
    // Areas are human labels built from dir basenames.
    expect(parts.every((p) => p.area.length > 0)).toBe(true);
  });

  it("explicit-partition matches prefixes and reports skips", () => {
    const files = [
      pf("src/auth/a.rs", 1),
      pf("src/ws/c.rs", 1),
      pf("web/x.ts", 1),
    ];
    const scopes = ["src/auth", ["src/ws", "web"], "does/not/exist"];
    const { parts, skipped } = partitionExplicit(files, scopes);
    expect(parts.length).toBe(2);
    expect(parts[0].files.length).toBe(1); // src/auth/a.rs
    expect(parts[1].files.length).toBe(2); // src/ws + web
    expect(skipped.length).toBe(1);
    // Segment-aware: "src/a" must not match prefix "src/ab".
    expect(pathUnder("src/a/x.rs", "src/a")).toBe(true);
    expect(pathUnder("src/ab/x.rs", "src/a")).toBe(false);
  });

  it("area-label uses basenames", () => {
    expect(areaLabel(["src/auth", "src/ws"])).toBe("auth + ws");
    expect(areaLabel(["."])).toBe(".");
    expect(areaLabel([])).toBe("project");
  });
});

describe("resolveExpert", () => {
  const experts: ExpertSession[] = [
    {
      session: { id: "e1" },
      meta: {
        area: "auth + ws",
        kind: "knowledge",
        scope_path: "",
        summary: "",
        permanent: false,
      },
    },
    {
      session: { id: "e2" },
      meta: {
        area: "frontend",
        kind: "knowledge",
        scope_path: "web",
        summary: "",
        permanent: false,
      },
    },
  ];

  it("prefers explicit then area then fallback", () => {
    // explicit id wins
    expect(resolveExpert(experts, "e2", "auth")!.session.id).toBe("e2");
    // area substring match (case-insensitive)
    expect(resolveExpert(experts, null, "AUTH")!.session.id).toBe("e1");
    // area matches scope_path too
    expect(resolveExpert(experts, null, "web")!.session.id).toBe("e2");
    // fallback to first when nothing matches
    expect(resolveExpert(experts, null, "nonsense")!.session.id).toBe("e1");
  });
});
