/**
 * Regression pins (HARDENING.md constraint 2): the CLI's `tools` output for the
 * four passing POC fixtures must stay equivalent to the checked-in baselines in
 * outputs/, and each must exit 0 under the WI-2 fail-loud contract.
 *
 * Only `tools` is pinned: the old `problems[]` was replaced by the
 * `errors`/`warnings` split in WI-2. A clean fixture emits neither, so both
 * keys are omitted from stdout.
 */
import { describe, expect, it } from "vitest";
import { readBaseline, runCliSubprocess } from "./helpers";

const CASES: Array<{ fixture: string; baseline: string }> = [
  { fixture: "fixtures/case1-primitives.ts", baseline: "case1.json" },
  { fixture: "fixtures/case2-optional.ts", baseline: "case2.json" },
  { fixture: "fixtures/case3-object.ts", baseline: "case3.json" },
  { fixture: "fixtures/case5-imported.ts", baseline: "case5.json" },
];

describe("regression: CLI output matches POC baselines (cases 1/2/3/5)", () => {
  for (const { fixture, baseline } of CASES) {
    it(`${fixture} == outputs/${baseline}`, () => {
      const result = runCliSubprocess([fixture]);
      expect(result.exitCode).toBe(0);
      expect(result.json, `stdout was not valid JSON:\n${result.stdout}`).toBeDefined();
      expect(result.json.tools).toEqual(readBaseline(baseline).tools);
      expect(result.json.problems).toBeUndefined();
      expect(result.json.errors).toBeUndefined();
    });
  }
});
