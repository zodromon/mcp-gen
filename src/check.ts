/**
 * Pure contract-diff core for `mcp-gen check` — zero I/O.
 *
 * This is the heart of the guardrail: a side-effect-free classifier plus the
 * deterministic snapshot normalization it relies on. No fs, no console, no
 * generateTools call — those live in the CLI shell (src/cli.ts). Keeping this
 * file pure is what lets the classifier be exhaustively unit-tested.
 *
 * Three responsibilities:
 *   1. diffToolSurfaces(old, new) → Change[]    — the classifier.
 *   2. serializeSnapshot / canonicalize         — deterministic, byte-stable
 *      normalization so a committed snapshot is review-friendly and re-running on
 *      an unchanged surface produces identical bytes regardless of source order.
 *   3. parseSnapshot                            — read a snapshot back, validating
 *      its header/version (a malformed snapshot is a file-level failure).
 *
 * Every change is judged from the perspective of an existing caller (an agent)
 * that depends on the contract. Anything that can break such a caller is
 * BREAKING; anything purely additive or loosening is SAFE; anything cosmetic or
 * outside the *input* contract is NOTICE. `check` fails iff any BREAKING exists.
 */
import type { McpToolDefinition } from "./generate";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Severity = "BREAKING" | "SAFE" | "NOTICE";

export type ChangeKind =
  | "tool-removed"
  | "tool-added"
  | "property-removed"
  | "property-added-required"
  | "property-added-optional"
  | "optional-to-required"
  | "required-to-optional"
  | "property-type-changed"
  | "enum-value-removed"
  | "enum-value-added"
  | "subschema-changed"
  | "tool-description-changed"
  | "param-description-changed"
  | "return-type-changed";

/** One classified difference between two tool surfaces. */
export interface Change {
  /** The tool the change belongs to. */
  tool: string;
  kind: ChangeKind;
  /** Human-readable specifics (property path, enum value, from/to type, …). */
  detail: string;
  severity: Severity;
}

/** One tool's contract-relevant shape. A surface is a list of these. */
export interface ToolSnapshot {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  /** Recorded so return-type changes can be flagged (NOTICE); not input contract. */
  _returnType?: unknown;
}

export type ToolSurface = ToolSnapshot[];

type JsonSchema = Record<string, unknown>;

/** The committed snapshot file format. */
export const SNAPSHOT_SCHEMA_ID = "mcp-gen/tool-surface";
export const SNAPSHOT_VERSION = 1;

/** A snapshot that can't be parsed / is the wrong version. CLI maps to exit 2. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/**
 * Diff two tool surfaces and classify every change by severity.
 *
 * Inputs are canonicalized first, so the result is independent of key/property
 * declaration order in either surface. A rename surfaces naturally as a
 * tool-removed (BREAKING) + tool-added (SAFE) pair — the removal makes the diff
 * fail, which is correct: a caller of the old name is broken.
 */
export function diffToolSurfaces(oldSurface: ToolSurface, newSurface: ToolSurface): Change[] {
  const oldMap = indexByName(oldSurface);
  const newMap = indexByName(newSurface);
  const changes: Change[] = [];

  // Tool-level add / remove.
  for (const name of oldMap.keys()) {
    if (!newMap.has(name)) {
      changes.push({
        tool: name,
        kind: "tool-removed",
        severity: "BREAKING",
        detail: `tool '${name}' was removed`,
      });
    }
  }
  for (const name of newMap.keys()) {
    if (!oldMap.has(name)) {
      changes.push({
        tool: name,
        kind: "tool-added",
        severity: "SAFE",
        detail: `tool '${name}' was added`,
      });
    }
  }

  // Tools present in both: description, return type, and the input schema.
  for (const [name, oldTool] of oldMap) {
    const newTool = newMap.get(name);
    if (!newTool) continue;

    if (asString(oldTool.description) !== asString(newTool.description)) {
      changes.push({
        tool: name,
        kind: "tool-description-changed",
        severity: "NOTICE",
        detail: `tool description changed`,
      });
    }
    if (!deepEqual(oldTool._returnType, newTool._returnType)) {
      changes.push({
        tool: name,
        kind: "return-type-changed",
        severity: "NOTICE",
        detail: `return type changed`,
      });
    }
    diffObjectSchema(name, "", asSchema(oldTool.inputSchema), asSchema(newTool.inputSchema), changes);
  }

  return sortChanges(changes);
}

/**
 * Recursively diff two object schemas ({ type:"object", properties, required }).
 * Recursion handles nested object properties; non-object sub-schemas fall back
 * to the conservative deep-compare in diffPropertySchema.
 */
function diffObjectSchema(
  tool: string,
  basePath: string,
  oldObj: JsonSchema,
  newObj: JsonSchema,
  changes: Change[],
): void {
  const oldProps = propsOf(oldObj);
  const newProps = propsOf(newObj);
  const oldReq = requiredOf(oldObj);
  const newReq = requiredOf(newObj);

  // Removed properties — a caller can no longer rely on them being read.
  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) {
      changes.push({
        tool,
        kind: "property-removed",
        severity: "BREAKING",
        detail: `property '${joinPath(basePath, key)}' was removed`,
      });
    }
  }

  // Added properties — required is a new demand on the caller (BREAKING);
  // optional is purely additive (SAFE).
  for (const key of Object.keys(newProps)) {
    if (!(key in oldProps)) {
      changes.push(
        newReq.has(key)
          ? {
              tool,
              kind: "property-added-required",
              severity: "BREAKING",
              detail: `required property '${joinPath(basePath, key)}' was added`,
            }
          : {
              tool,
              kind: "property-added-optional",
              severity: "SAFE",
              detail: `optional property '${joinPath(basePath, key)}' was added`,
            },
      );
    }
  }

  // Properties in both: required transition + the schema itself.
  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) continue;
    const path = joinPath(basePath, key);
    const wasReq = oldReq.has(key);
    const nowReq = newReq.has(key);
    if (!wasReq && nowReq) {
      changes.push({
        tool,
        kind: "optional-to-required",
        severity: "BREAKING",
        detail: `property '${path}' became required`,
      });
    } else if (wasReq && !nowReq) {
      changes.push({
        tool,
        kind: "required-to-optional",
        severity: "SAFE",
        detail: `property '${path}' became optional`,
      });
    }
    diffPropertySchema(tool, path, asSchema(oldProps[key]), asSchema(newProps[key]), changes);
  }

  // Conservative deep-compare of every other object-level keyword we don't
  // classify individually — `additionalProperties` (index signatures, emitted by
  // the generator), and defensively `minProperties`/`patternProperties`/etc. The
  // per-property schemas and `required` are handled above, so strip them before
  // comparing; anything left that differs is a sub-schema change → BREAKING
  // (the spec's deep-equal-else-breaking). This also covers the top-level
  // inputSchema, which is diffed here directly with no diffPropertySchema wrapper.
  const oldRest = withoutKeys(oldObj, ["properties", "required"]);
  const newRest = withoutKeys(newObj, ["properties", "required"]);
  if (!deepEqual(oldRest, newRest)) {
    changes.push({
      tool,
      kind: "subschema-changed",
      severity: "BREAKING",
      detail: basePath
        ? `schema of param '${basePath}' changed`
        : `input schema of tool '${tool}' changed`,
    });
  }
}

/**
 * Diff two property sub-schemas. Order of checks encodes the policy table:
 * description (NOTICE) is split off first; then type change, then enum
 * membership, then nested objects (recursion), then a conservative
 * deep-compare for everything else (arrays, tuples, anyOf, const, …).
 */
function diffPropertySchema(
  tool: string,
  path: string,
  oldS: JsonSchema,
  newS: JsonSchema,
  changes: Change[],
): void {
  // A param description is documentation, not the structural contract → NOTICE.
  if (asString(oldS.description) !== asString(newS.description)) {
    changes.push({
      tool,
      kind: "param-description-changed",
      severity: "NOTICE",
      detail: `description of param '${path}' changed`,
    });
  }

  const oldStruct = withoutKeys(oldS, ["description"]);
  const newStruct = withoutKeys(newS, ["description"]);
  if (deepEqual(oldStruct, newStruct)) return; // only the description (if anything) moved

  const oldType = typeof oldStruct.type === "string" ? (oldStruct.type as string) : undefined;
  const newType = typeof newStruct.type === "string" ? (newStruct.type as string) : undefined;

  // Type changed (string↔number, string↔object, gaining/losing a type, …).
  if (oldType !== newType) {
    changes.push({
      tool,
      kind: "property-type-changed",
      severity: "BREAKING",
      detail: `type of param '${path}' changed from ${typeLabel(oldType)} to ${typeLabel(newType)}`,
    });
    return;
  }

  // Same type, both enums → membership diff (removed BREAKING, added SAFE).
  // Covers TS enums (no `type`) and literal unions (with `type`).
  if (Array.isArray(oldStruct.enum) && Array.isArray(newStruct.enum)) {
    diffEnum(tool, path, oldStruct.enum, newStruct.enum, changes);
    // Defensive: any non-enum structural change alongside the enum stays BREAKING.
    if (!deepEqual(withoutKeys(oldStruct, ["enum"]), withoutKeys(newStruct, ["enum"]))) {
      changes.push({
        tool,
        kind: "subschema-changed",
        severity: "BREAKING",
        detail: `schema of param '${path}' changed`,
      });
    }
    return;
  }

  // Same type, both objects → recurse into nested properties.
  if (oldType === "object" && newType === "object") {
    diffObjectSchema(tool, path, oldStruct, newStruct, changes);
    return;
  }

  // Everything else (arrays, tuples, anyOf, const, format, gaining/losing an
  // enum on a typed schema, …): conservative deep-compare. We already know the
  // structures differ, so this is BREAKING.
  changes.push({
    tool,
    kind: "subschema-changed",
    severity: "BREAKING",
    detail: `schema of param '${path}' changed`,
  });
}

function diffEnum(
  tool: string,
  path: string,
  oldEnum: unknown[],
  newEnum: unknown[],
  changes: Change[],
): void {
  for (const v of oldEnum) {
    if (!newEnum.some((n) => deepEqual(n, v))) {
      changes.push({
        tool,
        kind: "enum-value-removed",
        severity: "BREAKING",
        detail: `enum value ${literal(v)} was removed from param '${path}'`,
      });
    }
  }
  for (const v of newEnum) {
    if (!oldEnum.some((o) => deepEqual(o, v))) {
      changes.push({
        tool,
        kind: "enum-value-added",
        severity: "SAFE",
        detail: `enum value ${literal(v)} was added to param '${path}'`,
      });
    }
  }
}

/** True iff any change would break an existing caller — the check's pass/fail. */
export function hasBreaking(changes: Change[]): boolean {
  return changes.some((c) => c.severity === "BREAKING");
}

// ---------------------------------------------------------------------------
// Deterministic snapshot normalization
// ---------------------------------------------------------------------------

/**
 * Project the raw generator output down to the contract-relevant surface. No
 * canonicalization here — serializeSnapshot / diffToolSurfaces own that.
 */
export function surfaceFromTools(tools: McpToolDefinition[]): ToolSurface {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    _returnType: t._returnType,
  }));
}

/**
 * Serialize a surface to byte-stable JSON: tools sorted by name, every object
 * key sorted, `required` arrays sorted (set semantics), a fixed header, 2-space
 * indent, trailing newline. Re-running on an unchanged surface — in any source
 * order — yields identical bytes, so the committed file diffs cleanly in review.
 */
export function serializeSnapshot(surface: ToolSurface): string {
  const tools = surface
    .map((t) => canonicalize(t) as ToolSnapshot)
    .sort((a, b) => compareStrings(a.name, b.name));
  const doc = { schema: SNAPSHOT_SCHEMA_ID, version: SNAPSHOT_VERSION, tools };
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Parse a snapshot file back into a surface, validating the header and version.
 * Throws SnapshotError on anything malformed (the CLI maps that to exit 2).
 */
export function parseSnapshot(text: string): ToolSurface {
  let doc: unknown;
  try {
    doc = JSON.parse(stripBom(text));
  } catch (err) {
    throw new SnapshotError(`snapshot is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new SnapshotError("snapshot is not a JSON object");
  }
  const d = doc as Record<string, unknown>;
  if (d.schema !== SNAPSHOT_SCHEMA_ID) {
    throw new SnapshotError(
      `unrecognized snapshot (schema=${literal(d.schema)}, expected ${literal(SNAPSHOT_SCHEMA_ID)})`,
    );
  }
  if (d.version !== SNAPSHOT_VERSION) {
    throw new SnapshotError(
      `unsupported snapshot version ${literal(d.version)} (this build writes version ${SNAPSHOT_VERSION})`,
    );
  }
  if (!Array.isArray(d.tools)) {
    throw new SnapshotError("snapshot is missing a 'tools' array");
  }
  return d.tools as ToolSurface;
}

/**
 * Recursively rebuild a value with object keys inserted in sorted order, so
 * JSON.stringify emits byte-stable output. Two array kinds are sorted because
 * the classifier treats them as sets, so their order is not part of the
 * contract: `required` (a set of property-name strings) and `enum` (diffed by
 * membership in diffEnum). `enum` is sorted by JSON-stringified value so all
 * primitive member types (string/number/boolean) order deterministically.
 * Positional, value-bearing arrays — tuple `prefixItems` and `anyOf` branches —
 * keep their order.
 */
function canonicalize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalize(v));
    if (key === "required" && items.every((i) => typeof i === "string")) {
      return [...items].sort();
    }
    if (key === "enum") {
      return [...items].sort((a, b) => compareStrings(literal(a), literal(b)));
    }
    return items;
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      out[k] = canonicalize(src[k], k);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Human-readable rendering (for stderr)
// ---------------------------------------------------------------------------

/** Group changes by severity into readable stderr lines. */
export function formatChangesHuman(changes: Change[]): string {
  const bySeverity: Record<Severity, Change[]> = {
    BREAKING: changes.filter((c) => c.severity === "BREAKING"),
    SAFE: changes.filter((c) => c.severity === "SAFE"),
    NOTICE: changes.filter((c) => c.severity === "NOTICE"),
  };
  const lines: string[] = [];
  if (bySeverity.BREAKING.length > 0) {
    lines.push(`BREAKING (${bySeverity.BREAKING.length}) — these break existing callers:`);
    for (const c of bySeverity.BREAKING) lines.push(`  x [${c.tool}] ${c.detail}`);
  }
  if (bySeverity.SAFE.length > 0) {
    lines.push(`SAFE (${bySeverity.SAFE.length}):`);
    for (const c of bySeverity.SAFE) lines.push(`  + [${c.tool}] ${c.detail}`);
  }
  if (bySeverity.NOTICE.length > 0) {
    lines.push(`NOTICE (${bySeverity.NOTICE.length}):`);
    for (const c of bySeverity.NOTICE) lines.push(`  . [${c.tool}] ${c.detail}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function indexByName(surface: ToolSurface): Map<string, ToolSnapshot> {
  const map = new Map<string, ToolSnapshot>();
  for (const tool of surface) {
    map.set(tool.name, canonicalize(tool) as ToolSnapshot);
  }
  return map;
}

function propsOf(schema: JsonSchema): Record<string, unknown> {
  const p = schema.properties;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

function requiredOf(schema: JsonSchema): Set<string> {
  return new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
}

function asSchema(value: unknown): JsonSchema {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchema)
    : {};
}

function withoutKeys(schema: JsonSchema, keys: string[]): JsonSchema {
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function typeLabel(type: string | undefined): string {
  return type ?? "any";
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable change ordering for byte-stable stdout JSON. */
function sortChanges(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => {
    if (a.tool !== b.tool) return compareStrings(a.tool, b.tool);
    if (a.detail !== b.detail) return compareStrings(a.detail, b.detail);
    return compareStrings(a.kind, b.kind);
  });
}

/** Structural equality: order-insensitive for object keys, order-sensitive for arrays. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
  }
  return false;
}

/** JSON rendering that never throws (used in human-readable details). */
function literal(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
