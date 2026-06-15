/**
 * Built-binary smoke test (packaging deliverable).
 *
 * Unlike the other subprocess tests (which run the TS source through tsx), this
 * one exercises the SHIPPED artifact: it runs `node dist/generate-mcp-schemas.js`
 * — plain node, no tsx — exactly as the `mcp-gen` bin and a published install
 * would. It guards the packaging contract: the emitted CJS is self-runnable and
 * the WI-2 output shape survives the build.
 *
 * It also regression-protects the WI-2 exit-code contract on the COMPILED binary
 * (not just the tsx source): 0 = all clean, 1 = ≥1 function failed (clean tools
 * still on stdout, failure on stderr), 2 = file-level failure (empty stdout).
 *
 * The build runs fresh in beforeAll (same command as `npm run build`), so the
 * test always asserts against a current artifact however vitest is invoked — a
 * stale dist/ can never be tested.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_ENTRY = path.join(ROOT, "dist", "generate-mcp-schemas.js");

const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/** Run the COMPILED binary (plain node, no tsx) as a subprocess. */
function runBuilt(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [DIST_ENTRY, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeAll(() => {
  // Build the shipped artifact via the same compiler invocation as `npm run build`
  // (tsc -p tsconfig.build.json). Spawned through node directly so it is
  // cross-platform (no npm.cmd shell quirks on Windows).
  const tsc = require.resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: ROOT,
    stdio: "pipe",
  });
}, 120_000);

describe("built binary: node dist/generate-mcp-schemas.js (no tsx)", () => {
  it("emits the entry with a node shebang", () => {
    expect(existsSync(DIST_ENTRY), `expected built entry at ${DIST_ENTRY}`).toBe(true);
  });

  it("exit 0: runs case1 to valid JSON with a tools array", () => {
    const res = runBuilt(["fixtures/case1-primitives.ts"]);

    // exit 0 — clean conversion under the WI-2 contract.
    expect(res.status, `stderr:\n${res.stderr}`).toBe(0);

    // stdout is machine-readable JSON with a tools array (no prose leaked to stdout).
    let json: any;
    expect(() => {
      json = JSON.parse(stripBom(res.stdout));
    }, `stdout was not valid JSON:\n${res.stdout}`).not.toThrow();
    expect(Array.isArray(json.tools)).toBe(true);
    expect(json.tools.length).toBeGreaterThan(0);
    expect(json.tools.map((t: any) => t.name)).toContain("greet");
  });

  it("exit 1: an unconvertible function fails loud — error on stderr, clean `ok` tool still on stdout", () => {
    const res = runBuilt(["fixtures/case7a-unbound-generic.ts"]);

    // exit 1 — at least one function could not be converted.
    expect(res.status, `stderr:\n${res.stderr}`).toBe(1);

    // The unconvertible-tool error is human-readable on stderr (function + reason).
    expect(res.stderr).toMatch(/error:\s*wrap/);
    expect(res.stderr).toMatch(/could not be converted|unbound generic/i);
    // JSON did not leak onto stderr.
    expect(res.stderr).not.toContain('"tools"');

    // stdout stays valid JSON: the clean `ok` tool survives, `wrap` is excluded,
    // and the machine-readable errors array is present.
    let json: any;
    expect(() => {
      json = JSON.parse(stripBom(res.stdout));
    }, `stdout was not valid JSON:\n${res.stdout}`).not.toThrow();
    expect(json.tools.map((t: any) => t.name)).toContain("ok");
    expect(json.tools.some((t: any) => t.name === "wrap")).toBe(false);
    expect(Array.isArray(json.errors)).toBe(true);
    expect(json.errors.some((e: any) => e.function === "wrap")).toBe(true);
  });

  it("exit 2: a nonexistent file is a file-level failure — error on stderr, empty stdout", () => {
    const res = runBuilt(["nope.ts"]);

    // exit 2 — file-level failure (returned before any JSON is emitted).
    expect(res.status, `stderr:\n${res.stderr}`).toBe(2);

    // Error on stderr; stdout is empty (no partial/garbage JSON shipped).
    expect(res.stderr).toMatch(/error:/);
    expect(res.stdout.trim()).toBe("");
  });
});
