import { describe, it, expect } from "vitest";
import { truncate } from "../src/verdict";
import { isPmHint } from "../src/ask";

describe("truncate", () => {
  it("clips with ellipsis", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello world", 5)).toBe("hello…");
  });
});

describe("isPmHint", () => {
  it("detects the pm shorthand", () => {
    expect(isPmHint("pm")).toBe(true);
    expect(isPmHint(" PM ")).toBe(true);
    expect(isPmHint("pmexpert")).toBe(false);
    expect(isPmHint(null)).toBe(false);
    expect(isPmHint(undefined)).toBe(false);
  });
});
