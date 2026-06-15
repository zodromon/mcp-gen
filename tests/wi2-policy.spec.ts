/**
 * WI-2: per-function fail-loud contract — the per-type policy table
 * (HARDENING.md work item 2). Each row is exercised against the case7a–e
 * fixtures at the library level (`generateTools`); CLI exit codes live in
 * wi2-exit-codes.spec.ts.
 *
 * Contract under test:
 *  - A function with any HARD input-position failure is EXCLUDED from `tools`
 *    and recorded in `errors`. Clean functions in the same file are still emitted.
 *  - Widen+warning (constrained generic) and {}+warning (author any/unknown)
 *    still EMIT the tool — they are not failures.
 *  - No emitted tool's inputSchema carries a `$comment` placeholder.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateTools } from "../src/generate";
import { ROOT } from "./helpers";

const fixture = (name: string) => path.join(ROOT, "fixtures", name);
const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();

describe("WI-2 policy: unbound generic in input position", () => {
  it("excludes the function, records it in errors with the constraint hint; clean siblings still emit", () => {
    const r = generateTools(fixture("case7a-unbound-generic.ts"));

    // `ok(x: string)` is clean and stays; `wrap<T>(value: T, ...)` is excluded.
    expect(names(r.tools)).toEqual(["ok"]);
    expect(r.tools.some((t) => t.name === "wrap")).toBe(false);

    const err = r.errors.find((e) => e.function === "wrap");
    expect(err, "wrap must appear in errors").toBeDefined();
    expect(err!.failures?.some((f) => f.parameterPath.includes("value") && f.typeText === "T")).toBe(true);
    expect(JSON.stringify(err)).toMatch(/add a constraint or use a concrete type/i);
  });
});

describe("WI-2 policy: constrained generic in input position", () => {
  it("widens to the constraint's schema with a warning and still emits (no error)", () => {
    const r = generateTools(fixture("case7b-constrained-generic.ts"));

    expect(r.errors).toEqual([]);
    expect(names(r.tools)).toEqual(["pluckId", "pluckIdConcrete"]);

    const widened = r.tools.find((t) => t.name === "pluckId")!;
    const concrete = r.tools.find((t) => t.name === "pluckIdConcrete")!;

    // `T extends { id: string }` widens to exactly the concrete `{ id: string }` schema.
    expect((widened.inputSchema.properties as any).item).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect((widened.inputSchema.properties as any).item).toEqual(
      (concrete.inputSchema.properties as any).item,
    );

    expect(r.warnings.some((w) => /widen|constraint/i.test(w))).toBe(true);
    expect(JSON.stringify(widened.inputSchema)).not.toContain("$comment");
  });
});

describe("WI-2 policy: the two kinds of `any` are distinct outcomes", () => {
  it("module-resolution any errors (with the diagnostic) while author any/unknown become {} + warning", () => {
    const r = generateTools(fixture("case7c-mixed-any.ts"));

    // fromMissing(config: WidgetConfig) — unresolved import collapsed to `any` → hard error.
    expect(r.tools.some((t) => t.name === "fromMissing")).toBe(false);
    const err = r.errors.find((e) => e.function === "fromMissing");
    expect(err, "fromMissing must be a hard error").toBeDefined();
    expect(JSON.stringify(err)).toMatch(/Cannot find module/i);

    // authorAny(data: any) / authorUnknown(data: unknown) — author-written → {} + warning, emitted.
    const a = r.tools.find((t) => t.name === "authorAny");
    const u = r.tools.find((t) => t.name === "authorUnknown");
    expect(a, "authorAny must be emitted").toBeDefined();
    expect(u, "authorUnknown must be emitted").toBeDefined();
    expect((a!.inputSchema.properties as any).data).toEqual({});
    expect((u!.inputSchema.properties as any).data).toEqual({});

    // Distinct outcomes: the authored anys are NOT errors.
    expect(r.errors.some((e) => e.function === "authorAny")).toBe(false);
    expect(r.errors.some((e) => e.function === "authorUnknown")).toBe(false);
    expect(r.warnings.filter((w) => /accepts any|unconstrained/i.test(w)).length).toBeGreaterThanOrEqual(2);
  });
});

describe("WI-2 policy: non-JSON-serializable input types", () => {
  it("errors on Map/Set/function/symbol/bigint; Date keeps date-time and is emitted", () => {
    const r = generateTools(fixture("case7d-nonserializable.ts"));

    expect(names(r.tools)).toEqual(["takesDate"]);
    expect(r.errors.map((e) => e.function).sort()).toEqual([
      "takesBigint",
      "takesCallback",
      "takesMap",
      "takesSet",
      "takesSymbol",
    ]);
    expect(r.errors.every((e) => /serializ/i.test(JSON.stringify(e)))).toBe(true);

    const date = r.tools.find((t) => t.name === "takesDate")!;
    expect((date.inputSchema.properties as any).when).toEqual({ type: "string", format: "date-time" });
  });
});

describe("WI-2 policy: recursion past the depth cap in input position", () => {
  it("is a hard error (no UNRESOLVED placeholder shipped)", () => {
    const r = generateTools(fixture("case7e-recursive.ts"));

    expect(r.tools).toEqual([]);
    const err = r.errors.find((e) => e.function === "insert");
    expect(err, "insert must be a hard error").toBeDefined();
    expect(JSON.stringify(err)).toMatch(/recursi|depth/i);
  });
});

describe("WI-2 policy: a generic only in return position never blocks", () => {
  it("fetchData<T>(url: string): Promise<T> stays emitted with a perfect input schema", () => {
    const r = generateTools(fixture("case4-generic.ts"));

    const fetchData = r.tools.find((t) => t.name === "fetchData");
    expect(fetchData, "fetchData must be emitted").toBeDefined();
    expect(fetchData!.inputSchema).toEqual({
      type: "object",
      properties: { url: { type: "string", description: "The URL to fetch" } },
      required: ["url"],
    });
    expect(r.errors.some((e) => e.function === "fetchData")).toBe(false);

    // Sanity that the file does still produce input-position failures elsewhere:
    expect(r.errors.some((e) => e.function === "wrap")).toBe(true);
  });
});

describe("WI-2 policy: a parameter typed `undefined` has no JSON Schema representation", () => {
  it("is a hard error (not a silently-emitted $comment); clean siblings still emit", () => {
    const r = generateTools(fixture("case7f-undefined.ts"));

    expect(names(r.tools)).toEqual(["cleanFn"]);
    expect(r.tools.some((t) => t.name === "undefinedParam")).toBe(false);
    const err = r.errors.find((e) => e.function === "undefinedParam");
    expect(err, "undefinedParam must be a hard error").toBeDefined();
  });
});

describe("WI-2 invariant: emitted tools never carry an input-position $comment", () => {
  const ALL_FIXTURES = [
    "case1-primitives.ts",
    "case2-optional.ts",
    "case3-object.ts",
    "case4-generic.ts",
    "case5-imported.ts",
    "case5b-missing-import.ts",
    "case6-export-styles.ts",
    "case6-twins.ts",
    "case7a-unbound-generic.ts",
    "case7b-constrained-generic.ts",
    "case7c-mixed-any.ts",
    "case7d-nonserializable.ts",
    "case7e-recursive.ts",
    "case7f-undefined.ts",
  ];

  it("holds across every fixture", () => {
    for (const f of ALL_FIXTURES) {
      const r = generateTools(fixture(f));
      for (const tool of r.tools) {
        expect(JSON.stringify(tool.inputSchema), `${f} → ${tool.name} leaked a $comment`).not.toContain(
          "$comment",
        );
      }
    }
  });
});
