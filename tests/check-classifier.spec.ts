/**
 * The classifier matrix (the heart of `mcp-gen check`) — pure, zero-I/O unit
 * tests of diffToolSurfaces. One case per row of the severity policy table,
 * plus nested recursion, the fail-loud-drop case, and the determinism proof.
 *
 * Severity contract (from an existing caller's perspective):
 *   BREAKING — tool removed/renamed, property removed, property added required,
 *              optional→required, type changed, enum value removed, nested
 *              sub-schema changed.
 *   SAFE     — tool added, property added optional, required→optional, enum
 *              value added.
 *   NOTICE   — tool/param description changed, return type changed.
 *   check fails iff any BREAKING exists.
 */
import { describe, expect, it } from "vitest";
import {
  type Change,
  diffToolSurfaces,
  hasBreaking,
  serializeSnapshot,
  parseSnapshot,
  type ToolSnapshot,
} from "../src/check";

// --- tiny builders -------------------------------------------------------

type Schema = Record<string, unknown>;

function obj(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function tool(
  name: string,
  inputSchema: Schema,
  opts: { description?: string; returnType?: unknown } = {},
): ToolSnapshot {
  return {
    name,
    description: opts.description ?? "",
    inputSchema,
    _returnType: opts.returnType ?? { text: "void", awaitedSchema: { $comment: "void" } },
  };
}

/** The single change matching kind+severity, asserted to be unique. */
function only(changes: Change[], kind: string, severity: string): Change {
  const matches = changes.filter((c) => c.kind === kind && c.severity === severity);
  expect(matches, `expected exactly one ${severity} ${kind}, got ${JSON.stringify(changes)}`).toHaveLength(1);
  return matches[0];
}

// A base single-tool surface reused across rows.
const greet = tool("greet", obj({ name: { type: "string" } }, ["name"]));

describe("classifier matrix: tool-level", () => {
  it("tool added → SAFE (no breaking)", () => {
    const changes = diffToolSurfaces([greet], [greet, tool("farewell", obj({}))]);
    only(changes, "tool-added", "SAFE");
    expect(hasBreaking(changes)).toBe(false);
  });

  it("tool removed → BREAKING", () => {
    const changes = diffToolSurfaces([greet, tool("farewell", obj({}))], [greet]);
    const c = only(changes, "tool-removed", "BREAKING");
    expect(c.tool).toBe("farewell");
    expect(hasBreaking(changes)).toBe(true);
  });

  it("tool renamed (= remove + add) → BREAKING removal + SAFE add", () => {
    const changes = diffToolSurfaces([greet], [tool("salute", obj({ name: { type: "string" } }, ["name"]))]);
    expect(only(changes, "tool-removed", "BREAKING").tool).toBe("greet");
    expect(only(changes, "tool-added", "SAFE").tool).toBe("salute");
    expect(hasBreaking(changes)).toBe(true);
  });
});

describe("classifier matrix: property add / remove", () => {
  it("property added as required → BREAKING", () => {
    const next = tool("greet", obj({ name: { type: "string" }, age: { type: "number" } }, ["name", "age"]));
    const changes = diffToolSurfaces([greet], [next]);
    expect(only(changes, "property-added-required", "BREAKING").detail).toMatch(/age/);
    expect(hasBreaking(changes)).toBe(true);
  });

  it("property added as optional → SAFE (no breaking)", () => {
    const next = tool("greet", obj({ name: { type: "string" }, age: { type: "number" } }, ["name"]));
    const changes = diffToolSurfaces([greet], [next]);
    expect(only(changes, "property-added-optional", "SAFE").detail).toMatch(/age/);
    expect(hasBreaking(changes)).toBe(false);
  });

  it("property removed → BREAKING", () => {
    const before = tool("greet", obj({ name: { type: "string" }, age: { type: "number" } }, ["name", "age"]));
    const changes = diffToolSurfaces([before], [greet]);
    expect(only(changes, "property-removed", "BREAKING").detail).toMatch(/age/);
    expect(hasBreaking(changes)).toBe(true);
  });
});

describe("classifier matrix: required transitions", () => {
  it("optional → required → BREAKING", () => {
    const before = tool("greet", obj({ name: { type: "string" } })); // name optional
    const after = tool("greet", obj({ name: { type: "string" } }, ["name"])); // name required
    const changes = diffToolSurfaces([before], [after]);
    only(changes, "optional-to-required", "BREAKING");
    expect(hasBreaking(changes)).toBe(true);
  });

  it("required → optional → SAFE (no breaking)", () => {
    const before = tool("greet", obj({ name: { type: "string" } }, ["name"]));
    const after = tool("greet", obj({ name: { type: "string" } }));
    const changes = diffToolSurfaces([before], [after]);
    only(changes, "required-to-optional", "SAFE");
    expect(hasBreaking(changes)).toBe(false);
  });
});

describe("classifier matrix: type & enum", () => {
  it("property type changed (number → string) → BREAKING", () => {
    const before = tool("calc", obj({ x: { type: "number" } }, ["x"]));
    const after = tool("calc", obj({ x: { type: "string" } }, ["x"]));
    const changes = diffToolSurfaces([before], [after]);
    const c = only(changes, "property-type-changed", "BREAKING");
    expect(c.detail).toMatch(/number/);
    expect(c.detail).toMatch(/string/);
    expect(hasBreaking(changes)).toBe(true);
  });

  it("enum value removed → BREAKING", () => {
    const before = tool("setRole", obj({ role: { type: "string", enum: ["admin", "user", "guest"] } }, ["role"]));
    const after = tool("setRole", obj({ role: { type: "string", enum: ["admin", "user"] } }, ["role"]));
    const changes = diffToolSurfaces([before], [after]);
    expect(only(changes, "enum-value-removed", "BREAKING").detail).toMatch(/guest/);
    expect(hasBreaking(changes)).toBe(true);
  });

  it("enum value added → SAFE (no breaking)", () => {
    const before = tool("setRole", obj({ role: { type: "string", enum: ["admin", "user"] } }, ["role"]));
    const after = tool("setRole", obj({ role: { type: "string", enum: ["admin", "user", "guest"] } }, ["role"]));
    const changes = diffToolSurfaces([before], [after]);
    expect(only(changes, "enum-value-added", "SAFE").detail).toMatch(/guest/);
    expect(hasBreaking(changes)).toBe(false);
  });

  it("TS enum (no `type`) membership is diffed the same way", () => {
    const before = tool("pick", obj({ n: { enum: [0, 1, 2] } }, ["n"]));
    const after = tool("pick", obj({ n: { enum: [0, 1] } }, ["n"]));
    const changes = diffToolSurfaces([before], [after]);
    expect(only(changes, "enum-value-removed", "BREAKING").detail).toMatch(/2/);
  });
});

describe("classifier matrix: nested / complex sub-schemas", () => {
  it("recurses into nested object properties (nested type change → BREAKING at the nested path)", () => {
    const before = tool("save", obj({ opts: obj({ size: { type: "number" } }, ["size"]) }, ["opts"]));
    const after = tool("save", obj({ opts: obj({ size: { type: "string" } }, ["size"]) }, ["opts"]));
    const changes = diffToolSurfaces([before], [after]);
    const c = only(changes, "property-type-changed", "BREAKING");
    expect(c.detail).toMatch(/opts\.size/);
  });

  it("nested required property added → BREAKING at the nested path", () => {
    const before = tool("save", obj({ opts: obj({ a: { type: "string" } }, ["a"]) }, ["opts"]));
    const after = tool("save", obj({ opts: obj({ a: { type: "string" }, b: { type: "number" } }, ["a", "b"]) }, ["opts"]));
    const changes = diffToolSurfaces([before], [after]);
    expect(only(changes, "property-added-required", "BREAKING").detail).toMatch(/opts\.b/);
  });

  it("array element type change → BREAKING via conservative deep-compare (subschema-changed)", () => {
    const before = tool("tag", obj({ tags: { type: "array", items: { type: "string" } } }, ["tags"]));
    const after = tool("tag", obj({ tags: { type: "array", items: { type: "number" } } }, ["tags"]));
    const changes = diffToolSurfaces([before], [after]);
    only(changes, "subschema-changed", "BREAKING");
    expect(hasBreaking(changes)).toBe(true);
  });

  it("an identical complex sub-schema yields no change (equal ⇒ nothing)", () => {
    const schema = obj({ tags: { type: "array", items: { type: "string" } } }, ["tags"]);
    const changes = diffToolSurfaces([tool("tag", schema)], [tool("tag", schema)]);
    expect(changes).toEqual([]);
  });

  it("object-level keywords beyond properties/required (additionalProperties) are caught → BREAKING, top-level", () => {
    // An index-signature param: { [k: string]: T } emits additionalProperties.
    const before = tool("bag", { type: "object", properties: {}, additionalProperties: { type: "string" } });
    const after = tool("bag", { type: "object", properties: {}, additionalProperties: { type: "number" } });
    const c = only(diffToolSurfaces([before], [after]), "subschema-changed", "BREAKING");
    expect(c.detail).toMatch(/bag/);
  });

  it("additionalProperties change on a NESTED object param → BREAKING at the nested path", () => {
    const before = tool("save", obj({ meta: { type: "object", properties: {}, additionalProperties: { type: "string" } } }, ["meta"]));
    const after = tool("save", obj({ meta: { type: "object", properties: {}, additionalProperties: { type: "number" } } }, ["meta"]));
    const c = only(diffToolSurfaces([before], [after]), "subschema-changed", "BREAKING");
    expect(c.detail).toMatch(/meta/);
  });

  it("removing an index signature (additionalProperties dropped) → BREAKING", () => {
    const before = tool("bag", { type: "object", properties: {}, additionalProperties: { type: "string" } });
    const after = tool("bag", { type: "object", properties: {} });
    expect(hasBreaking(diffToolSurfaces([before], [after]))).toBe(true);
  });
});

describe("classifier matrix: notices (never fail)", () => {
  it("tool description changed → NOTICE", () => {
    const before = tool("greet", obj({ name: { type: "string" } }, ["name"]), { description: "old" });
    const after = tool("greet", obj({ name: { type: "string" } }, ["name"]), { description: "new" });
    const changes = diffToolSurfaces([before], [after]);
    only(changes, "tool-description-changed", "NOTICE");
    expect(hasBreaking(changes)).toBe(false);
  });

  it("param description changed → NOTICE (structure unchanged)", () => {
    const before = tool("greet", obj({ name: { type: "string", description: "old" } }, ["name"]));
    const after = tool("greet", obj({ name: { type: "string", description: "new" } }, ["name"]));
    const changes = diffToolSurfaces([before], [after]);
    only(changes, "param-description-changed", "NOTICE");
    expect(hasBreaking(changes)).toBe(false);
  });

  it("return type changed → NOTICE (not part of the input contract)", () => {
    const before = tool("greet", obj({ name: { type: "string" } }, ["name"]), {
      returnType: { text: "string", awaitedSchema: { type: "string" } },
    });
    const after = tool("greet", obj({ name: { type: "string" } }, ["name"]), {
      returnType: { text: "number", awaitedSchema: { type: "number" } },
    });
    const changes = diffToolSurfaces([before], [after]);
    only(changes, "return-type-changed", "NOTICE");
    expect(hasBreaking(changes)).toBe(false);
  });
});

describe("classifier matrix: fail-loud drop", () => {
  it("a tool that fails generation is absent from the new surface → registers as removed=BREAKING", () => {
    // Models WI-2 fail-loud: `wrap` used to convert; after its type broke it is
    // excluded from `tools`, so it simply isn't in the new surface.
    const before = [greet, tool("wrap", obj({ value: { type: "string" } }, ["value"]))];
    const after = [greet]; // wrap dropped out (now in generator `errors`, not `tools`)
    const changes = diffToolSurfaces(before, after);
    expect(only(changes, "tool-removed", "BREAKING").tool).toBe("wrap");
    expect(hasBreaking(changes)).toBe(true);
  });
});

describe("determinism: byte-stable normalization regardless of source order", () => {
  it("the same surface in different declaration / key / required order normalizes to identical bytes", () => {
    const canonicalA: ToolSnapshot[] = [
      tool("alpha", obj({ a: { type: "string" }, b: { type: "number" } }, ["a", "b"]), {
        description: "A",
        returnType: { text: "string", awaitedSchema: { type: "string" } },
      }),
      tool("beta", obj({ x: { type: "boolean" } }, ["x"])),
    ];

    // Same surface, shuffled: tool order, object-key order, and required order.
    const shuffledB: ToolSnapshot[] = [
      {
        _returnType: { awaitedSchema: { type: "boolean" }, text: "void" } as unknown,
        inputSchema: { properties: { x: { type: "boolean" } }, required: ["x"], type: "object" },
        description: "",
        name: "beta",
      },
      {
        name: "alpha",
        _returnType: { text: "string", awaitedSchema: { type: "string" } } as unknown,
        inputSchema: { required: ["b", "a"], type: "object", properties: { b: { type: "number" }, a: { type: "string" } } },
        description: "A",
      },
    ];
    // beta's return type differs only by the void shape — align it so the two
    // surfaces are genuinely the same contract.
    shuffledB[0]._returnType = { text: "void", awaitedSchema: { $comment: "void" } };

    expect(serializeSnapshot(canonicalA)).toBe(serializeSnapshot(shuffledB));
  });

  it("a serialized snapshot round-trips and diffs clean against its own surface", () => {
    const surface = [
      tool("greet", obj({ name: { type: "string" } }, ["name"])),
      tool("calc", obj({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"])),
    ];
    const restored = parseSnapshot(serializeSnapshot(surface));
    expect(diffToolSurfaces(restored, surface)).toEqual([]);
  });

  it("serializeSnapshot output is byte-for-byte identical on a second pass (idempotent)", () => {
    const surface = [tool("z", obj({ b: { type: "string" }, a: { type: "number" } }, ["b", "a"]))];
    const once = serializeSnapshot(surface);
    const twice = serializeSnapshot(parseSnapshot(once));
    expect(twice).toBe(once);
  });

  it("enum member order does not affect snapshot bytes (enum is a set, like required)", () => {
    const a = [tool("setRole", obj({ role: { type: "string", enum: ["admin", "user", "guest"] } }, ["role"]))];
    const b = [tool("setRole", obj({ role: { type: "string", enum: ["guest", "admin", "user"] } }, ["role"]))];
    expect(serializeSnapshot(a)).toBe(serializeSnapshot(b));
    // ...and the classifier agrees the contract is unchanged.
    expect(diffToolSurfaces(a, b)).toEqual([]);
  });

  it("numeric enum order does not affect snapshot bytes", () => {
    const a = [tool("pick", obj({ n: { enum: [2, 10, 1] } }, ["n"]))];
    const b = [tool("pick", obj({ n: { enum: [10, 1, 2] } }, ["n"]))];
    expect(serializeSnapshot(a)).toBe(serializeSnapshot(b));
  });
});

describe("snapshot parsing: malformed snapshots are rejected", () => {
  it("rejects non-JSON", () => {
    expect(() => parseSnapshot("not json")).toThrow(/not valid JSON/i);
  });
  it("rejects an unrecognized schema id", () => {
    expect(() => parseSnapshot(JSON.stringify({ schema: "other", version: 1, tools: [] }))).toThrow(/unrecognized/i);
  });
  it("rejects an unsupported version", () => {
    expect(() => parseSnapshot(JSON.stringify({ schema: "mcp-gen/tool-surface", version: 99, tools: [] }))).toThrow(/version/i);
  });
  it("rejects a missing tools array", () => {
    expect(() => parseSnapshot(JSON.stringify({ schema: "mcp-gen/tool-surface", version: 1 }))).toThrow(/tools/i);
  });
});
