/**
 * Module-level regression pins: generateTools() must produce the same `tools`
 * as the checked-in POC baselines, and per-call state must not leak between
 * runs in one process (the POC kept `problems` in a module-level mutable).
 *
 * WI-2 replaced the flat `problems[]` with the fail-loud `errors`/`warnings`
 * split, so the shape assertions below now pin those: a clean fixture produces
 * neither.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateTools } from "../src/generate";
import { ROOT, readBaseline } from "./helpers";

const fixture = (name: string) => path.join(ROOT, "fixtures", name);

describe("regression: generateTools() matches POC baselines (cases 1/2/3/5)", () => {
  const CASES: Array<{ file: string; baseline: string }> = [
    { file: "case1-primitives.ts", baseline: "case1.json" },
    { file: "case2-optional.ts", baseline: "case2.json" },
    { file: "case3-object.ts", baseline: "case3.json" },
    { file: "case5-imported.ts", baseline: "case5.json" },
  ];

  for (const { file, baseline } of CASES) {
    it(`${file} == outputs/${baseline}`, () => {
      const result = generateTools(fixture(file));
      expect(result.tools).toEqual(readBaseline(baseline).tools);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  }
});

describe("per-call state isolation", () => {
  it("failures from one run do not leak into the next", () => {
    // case4 has an input-position generic (`wrap<T>`) → at least one hard error.
    const dirty = generateTools(fixture("case4-generic.ts"));
    expect(dirty.errors.length).toBeGreaterThan(0);

    const clean = generateTools(fixture("case1-primitives.ts"));
    expect(clean.errors).toEqual([]);
    expect(clean.warnings).toEqual([]);
  });

  it("debug dumps are only collected when requested", () => {
    const withDebug = generateTools(fixture("case1-primitives.ts"), { debug: true });
    expect(withDebug.rawTypeDebug.length).toBeGreaterThan(0);

    const without = generateTools(fixture("case1-primitives.ts"));
    expect(without.rawTypeDebug).toEqual([]);
  });
});
