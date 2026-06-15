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
import {
  generateTools,
  type McpToolDefinition,
  type McpResourceDefinition,
  type McpResourceTemplateDefinition,
  type McpPromptDefinition,
  type ToolError,
} from "./generate";

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

/** One message of a prompt result. `content` is a content block, passed through. */
export interface PromptMessage {
  role: "user" | "assistant";
  content: unknown;
}

/**
 * The neutral result of reading a resource through the shared path. Mirrors
 * InvokeOutcome: the function runs identically to a tool (same loader, same
 * validation, same throw→error handling), and the read serializes the return —
 * a string → text/plain, anything else → application/json (an `@mime` tag
 * overrides). serve maps these onto resources/read.
 *
 *   - ok               → the function ran; (uri, mimeType, text) is the content.
 *   - toolError        → the function threw (serve: InternalError).
 *   - unknownResource  → no static resource or template matched the URI.
 *   - invalidParams    → extracted URI values failed schema validation; fn NOT called.
 */
export type ReadResourceOutcome =
  | { kind: "ok"; uri: string; mimeType: string; text: string }
  | { kind: "toolError"; message: string }
  | { kind: "unknownResource"; message: string }
  | { kind: "invalidParams"; message: string };

/**
 * The neutral result of getting a prompt through the shared path. The function
 * runs like a tool; its return is shaped into messages — a string → a single
 * user text message, an array of `{ role, content }` → passed through.
 *
 *   - ok             → (description, messages) is the prompt result.
 *   - toolError      → the function threw (serve: InternalError).
 *   - unknownPrompt  → no prompt with that name.
 *   - invalidParams  → supplied arguments failed validation; fn NOT called.
 *   - invalidReturn  → the function returned a shape we can't turn into messages
 *                      (fail-loud; serve: InternalError).
 */
export type GetPromptOutcome =
  | { kind: "ok"; description: string; messages: PromptMessage[] }
  | { kind: "toolError"; message: string }
  | { kind: "unknownPrompt"; message: string }
  | { kind: "invalidParams"; message: string }
  | { kind: "invalidReturn"; message: string };

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
  /** Servable static resources (only those with a matching export). */
  resources: McpResourceDefinition[];
  /** Servable resource templates (only those with a matching export). */
  resourceTemplates: McpResourceTemplateDefinition[];
  /** Servable prompts (only those with a matching export). */
  prompts: McpPromptDefinition[];
  /** Generated primitives (tool/resource/prompt) with no matching export (not served). */
  skipped: SkippedExport[];
  /** Names of the tools actually callable (registry order). */
  toolNames: string[];
  /** Run a tool exactly the way serve would: validate → named→positional → await. */
  invoke(name: string, args: Record<string, unknown>): Promise<InvokeOutcome>;
  /**
   * Read a resource by URI through the SAME callable path a tool uses: match a
   * static URI or a template, validate the extracted variables, run the function,
   * serialize the return. Returns unknownResource when nothing matches.
   */
  readResource(uri: string): Promise<ReadResourceOutcome>;
  /**
   * Get a prompt by name through the SAME callable path: validate the supplied
   * arguments, run the function, shape the return into messages.
   */
  getPrompt(name: string, args: Record<string, string>): Promise<GetPromptOutcome>;
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
  const { tools, resources, resourceTemplates, prompts, errors, warnings } = generateTools(absFile, {
    tsconfig: options.tsconfig,
  });

  // 2. Load the user's module at runtime (no build step). jiti strips types and
  //    returns the named exports. dev disables the module/fs caches so a re-load
  //    after an edit re-evaluates the file instead of returning the first copy.
  const jiti = options.freshModuleCache
    ? createJiti(absFile, { moduleCache: false, fsCache: false })
    : createJiti(absFile);
  const mod = (await jiti.import(absFile)) as Record<string, unknown>;

  const skipped: SkippedExport[] = [];

  /** Resolve a generated primitive's same-named export, or record it skipped. */
  const resolveExport = (name: string, kind: string): ((...args: unknown[]) => unknown) | null => {
    const exported = mod[name];
    if (typeof exported !== "function") {
      skipped.push({
        name,
        reason: `no matching export (expected an exported function named '${name}' for this ${kind})`,
      });
      return null;
    }
    return exported as (...args: unknown[]) => unknown;
  };

  // 3. Build the tool registry: map each clean tool to its same-named export. A
  //    tool with no matching function export is recorded as skipped (not served).
  const registry = new Map<string, CallableTool>();
  const servableTools: McpToolDefinition[] = [];
  for (const tool of tools) {
    const exported = resolveExport(tool.name, "tool");
    if (!exported) continue;
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    registry.set(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      paramOrder: Object.keys(properties),
      fn: exported,
    });
    servableTools.push(tool);
  }

  // 3b. Resource registries: static URIs keyed for O(1) exact match; templates
  //     carry a compiled matcher + the tool-style inputSchema for validation.
  const staticResources = new Map<string, StaticResourceEntry>();
  const servableResources: McpResourceDefinition[] = [];
  for (const r of resources) {
    const exported = resolveExport(r.name, "resource");
    if (!exported) continue;
    staticResources.set(r.uri, { fn: exported, mimeType: r.mimeType });
    servableResources.push(r);
  }

  const templateEntries: TemplateEntry[] = [];
  const servableTemplates: McpResourceTemplateDefinition[] = [];
  for (const t of resourceTemplates) {
    const exported = resolveExport(t.name, "resource template");
    if (!exported) continue;
    const properties = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
    templateEntries.push({
      def: t,
      fn: exported,
      regex: templateToRegex(t.uriTemplate),
      // paramOrder spans ALL params (declaration order), so non-variable params
      // map to `undefined` at dispatch and the function's JS defaults fire.
      paramOrder: Object.keys(properties),
    });
    servableTemplates.push(t);
  }

  // 3c. Prompt registry: param order for dispatch + a string-typed input schema
  //     (prompt arguments cross the wire as strings) for the shared validator.
  const promptRegistry = new Map<string, PromptEntry>();
  const servablePrompts: McpPromptDefinition[] = [];
  for (const p of prompts) {
    const exported = resolveExport(p.name, "prompt");
    if (!exported) continue;
    promptRegistry.set(p.name, {
      def: p,
      fn: exported,
      paramOrder: p.arguments.map((a) => a.name),
      inputSchema: promptArgsToSchema(p.arguments),
    });
    servablePrompts.push(p);
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

    const run = await runCallable(entry.fn, entry.paramOrder, args ?? {});
    if (!run.ok) return { kind: "toolError", message: run.message };
    const text = typeof run.value === "string" ? run.value : safeStringify(run.value);
    return { kind: "ok", text };
  };

  const readResource = async (uri: string): Promise<ReadResourceOutcome> => {
    // Exact static match first; the function takes no arguments.
    const stat = staticResources.get(uri);
    if (stat) {
      const run = await runCallable(stat.fn, [], {});
      if (!run.ok) return { kind: "toolError", message: run.message };
      return serializeResource(uri, run.value, stat.mimeType);
    }
    // Otherwise, the first template whose pattern matches. Extracted variables
    // are coerced to their declared types, then validated with the SAME tool-arg
    // validator before the function runs — fail-loud on a value that doesn't fit.
    for (const t of templateEntries) {
      const match = t.regex.exec(uri);
      if (!match) continue;
      const groups = match.groups ?? {};
      const raw: Record<string, unknown> = {};
      for (const v of t.def.variables) raw[v] = decodeMaybe(groups[v] ?? "");
      const coerced = coerceVars(raw, t.def.inputSchema);
      const validationError = validateArguments(t.def.inputSchema, coerced, t.def.name);
      if (validationError) return { kind: "invalidParams", message: validationError };
      const run = await runCallable(t.fn, t.paramOrder, coerced);
      if (!run.ok) return { kind: "toolError", message: run.message };
      return serializeResource(uri, run.value, t.def.mimeType);
    }
    return { kind: "unknownResource", message: `Unknown resource: ${uri}` };
  };

  const getPrompt = async (
    name: string,
    args: Record<string, string>,
  ): Promise<GetPromptOutcome> => {
    const entry = promptRegistry.get(name);
    if (!entry) return { kind: "unknownPrompt", message: `Unknown prompt: ${name}` };

    const validationError = validateArguments(entry.inputSchema, args ?? {}, name);
    if (validationError) return { kind: "invalidParams", message: validationError };

    const run = await runCallable(entry.fn, entry.paramOrder, args ?? {});
    if (!run.ok) return { kind: "toolError", message: run.message };
    const shaped = shapePromptMessages(run.value);
    if (!shaped.ok) return { kind: "invalidReturn", message: shaped.message };
    return { kind: "ok", description: entry.def.description, messages: shaped.messages };
  };

  return {
    file: absFile,
    tools: servableTools,
    resources: servableResources,
    resourceTemplates: servableTemplates,
    prompts: servablePrompts,
    errors,
    warnings,
    skipped,
    toolNames: [...registry.keys()],
    invoke,
    readResource,
    getPrompt,
  };
}

// ---------------------------------------------------------------------------
// Registry entry shapes + the shared execution core
// ---------------------------------------------------------------------------

interface StaticResourceEntry {
  fn: (...args: unknown[]) => unknown;
  mimeType?: string;
}

interface TemplateEntry {
  def: McpResourceTemplateDefinition;
  fn: (...args: unknown[]) => unknown;
  regex: RegExp;
  paramOrder: string[];
}

interface PromptEntry {
  def: McpPromptDefinition;
  fn: (...args: unknown[]) => unknown;
  paramOrder: string[];
  inputSchema: Record<string, unknown>;
}

/**
 * The shared dispatch core: named→positional bridge + await + throw handling.
 * Tools, resources, and prompts ALL run through this so they execute identically
 * (the one place a function is actually called). Returns the RAW value so each
 * caller can serialize/inspect it as its primitive needs.
 */
async function runCallable(
  fn: (...args: unknown[]) => unknown,
  paramOrder: string[],
  args: Record<string, unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    // Named → positional: rebuild the argument list in the schema's parameter
    // order. Omitted params arrive as `undefined`, so JS defaults fire. await
    // covers both sync and async functions.
    const positional = paramOrder.map((p) => args[p]);
    const value = await fn(...positional);
    return { ok: true, value };
  } catch (err) {
    // A throwing function must never crash the host — surface it as an error.
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Resource URI templates + serialization
// ---------------------------------------------------------------------------

const TEMPLATE_VAR = /\{([A-Za-z0-9_]+)\}/g;

/** Escape a literal slice of a URI template for embedding in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a `{var}` URI template into an anchored RegExp with one named capture
 * group per variable. Each variable matches a single path-ish segment
 * (`[^/]+`), so `users://{id}` matches `users://42` (id = "42").
 */
function templateToRegex(uriTemplate: string): RegExp {
  let pattern = "";
  let last = 0;
  let m: RegExpExecArray | null;
  TEMPLATE_VAR.lastIndex = 0;
  while ((m = TEMPLATE_VAR.exec(uriTemplate)) !== null) {
    pattern += escapeRegex(uriTemplate.slice(last, m.index));
    pattern += `(?<${m[1]}>[^/]+)`;
    last = m.index + m[0].length;
  }
  pattern += escapeRegex(uriTemplate.slice(last));
  return new RegExp(`^${pattern}$`);
}

/** Best-effort percent-decode of an extracted URI value. */
function decodeMaybe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Coerce extracted (string) URI values toward their declared scalar types so the
 * shared validator and the function see the right runtime type. Anything we can't
 * cleanly coerce is left as the string, which then fails validation fail-loud.
 */
function coerceVars(
  raw: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const props = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = typeof v === "string" ? coerceScalar(v, props[k]) : v;
  }
  return out;
}

function coerceScalar(value: string, schema: Record<string, unknown> | undefined): unknown {
  const type = schema?.type;
  if (type === "number") {
    const n = Number(value);
    return value.trim() !== "" && !Number.isNaN(n) ? n : value;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return value;
}

/** Serialize a resource function's return into MCP content (text + mime type). */
function serializeResource(
  uri: string,
  value: unknown,
  mimeOverride: string | undefined,
): ReadResourceOutcome {
  const isString = typeof value === "string";
  const mimeType = mimeOverride ?? (isString ? "text/plain" : "application/json");
  const text = isString ? (value as string) : safeStringify(value);
  return { kind: "ok", uri, mimeType, text };
}

// ---------------------------------------------------------------------------
// Prompt argument schema + return shaping
// ---------------------------------------------------------------------------

/**
 * Build a tool-style input schema from a prompt's arguments. Prompt arguments
 * cross the wire as strings, so every property is `{ type: "string" }`; this
 * lets the SHARED validator enforce required-ness and string-ness uniformly.
 */
function promptArgsToSchema(args: McpPromptDefinition["arguments"]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of args) {
    properties[a.name] = a.description
      ? { type: "string", description: a.description }
      : { type: "string" };
    if (a.required) required.push(a.name);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/**
 * Shape a prompt function's return into messages, fail-loud on shapes we can't
 * handle:
 *   - a string → a single { role: "user", content: { type: "text", text } }.
 *   - an array of { role, content } objects → passed through as-is (a bare string
 *     content is wrapped into a text block for convenience).
 * Anything else (number, null, a non-message object, an array with a malformed
 * item) is rejected so the failure is loud rather than an opaque downstream one.
 */
function shapePromptMessages(
  value: unknown,
): { ok: true; messages: PromptMessage[] } | { ok: false; message: string } {
  if (typeof value === "string") {
    return { ok: true, messages: [{ role: "user", content: { type: "text", text: value } }] };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { ok: false, message: "prompt returned an empty message array" };
    }
    const messages: PromptMessage[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, message: `prompt message [${i}] is not an object` };
      }
      const role = (item as Record<string, unknown>).role;
      if (role !== "user" && role !== "assistant") {
        return { ok: false, message: `prompt message [${i}] has an invalid role (expected "user" or "assistant")` };
      }
      let content = (item as Record<string, unknown>).content;
      if (typeof content === "string") content = { type: "text", text: content };
      if (!content || typeof content !== "object") {
        return { ok: false, message: `prompt message [${i}] has invalid content` };
      }
      messages.push({ role, content });
    }
    return { ok: true, messages };
  }
  return {
    ok: false,
    message: `a prompt function must return a string or an array of { role, content } messages, got ${describe(value)}`,
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
