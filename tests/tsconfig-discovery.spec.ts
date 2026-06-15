/**
 * tsconfig / project discovery (the resolution-context feature).
 *
 * generateTools resolves the entry file against the user's REAL project: it
 * discovers the nearest tsconfig by walking up from the file (or honors an
 * explicit override / a passed `--tsconfig`), takes that tsconfig's compiler
 * options + module resolution (paths, baseUrl, types, node_modules), and adds
 * ONLY the entry file plus its real import closure — never every file the
 * tsconfig's `include` matches.
 *
 * This kills the REPORT case 5b false positive: an imported/external type that
 * only resolves under the project's own `paths`/`baseUrl` now inlines instead
 * of collapsing to a "Cannot find module" → `any` hard error.
 *
 * The mini-projects under tests/projects/ each carry their OWN tsconfig and are
 * excluded from the root typecheck (see tsconfig.json) — they are generateTools
 * fixtures, not source.
 */
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { generateTools } from "../src/generate";
import { ROOT, runCliSubprocess } from "./helpers";

const proj = (...p: string[]) => path.join(ROOT, "tests", "projects", ...p);

// The external interface ext/types.ts declares — what should inline into the
// `config` parameter once `@ext/types` resolves.
const WIDGET_CONFIG_PROPS = {
  title: { type: "string" },
  maxWidth: { type: "number" },
  enabled: { type: "boolean" },
};

describe("(A) external type resolves via the discovered tsconfig — the core win", () => {
  it("inlines the `@ext/*`-aliased interface's properties with no error", () => {
    const r = generateTools(proj("with-tsconfig", "tools.ts"));

    // The aliased import resolved: no fail-loud for configureWidget.
    expect(r.errors).toEqual([]);
    const tool = r.tools.find((t) => t.name === "configureWidget");
    expect(tool, "configureWidget must be emitted").toBeDefined();

    const config = (tool!.inputSchema.properties as any).config;
    expect(config.type).toBe("object");
    expect(config.properties).toEqual(WIDGET_CONFIG_PROPS);
    expect([...config.required].sort()).toEqual(["enabled", "maxWidth", "title"]);
  });

  it("CONTROL: the same import shape with no matching alias still fail-louds (discovery is what fixed it)", () => {
    // without-alias/ is byte-identical to with-tsconfig/ minus the `@ext/*`
    // alias. Same `@ext/types` import → unresolvable → module-resolution `any`
    // → hard error. Proves the discovered tsconfig's `paths` is the variable
    // that turned case 5b into case 5.
    const r = generateTools(proj("without-alias", "tools.ts"));

    expect(r.tools.some((t) => t.name === "configureWidget")).toBe(false);
    const err = r.errors.find((e) => e.function === "configureWidget");
    expect(err, "configureWidget must fail-loud without the alias").toBeDefined();
    expect(JSON.stringify(err)).toMatch(/Cannot find module '@ext\/types'/i);
  });
});

describe("(B) no project ballooning — skipAddingFilesFromTsConfig is in effect", () => {
  it("loads only the entry + its real import closure, not the 30 decoys the `include` matches", () => {
    // The mini-project's tsconfig `include` is "**/*.ts" — it matches tools.ts,
    // ext/types.ts, nested/usesExt.ts, AND 30 unrelated decoys. Loading is
    // all-or-nothing: if `include` were honored the Project would hold 30+
    // files; with skipAddingFilesFromTsConfig it holds only the entry and what
    // the entry actually imports.
    const decoys = fs
      .readdirSync(proj("with-tsconfig"))
      .filter((f) => /^decoy\d+\.ts$/.test(f));
    expect(decoys.length).toBe(30); // guard: the decoys exist and `include` matches them

    const r = generateTools(proj("with-tsconfig", "tools.ts"));

    // entry (tools.ts) + its sole import (ext/types.ts) = 2. Single digits.
    expect(r.project.sourceFileCount).toBe(2);
    expect(r.project.sourceFileCount).toBeLessThan(10);

    // Explicit anti-balloon proof: the loaded count is far below the decoy
    // count alone. Since the include would pull ALL 30 decoys (or none), a
    // count of 2 means not one decoy — nor nested/usesExt.ts — was loaded.
    expect(r.project.sourceFileCount).toBeLessThan(decoys.length);
  });
});

describe("(C) discovery + fallback + override", () => {
  it("discovers the walked-up tsconfig for a file in a nested subdirectory", () => {
    // nested/usesExt.ts sits one dir below the tsconfig; discovery must walk up.
    const r = generateTools(proj("with-tsconfig", "nested", "usesExt.ts"));

    expect(r.project.tsconfigPath).toBe(proj("with-tsconfig", "tsconfig.json"));
    expect(r.errors).toEqual([]);
    expect(r.tools.map((t) => t.name)).toContain("nestedTool");
  });

  it("falls back to inline defaults (tsconfigPath null) for a standalone file under no project", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gen-discovery-"));
    try {
      const file = path.join(tmp, "standalone.ts");
      fs.writeFileSync(file, "export function add(a: number, b: number): number { return a + b; }\n");

      const r = generateTools(file);

      // No tsconfig anywhere up the tmp tree → null, and the inline defaults
      // still generate the tool.
      expect(r.project.tsconfigPath).toBeNull();
      expect(r.project.sourceFileCount).toBe(1);
      expect(r.tools.map((t) => t.name)).toEqual(["add"]);
      expect(r.errors).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("honors an explicit { tsconfig } override (library option)", () => {
    // Point the alias-less control file at the with-tsconfig tsconfig: now the
    // `@ext/*` alias resolves and the previously-failing function is emitted.
    const override = proj("with-tsconfig", "tsconfig.json");
    const r = generateTools(proj("without-alias", "tools.ts"), { tsconfig: override });

    expect(r.project.tsconfigPath).toBe(override);
    expect(r.errors).toEqual([]);
    expect(r.tools.map((t) => t.name)).toContain("configureWidget");
  });

  it("honors --tsconfig on the CLI (subprocess)", () => {
    // Same override, but through the real CLI flag and a spawned process.
    const r = runCliSubprocess([
      "tests/projects/without-alias/tools.ts",
      "--tsconfig",
      "tests/projects/with-tsconfig/tsconfig.json",
    ]);

    expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.json, `stdout was not valid JSON:\n${r.stdout}`).toBeDefined();
    expect(r.json.tools.map((t: any) => t.name)).toContain("configureWidget");
    expect(r.json.errors).toBeUndefined();
  });
});

describe("(D) backward-compat: discovery does not perturb the existing fixtures", () => {
  it("finds the repo's own tsconfig for the in-repo fixtures, yet emits the same clean tools", () => {
    // fixtures/ live under the repo root, which has a tsconfig.json — so
    // discovery now finds it for them. Strict mode matches the old inline
    // default (both strict:true), so cases 1/2/3/5 stay byte-identical (pinned
    // by the regression specs); here we just confirm the discovered path is the
    // repo root tsconfig and a clean fixture stays clean.
    const r = generateTools(path.join(ROOT, "fixtures", "case1-primitives.ts"));

    expect(r.project.tsconfigPath).toBe(path.join(ROOT, "tsconfig.json"));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.tools.map((t) => t.name)).toEqual(["greet"]);
  });
});
