/**
 * Stage B unit tests for the PURE schema→form mapping (no DOM, no server).
 *
 * Covers the spec's required matrix — string / number / boolean / enum /
 * array-fallback / required — plus the shapes generateTools actually emits:
 * integer, numeric vs. string enum, const literal, object/any JSON fallback,
 * description passthrough, and whole-inputSchema ordering.
 */
import { describe, expect, it } from "vitest";
import { schemaPropertyToField, inputSchemaToFields } from "../src/ui-schema";

describe("schemaPropertyToField", () => {
  it("string → text field", () => {
    expect(schemaPropertyToField("name", { type: "string" }, true)).toEqual({
      name: "name",
      kind: "string",
      required: true,
    });
  });

  it("number → number field", () => {
    expect(schemaPropertyToField("age", { type: "number" }, false)).toEqual({
      name: "age",
      kind: "number",
      required: false,
    });
  });

  it("integer → integer field", () => {
    expect(schemaPropertyToField("count", { type: "integer" }, true).kind).toBe("integer");
  });

  it("boolean → checkbox field", () => {
    expect(schemaPropertyToField("flag", { type: "boolean" }, true).kind).toBe("boolean");
  });

  it("string literal union → enum (non-numeric)", () => {
    const f = schemaPropertyToField("color", { type: "string", enum: ["red", "green", "blue"] }, true);
    expect(f.kind).toBe("enum");
    expect(f.enumValues).toEqual(["red", "green", "blue"]);
    expect(f.numericEnum).toBe(false);
  });

  it("numeric literal union → enum (numeric)", () => {
    const f = schemaPropertyToField("level", { type: "number", enum: [1, 2, 3] }, true);
    expect(f.kind).toBe("enum");
    expect(f.enumValues).toEqual([1, 2, 3]);
    expect(f.numericEnum).toBe(true);
  });

  it("TS enum (no `type`, numeric members) → enum (numeric)", () => {
    const f = schemaPropertyToField("dir", { enum: [0, 1] }, true);
    expect(f.kind).toBe("enum");
    expect(f.numericEnum).toBe(true);
  });

  it("const literal → enum with a single value", () => {
    const f = schemaPropertyToField("kind", { type: "string", const: "fixed" }, true);
    expect(f.kind).toBe("enum");
    expect(f.enumValues).toEqual(["fixed"]);
    expect(f.numericEnum).toBe(false);
  });

  it("array → raw-JSON fallback", () => {
    const f = schemaPropertyToField("tags", { type: "array", items: { type: "string" } }, false);
    expect(f.kind).toBe("json");
  });

  it("object → raw-JSON fallback", () => {
    const f = schemaPropertyToField(
      "opts",
      { type: "object", properties: { a: { type: "string" } } },
      true,
    );
    expect(f.kind).toBe("json");
  });

  it("anyOf union → raw-JSON fallback", () => {
    const f = schemaPropertyToField("u", { anyOf: [{ type: "string" }, { type: "number" }] }, true);
    expect(f.kind).toBe("json");
  });

  it("permissive {} (any/unknown) → raw-JSON fallback", () => {
    expect(schemaPropertyToField("anything", {}, false).kind).toBe("json");
  });

  it("carries through the JSDoc description", () => {
    const f = schemaPropertyToField("name", { type: "string", description: "the person's name" }, true);
    expect(f.description).toBe("the person's name");
  });

  it("missing schema → safe JSON fallback", () => {
    expect(schemaPropertyToField("x", undefined, false)).toEqual({
      name: "x",
      kind: "json",
      required: false,
    });
  });
});

describe("inputSchemaToFields", () => {
  it("maps a whole inputSchema in parameter order with required flags", () => {
    const inputSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        active: { type: "boolean" },
      },
      required: ["name", "age"],
    };
    const fields = inputSchemaToFields(inputSchema);
    expect(fields.map((f) => f.name)).toEqual(["name", "age", "active"]);
    expect(fields.map((f) => f.kind)).toEqual(["string", "number", "boolean"]);
    expect(fields.map((f) => f.required)).toEqual([true, true, false]);
  });

  it("a no-arg tool maps to an empty field list", () => {
    expect(inputSchemaToFields({ type: "object", properties: {} })).toEqual([]);
    expect(inputSchemaToFields({ type: "object" })).toEqual([]);
  });
});
