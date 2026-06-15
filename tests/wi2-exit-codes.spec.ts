/**
 * WI-2: the CLI fail-loud contract (HARDENING.md work item 2).
 *
 *   exit 0 — every exported function converted cleanly
 *   exit 1 — one or more functions failed (clean ones still emitted in `tools`,
 *            failed ones absent from `tools` and present in `errors`)
 *   exit 2 — file-level failure (file not found / unparseable)
 *
 * stdout stays machine-readable JSON (with an `errors` array); human-readable
 * errors go to stderr.
 */
import { describe, expect, it } from "vitest";
import { runCliSubprocess } from "./helpers";

describe("WI-2 exit codes", () => {
  it("exit 0: a clean file converts every function", () => {
    const r = runCliSubprocess(["fixtures/case1-primitives.ts"]);
    expect(r.exitCode).toBe(0);
    expect(r.json.tools.map((t: any) => t.name)).toEqual(["greet"]);
    expect(r.json.errors).toBeUndefined();
  });

  it("exit 1: one bad function — clean tools remain, the bad one is excluded and listed in errors", () => {
    const r = runCliSubprocess(["fixtures/case7a-unbound-generic.ts"]);
    expect(r.exitCode).toBe(1);

    // Clean function still emitted...
    expect(r.json.tools.map((t: any) => t.name)).toEqual(["ok"]);
    // ...failed function absent from tools...
    expect(r.json.tools.some((t: any) => t.name === "wrap")).toBe(false);
    // ...and present in errors.
    expect(Array.isArray(r.json.errors)).toBe(true);
    expect(r.json.errors.some((e: any) => e.function === "wrap")).toBe(true);
  });

  it("exit 2: a nonexistent file is a file-level failure", () => {
    const r = runCliSubprocess(["fixtures/this-file-does-not-exist.ts"]);
    expect(r.exitCode).toBe(2);
  });
});

describe("WI-2 stderr / stdout split", () => {
  it("stdout is valid JSON with a machine-readable errors array; human errors go to stderr", () => {
    const r = runCliSubprocess(["fixtures/case7a-unbound-generic.ts"]);
    expect(r.exitCode).toBe(1);

    // stdout parsed cleanly as JSON (helper returns undefined if it did not).
    expect(r.json, `stdout was not valid JSON:\n${r.stdout}`).toBeDefined();
    expect(Array.isArray(r.json.errors)).toBe(true);
    // The JSON did not leak onto stderr.
    expect(r.stderr).not.toContain('"tools"');

    // stderr carries the human-readable failure: function, reason, fix hint.
    expect(r.stderr).toMatch(/error:\s*wrap/);
    expect(r.stderr).toMatch(/generic/i);
    expect(r.stderr).toMatch(/add a constraint or use a concrete type/i);
  });
});
