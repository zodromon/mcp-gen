/**
 * The schema→form mapping, factored as a PURE function so it is unit-testable
 * independent of the DOM. Given one JSON Schema property (a shape generateTools
 * emits), it returns a `FieldDescriptor` describing the input control to render
 * and how to coerce its value before sending it back over /api/call.
 *
 * The inlined browser UI (src/dev-ui.ts) carries a faithful JS transcription of
 * `schemaPropertyToField` — keep the two in sync. This TS copy is the canonical,
 * tested one; the transcription exists only because the UI ships as a no-bundler
 * inline string.
 *
 * Mapping (see the JSON Schema shapes generateTools emits in src/generate.ts):
 *   { type: "string" }                       → "string"   (text input)
 *   { type: "number" }                       → "number"   (number input)
 *   { type: "integer" }                      → "integer"  (number input, step 1)
 *   { type: "boolean" }                      → "boolean"  (checkbox)
 *   { enum: [...] } / { type, enum: [...] }  → "enum"     (<select>)
 *   { const: x }                             → "enum"     (single fixed value)
 *   { type: "array" | "object" }             → "json"     (raw-JSON textarea)
 *   { anyOf } / { prefixItems } / {}         → "json"     (raw-JSON fallback)
 */

export type FieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "json";

export interface FieldDescriptor {
  /** The property (parameter) name. */
  name: string;
  /** The input control to render. */
  kind: FieldKind;
  /** Whether the schema lists this property as required. */
  required: boolean;
  /** JSDoc-derived description, when the schema carries one. */
  description?: string;
  /** Allowed values for an enum/const field, in schema order. */
  enumValues?: Array<string | number | boolean>;
  /** True when an enum's members are numeric, so the UI coerces to Number. */
  numericEnum?: boolean;
}

/** Map one JSON Schema property to the form field that should represent it. */
export function schemaPropertyToField(
  name: string,
  schema: Record<string, unknown> | undefined,
  required: boolean,
): FieldDescriptor {
  const base: FieldDescriptor = { name, kind: "json", required };
  if (!schema || typeof schema !== "object") return base;

  const description = typeof schema.description === "string" ? schema.description : undefined;
  if (description) base.description = description;

  // const — a literal parameter. One fixed value, rendered as a single-option
  // select so the UI can still coerce/submit it.
  if ("const" in schema) {
    const v = schema.const as string | number | boolean;
    return { ...base, kind: "enum", enumValues: [v], numericEnum: typeof v === "number" };
  }

  // enum — TS enums (no `type`) and literal unions (with `type`).
  if (Array.isArray(schema.enum)) {
    const values = schema.enum as Array<string | number | boolean>;
    const numericEnum =
      schema.type === "number" ||
      schema.type === "integer" ||
      (values.length > 0 && values.every((v) => typeof v === "number"));
    return { ...base, kind: "enum", enumValues: values, numericEnum };
  }

  switch (schema.type) {
    case "boolean":
      return { ...base, kind: "boolean" };
    case "integer":
      return { ...base, kind: "integer" };
    case "number":
      return { ...base, kind: "number" };
    case "string":
      return { ...base, kind: "string" };
    // array / object → raw JSON textarea. anyOf / prefixItems /
    // additionalProperties / the permissive {} (no `type`) all fall through to
    // the JSON fallback in `base`.
    default:
      return base;
  }
}

/** Map a tool's whole inputSchema to an ordered list of form fields. */
export function inputSchemaToFields(
  inputSchema: Record<string, unknown> | undefined,
): FieldDescriptor[] {
  if (!inputSchema || typeof inputSchema !== "object") return [];
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];
  // Object key order is insertion order, which is the schema's parameter order.
  return Object.entries(properties).map(([name, propSchema]) =>
    schemaPropertyToField(name, propSchema, required.includes(name)),
  );
}
