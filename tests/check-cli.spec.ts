/**
 * CLI integration for `mcp-gen check` — the contract guardrail end to end,
 * driven through the real bin (tsx subprocess) against hermetic temp projects.
 *
 * What this pins:
 *   - `--update` writes a normalized snapshot next to the entry file and exits 0;
 *     re-running --update is byte-stable.
 *   - a check on the unchanged file exits 0 (ok:true, no breaking).
 *   - editing the fixture to add a required param exits 1 and NAMES the breaking
 *     change (machine-readable on stdout, human-readable on stderr).
 *   - a missing snapshot exits 2 with the create-baseline hint (never silently
 *     created in CI).
 *   - a tool that now fails to generate (fail-loud) drops out and registers as a
 *     BREAKING removal → exit 1.
 *   - reordering source declarations yields an identical snapshot (determinism).
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCliSubprocess } from "./helpers";

// Minimal tsconfig so generateTools' discovery is deterministic & hermetic.
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
  },
});

const GREET_AND_ROLE = `
/**
 * Greets a person.
 * @param name - the person's name
 */
export function greet(name: string): string {
  return \`hi \${name}\`;
}

/**
 * Sets a role.
 * @param role - the role to set
 */
export function setRole(role: "admin" | "user"): string {
  return role;
}
`;

// Track created temp projects so we don't leak them into the shared temp dir
// (a stray tsconfig up the temp tree breaks tsconfig-discovery.spec.ts).
const createdDirs: string[] = [];
afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

/** Create a fresh temp project with a tsconfig and one source file. */
function project(source: string, basename = "surface.ts"): { dir: string; file: string; snapshot: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-check-"));
  createdDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
  const file = path.join(dir, basename);
  writeFileSync(file, source);
  return { dir, file, snapshot: `${file}.mcp-snapshot.json` };
}

describe("mcp-gen check — --update", () => {
  it("writes a normalized snapshot next to the entry file and exits 0", () => {
    const { file, snapshot } = project(GREET_AND_ROLE);
    const r = runCliSubprocess(["check", file, "--update"]);

    expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
    expect(existsSync(snapshot), `expected default snapshot at ${snapshot}`).toBe(true);

    // The snapshot is well-formed: header + version + tools sorted by name.
    const doc = JSON.parse(readFileSync(snapshot, "utf8"));
    expect(doc.schema).toBe("mcp-gen/tool-surface");
    expect(doc.version).toBe(1);
    expect(doc.tools.map((t: any) => t.name)).toEqual(["greet", "setRole"]); // sorted

    // stdout is machine-readable confirmation.
    expect(r.json.action).toBe("update");
    expect(r.json.tools).toEqual(["greet", "setRole"]);
  });

  it("re-running --update is byte-for-byte identical (deterministic)", () => {
    const { file, snapshot } = project(GREET_AND_ROLE);
    runCliSubprocess(["check", file, "--update"]);
    const first = readFileSync(snapshot, "utf8");
    runCliSubprocess(["check", file, "--update"]);
    const second = readFileSync(snapshot, "utf8");
    expect(second).toBe(first);
  });

  it("honors --snapshot to override the path", () => {
    const { dir, file } = project(GREET_AND_ROLE);
    const custom = path.join(dir, "contract.json");
    const r = runCliSubprocess(["check", file, "--update", "--snapshot", custom]);
    expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
    expect(existsSync(custom)).toBe(true);
  });
});

describe("mcp-gen check — diff", () => {
  it("exit 0 on an unchanged file (ok:true, no breaking)", () => {
    const { file } = project(GREET_AND_ROLE);
    runCliSubprocess(["check", file, "--update"]);

    const r = runCliSubprocess(["check", file]);
    expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.summary.breaking).toBe(0);
    expect(r.json.changes).toEqual([]);
  });

  it("exit 1 when a required param is added — names the breaking change", () => {
    const { file } = project(GREET_AND_ROLE);
    runCliSubprocess(["check", file, "--update"]);

    // Add a required `age` parameter to greet.
    writeFileSync(
      file,
      GREET_AND_ROLE.replace("export function greet(name: string)", "export function greet(name: string, age: number)"),
    );

    const r = runCliSubprocess(["check", file]);
    expect(r.exitCode).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.summary.breaking).toBeGreaterThanOrEqual(1);

    const breaking = r.json.changes.filter((c: any) => c.severity === "BREAKING");
    expect(breaking.some((c: any) => c.kind === "property-added-required" && /age/.test(c.detail))).toBe(true);

    // Human-readable on stderr; JSON did not leak there.
    expect(r.stderr).toMatch(/BREAKING/);
    expect(r.stderr).toMatch(/greet/);
    expect(r.stderr).toMatch(/age/);
    expect(r.stderr).not.toContain('"changes"');
  });

  it("exit 0 when a param is added as optional (SAFE)", () => {
    const { file } = project(GREET_AND_ROLE);
    runCliSubprocess(["check", file, "--update"]);

    // Optional `age?` — a SAFE addition.
    writeFileSync(
      file,
      GREET_AND_ROLE.replace("export function greet(name: string)", "export function greet(name: string, age?: number)"),
    );

    const r = runCliSubprocess(["check", file]);
    expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.changes.some((c: any) => c.kind === "property-added-optional" && c.severity === "SAFE")).toBe(true);
  });

  it("exit 2 with a create-baseline hint when the snapshot is missing", () => {
    const { dir, file } = project(GREET_AND_ROLE);
    const missing = path.join(dir, "does-not-exist.json");
    const r = runCliSubprocess(["check", file, "--snapshot", missing]);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no tool-surface snapshot/i);
    expect(r.stderr).toMatch(/--update/);
    // exit 2 → no JSON shipped on stdout (consistent with the generate path).
    expect(r.stdout.trim()).toBe("");
  });

  it("exit 2 on a file-level failure (nonexistent entry file)", () => {
    const r = runCliSubprocess(["check", "fixtures/this-does-not-exist.ts"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/error:/);
  });

  it("fail-loud: a tool whose type breaks drops out and registers as a BREAKING removal", () => {
    const { file } = project(GREET_AND_ROLE);
    runCliSubprocess(["check", file, "--update"]);

    // Make greet an unbound generic — generateTools excludes it (a hard error),
    // so it disappears from the surface entirely.
    writeFileSync(
      file,
      GREET_AND_ROLE.replace(
        "export function greet(name: string): string {\n  return `hi ${name}`;\n}",
        "export function greet<T>(name: T): string {\n  return `hi ${String(name)}`;\n}",
      ),
    );

    const r = runCliSubprocess(["check", file]);
    expect(r.exitCode).toBe(1);
    expect(r.json.changes.some((c: any) => c.tool === "greet" && c.kind === "tool-removed" && c.severity === "BREAKING")).toBe(true);
    // The generator's per-function error is surfaced as context on stderr.
    expect(r.stderr).toMatch(/greet/);
  });
});

describe("mcp-gen check — determinism through the real generator", () => {
  it("reordering source declarations produces an identical snapshot", () => {
    const reversed = `
/**
 * Sets a role.
 * @param role - the role to set
 */
export function setRole(role: "admin" | "user"): string {
  return role;
}

/**
 * Greets a person.
 * @param name - the person's name
 */
export function greet(name: string): string {
  return \`hi \${name}\`;
}
`;
    const a = project(GREET_AND_ROLE);
    const b = project(reversed);
    runCliSubprocess(["check", a.file, "--update"]);
    runCliSubprocess(["check", b.file, "--update"]);

    expect(readFileSync(b.snapshot, "utf8")).toBe(readFileSync(a.snapshot, "utf8"));
  });
});
