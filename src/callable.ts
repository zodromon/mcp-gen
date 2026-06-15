/**
 * The shared "load callable tools + invoke(name, args)" seam.
 *
 * This is the ONE execution path mcp-gen uses to turn a TypeScript file into a
 * set of runnable tools, so the `serve` runtime and the `dev` playground can
 * never diverge in how a tool actually runs. Both call `loadCallableTools` and
 * dispatch through the returned `invoke`; the only thing that differs between
 * them is the front-end (MCP-over-HTTP vs. a local web UI).
 *
 * What this owns (extracted verbatim from the original serve.ts so behavior is
 * unchanged):
 *   - Schema generation via generateTools (the fail-loud contract: excluded
 *     functions live in `errors`, never in the callable registry).
 *   - Module loading via jiti (no build step; the user's .ts is imported at
 *     runtime). dev passes `freshModuleCache` so a re-load picks up edited code.
 *   - The registry: each clean tool mapped to its same-named export, with the
 *     schema's parameter order captured for the named→positional bridge.
 *   - Argument validation against the tool's own JSON Schema BEFORE dispatch.
 *   - Named→positional dispatch + async/await + throw→isError handling.
 *
 * What this deliberately does NOT own: front-end policy. It never logs, never
 * throws "nothing servable", and never decides exit codes. It reports facts
 * (`errors`, `warnings`, `skipped`, `tools`) and a neutral `InvokeOutcome`;
 * each caller maps those to its own surface (serve → JSON-RPC McpError/result;
 * dev → an HTTP JSON body).
 */
import * as path from "node:path";
import { createJiti } from "jiti";
import { generateTools, type McpToolDefinition, type ToolError } from "./generate";

/** One servable tool: schema for display, fn + paramOrder for dispatch. */
export interface CallableTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Parameter names in schema order — the bridge from named to positional. */
  paramOrder: string[];
  fn: (...args: unknown[]) => unknown;
}

/** A generated tool that has no matching runtime export (skipped, not served). */
export interface SkippedExport {
  name: string;
  reason: string;
}

/**
 * The neutral result of invoking a tool through the shared path. Each front-end
 * maps these four kinds to its own wire format — this is the seam that keeps the
 * dev playground and the served server executing tools identically:
 *
 *   - ok            → the tool ran and returned (text is the stringified value).
 *   - toolError     → the tool ran and threw (a business error → isError).
 *   - unknownTool   → no such tool in the registry (serve: MethodNotFound -32601).
 *   - invalidParams → arguments failed schema validation; fn was NOT called
 *                     (serve: InvalidParams -32602).
 */
export type InvokeOutcome =
  | { kind: "ok"; text: string }
  | { kind: "toolError"; message: string }
  | { kind: "unknownTool"; message: string }
  | { kind: "invalidParams"; message: string };

/**
 * Thrown when there is nothing servable. The seam itself never throws this
 * (emptiness is visible via an empty `tools`); it lives here as the shared
 * vocabulary both front-ends use as policy — serve refuses to start an empty
 * server, dev refuses an empty startup. The CLI maps it to exit code 2.
 */
export class NoServableToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoServableToolsError";
  }
}

export interface LoadOptions {
  /** Explicit tsconfig.json path forwarded to generateTools (else discovered). */
  tsconfig?: string;
  /**
   * Load the module with jiti's caches disabled so a subsequent load re-evaluates
   * the file from disk. dev sets this so a save is reflected on the next call;
   * serve loads once and leaves it false (its single load is unaffected).
   */
  freshModuleCache?: boolean;
}

export interface CallableBundle {
  /** Absolute path of the entry file that was loaded. */
  file: string;
  /** Servable tools' generated schemas (only those with a matching export). */
  tools: McpToolDefinition[];
  /** Fail-loud function-level failures from generateTools (excluded functions). */
  errors: ToolError[];
  /** Soft notes from generateTools (constraint widening, `{}` fallback, …). */
  warnings: string[];
  /** Generated tools that had no matching runtime export (not served). */
  skipped: SkippedExport[];
  /** Names of the tools actually callable (registry order). */
  toolNames: string[];
  /** Run a tool exactly the way serve would: validate → named→positional → await. */
  invoke(name: string, args: Record<string, unknown>): Promise<InvokeOutcome>;
}

/**
 * Generate schemas, load the user's module, and build the callable registry —
 * the single path both `serve` and `dev` use. May throw on a file-level failure
 * (generateTools on a not-found/unparseable file, or a module that throws at
 * import time); callers decide what that means (serve/dev startup → exit 2; a
 * dev reload → surface it and keep the server up). It never throws for "nothing
 * servable" — that is front-end policy and is visible via an empty `tools`.
 */
export async function loadCallableTools(
  file: string,
  options: LoadOptions = {},
): Promise<CallableBundle> {
  const absFile = path.resolve(process.cwd(), file);

  // 1. Generate schemas. May throw on a file-level failure. The tsconfig
  //    override (or discovery, when unset) governs how imported types resolve.
  const { tools, errors, warnings } = generateTools(absFile, { tsconfig: options.tsconfig });

  // 2. Load the user's module at runtime (no build step). jiti strips types and
  //    returns the named exports. dev disables the module/fs caches so a re-load
  //    after an edit re-evaluates the file instead of returning the first copy.
  const jiti = options.freshModuleCache
    ? createJiti(absFile, { moduleCache: false, fsCache: false })
    : createJiti(absFile);
  const mod = (await jiti.import(absFile)) as Record<string, unknown>;

  // 3. Build the registry: map each clean tool to its same-named export. A tool
  //    with no matching function export is recorded as skipped (not served).
  const registry = new Map<string, CallableTool>();
  const servableTools: McpToolDefinition[] = [];
  const skipped: SkippedExport[] = [];
  for (const tool of tools) {
    const exported = mod[tool.name];
    if (typeof exported !== "function") {
      skipped.push({
        name: tool.name,
        reason: `no matching export (expected an exported function named '${tool.name}')`,
      });
      continue;
    }
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    registry.set(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      paramOrder: Object.keys(properties),
      fn: exported as (...args: unknown[]) => unknown,
    });
    servableTools.push(tool);
  }

  const invoke = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<InvokeOutcome> => {
    const entry = registry.get(name);
    // A call naming a tool we don't serve is a malformed call shape — surfaced as
    // unknownTool (serve → MethodNotFound), not a tool failure.
    if (!entry) return { kind: "unknownTool", message: `Unknown tool: ${name}` };

    // Validate BEFORE dispatch. A type mismatch, a missing required property, or
    // a failed enum/const is a bad call shape — the function is NEVER invoked.
    const validationError = validateArguments(entry.inputSchema, args ?? {}, name);
    if (validationError) return { kind: "invalidParams", message: validationError };

    try {
      // Named → positional: rebuild the argument list in the schema's parameter
      // order. Omitted optional params arrive as `undefined`, so JS defaults
      // fire. await covers both sync and async functions.
      const positional = entry.paramOrder.map((p) => args[p]);
      const result = await entry.fn(...positional);
      const text = typeof result === "string" ? result : safeStringify(result);
      return { kind: "ok", text };
    } catch (err) {
      // A throwing tool must never crash the host — surface it as a tool error.
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "toolError", message };
    }
  };

  return {
    file: absFile,
    tools: servableTools,
    errors,
    warnings,
    skipped,
    toolNames: [...registry.keys()],
    invoke,
  };
}

/** JSON-stringify a non-string return, never yielding a non-string (which the
 *  CallToolResult schema would reject). */
export function safeStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value);
  return typeof json === "string" ? json : String(value);
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------
//
// A dependency-free validator scoped to EXACTLY the JSON Schema shapes
// generateTools emits — nothing more. The shapes (see src/generate.ts):
//
//   { type: "object", properties, required?, additionalProperties? }  (params + nested)
//   { type: "string" | "number" | "boolean" | "null" }               (primitives)
//   { type: "string" | "number", const }                             (literal)
//   { type: "boolean", const }                                       (boolean literal)
//   { enum: [...] }                                                  (TS enum — no `type`)
//   { type: "string" | "number", enum: [...] }                      (literal union)
//   { type: "array", items }                                        (array)
//   { type: "array", prefixItems: [...] }                           (tuple)
//   { anyOf: [...] }                                                 (non-literal union)
//   { type: "string", format: "date-time" }                         (Date)
//   {}                                                              (any/unknown — permissive)
//
// Keeping it scoped to our own output makes it small, auditable, and free of a
// runtime dependency, while still rejecting the cases that matter:
// wrong type, missing required property, failed enum/const. It is deliberately
// LENIENT on undeclared properties (the named→positional bridge only reads the
// declared params), matching JSON Schema's default additionalProperties.
// `description` and `format` are advisory and ignored.
//
// Returns a human-readable error string (naming the offending parameter, with
// expected-vs-got) when the call shape is invalid, or null when it is valid.

export function validateArguments(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
  toolName: string,
): string | null {
  const error = validateValue(args, inputSchema, "");
  return error ? `Invalid arguments for tool "${toolName}": ${error}` : null;
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | null {
  const at = path ? `property "${path}"` : "arguments";

  // const — value must be exactly the literal.
  if ("const" in schema) {
    return deepEqual(value, schema.const)
      ? null
      : `${at} expected const ${literal(schema.const)}, got ${describe(value)}`;
  }

  // enum — value must be one of the members (covers TS enums, which carry no
  // `type`, and literal unions, which do).
  if (Array.isArray(schema.enum)) {
    return schema.enum.some((m) => deepEqual(value, m))
      ? null
      : `${at} expected one of ${literal(schema.enum)}, got ${describe(value)}`;
  }

  // anyOf — value must satisfy at least one branch.
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as Record<string, unknown>[];
    if (branches.some((sub) => validateValue(value, sub, path) === null)) return null;
    return `${at} did not match any of the allowed types, got ${describe(value)}`;
  }

  const type = schema.type;
  // No type/const/enum/anyOf: the permissive `{}` from any/unknown — accept any
  // value. Never falsely reject an intentionally-unconstrained param.
  if (type === undefined) return null;

  switch (type) {
    case "string":
      return typeof value === "string" ? null : typeMismatch(at, "string", value);
    case "number":
      // JSON cannot carry NaN; treat it as a non-number to be safe.
      return typeof value === "number" && !Number.isNaN(value)
        ? null
        : typeMismatch(at, "number", value);
    case "boolean":
      return typeof value === "boolean" ? null : typeMismatch(at, "boolean", value);
    case "null":
      return value === null ? null : typeMismatch(at, "null", value);
    case "array":
      return validateArray(value, schema, path, at);
    case "object":
      return validateObjectValue(value, schema, path, at);
    default:
      // A `type` keyword we don't emit — accept rather than falsely reject.
      return null;
  }
}

function validateArray(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  at: string,
): string | null {
  if (!Array.isArray(value)) return typeMismatch(at, "array", value);

  // Tuple: each present position is validated against its prefix schema. We do
  // not enforce length — generateTools emits no `minItems`/`items:false`, so the
  // schema itself does not constrain it; validating what the schema constrains
  // keeps us faithful to our own output.
  if (Array.isArray(schema.prefixItems)) {
    const prefixes = schema.prefixItems as Record<string, unknown>[];
    for (let i = 0; i < prefixes.length && i < value.length; i++) {
      const error = validateValue(value[i], prefixes[i], indexPath(path, i));
      if (error) return error;
    }
    return null;
  }

  // Homogeneous array: every element matches `items`.
  if (schema.items && typeof schema.items === "object") {
    const items = schema.items as Record<string, unknown>;
    for (let i = 0; i < value.length; i++) {
      const error = validateValue(value[i], items, indexPath(path, i));
      if (error) return error;
    }
  }
  return null;
}

function validateObjectValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  at: string,
): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return typeMismatch(at, "object", value);
  }
  const obj = value as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  // Required properties must be present. (Over JSON-RPC a value is either absent
  // or a JSON value; we treat an explicit `undefined` as absent defensively.)
  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined) {
      return `missing required property "${childPath(path, key)}"`;
    }
  }

  // Declared properties that are present must match their schema.
  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in obj && obj[key] !== undefined) {
      const error = validateValue(obj[key], propSchema, childPath(path, key));
      if (error) return error;
    }
  }

  // Index signature → additionalProperties governs the undeclared keys.
  const addl = schema.additionalProperties;
  if (addl && typeof addl === "object") {
    for (const [key, v] of Object.entries(obj)) {
      if (key in properties || v === undefined) continue;
      const error = validateValue(v, addl as Record<string, unknown>, childPath(path, key));
      if (error) return error;
    }
  }
  return null;
}

function typeMismatch(at: string, expected: string, value: unknown): string {
  return `${at} expected ${expected}, got ${describe(value)}`;
}

/** A short, safe rendering of a runtime value's type (and primitive value). */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object" || t === "function") return t;
  return `${t} (${literal(value)})`;
}

/** JSON rendering that never throws (falls back to String for cyclic input). */
function literal(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

/** Structural equality for const/enum members (primitives in practice). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    return literal(a) === literal(b);
  }
  return false;
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function indexPath(path: string, index: number): string {
  return path ? `${path}[${index}]` : `[${index}]`;
}
