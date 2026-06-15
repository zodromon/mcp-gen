/**
 * WI-1: exported arrow functions and function expressions must produce schemas
 * identical to the same signatures written as `function` declarations
 * (HARDENING.md work item 1 acceptance criterion).
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateTools } from "../src/generate";
import { ROOT } from "./helpers";

const fixture = (name: string) => path.join(ROOT, "fixtures", name);

describe("export styles: arrows & function expressions", () => {
  it("all five forms produce schemas deep-equal to their declaration twins", () => {
    const styles = generateTools(fixture("case6-export-styles.ts"));
    const twins = generateTools(fixture("case6-twins.ts"));

    expect(styles.errors).toEqual([]);
    expect(styles.warnings).toEqual([]);

    const styleMap = new Map(styles.tools.map((t) => [t.name, t]));
    const twinMap = new Map(twins.tools.map((t) => [t.name, t]));

    expect([...styleMap.keys()].sort()).toEqual(["a", "b", "c", "d", "named"]);
    expect([...styleMap.keys()].sort()).toEqual([...twinMap.keys()].sort());

    for (const [name, tool] of styleMap) {
      expect(tool, `tool '${name}' should equal its declaration twin`).toEqual(twinMap.get(name));
    }
  });

  it("JSDoc on the variable statement maps to description and @param", () => {
    const { tools } = generateTools(fixture("case6-export-styles.ts"));
    const d = tools.find((t) => t.name === "d");
    expect(d).toBeDefined();
    expect(d!.description).toBe("Echoes a string.");
    expect((d!.inputSchema.properties as any).x.description).toBe("The input string");
  });

  it("anonymous default export is a hard error and no name is invented", () => {
    const result = generateTools(fixture("case6b-anonymous-default.ts"));
    expect(result.tools).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/stable names/i);
  });

  it("aliased export pointing at a skipped function emits a warning", () => {
    const result = generateTools(fixture("case6c-aliased-export.ts"));
    expect(result.tools).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("renamed");
  });
});
