/**
 * Core library: generate MCP tool definitions from exported functions in a .ts file.
 *
 * Conversion reads the type checker's resolved types (param.getType()), not the
 * syntax tree. WI-2 adds the fail-loud contract: every input-position type
 * resolves to one of three outcomes —
 *   - HARD ERROR  → the function is excluded from `tools` and recorded in `errors`
 *                   (unbound generic, non-JSON-serializable type, unresolved-import
 *                   `any`, recursion past the depth cap, or no matching rule).
 *   - WIDEN+warn  → a constrained generic `T extends X` emits X's schema + a warning.
 *   - {}+warn     → an author-written `any`/`unknown` emits `{}` + a warning.
 * Return-position failures never block a function; they degrade to a `$comment`
 * note in `_returnType` (MCP `inputSchema` doesn't need the return type).
 *
 * No emitted tool's inputSchema ever carries a `$comment: UNRESOLVED` placeholder —
 * that silent garbage is exactly what the contract eliminates.
 */
import * as path from "node:path";
import {
  ArrowFunction,
  Diagnostic,
  FunctionDeclaration,
  FunctionExpression,
  JSDoc,
  Node,
  Project,
  SourceFile,
  Type,
  ts,
} from "ts-morph";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // Not part of the MCP tool schema proper, but the task asks to extract return
  // types — recorded here for inspection. May carry a `$comment` note: return
  // failures never block a tool.
  _returnType: { text: string; awaitedSchema: Record<string, unknown> };
}

export interface GenerateOptions {
  debug?: boolean;
  /**
   * Explicit tsconfig.json path. When set, discovery is skipped and this
   * tsconfig's compiler options + module resolution (paths, baseUrl, types,
   * node_modules) govern the Project. Resolved relative to the cwd.
   */
  tsconfig?: string;
}

/** One input-position type that could not be converted to a JSON Schema. */
export interface ParamFailure {
  /** e.g. `wrap(value)` or `insert(node).children[].children[]`. */
  parameterPath: string;
  /** The author-facing type text (the annotation where one exists). */
  typeText: string;
  reason: string;
  /** Actionable fix hint for stderr. */
  hint: string;
}

/** A function-level failure: the function cannot become a tool at all. */
export interface ToolError {
  /** Function name, or null when no stable name exists (anonymous default export). */
  function: string | null;
  message: string;
  /** Per-parameter detail. Absent for export-style errors (anonymous default). */
  failures?: ParamFailure[];
}

export interface GenerateResult {
  /** Only cleanly-converted (or widened) functions. */
  tools: McpToolDefinition[];
  /** Function-level hard failures; these functions are absent from `tools`. */
  errors: ToolError[];
  /** Soft notes (constraint widening, `{}` fallback, skipped exports). */
  warnings: string[];
  rawTypeDebug: Record<string, unknown>[];
  compilerDiagnostics: string[];
  /**
   * Resolution-context metadata (observability + the deterministic anti-balloon
   * hook). `tsconfigPath` is the discovered/overridden tsconfig, or null when
   * the entry is a standalone file under no project (inline defaults used).
   * `sourceFileCount` is the number of source files in the Project after
   * generation — entry + its real import closure only, NOT every file the
   * tsconfig's `include` matches (proves `skipAddingFilesFromTsConfig`).
   */
  project: { tsconfigPath: string | null; sourceFileCount: number };
}

type Position = "input" | "return";

interface ModuleDiag {
  module: string;
  text: string;
}

interface Ctx {
  /** Whether the type currently being converted sits in an input or return position. */
  position: Position;
  /** Hard failures gathered for the CURRENT function's input parameters. */
  failures: ParamFailure[];
  /** Warnings gathered for the CURRENT function (committed only if it emits). */
  pendingWarnings: string[];
  /** Parsed unresolved-module diagnostics for the source file (computed once). */
  moduleDiagnostics: ModuleDiag[];
}

// ---------------------------------------------------------------------------
// Fix hints
// ---------------------------------------------------------------------------

const UNBOUND_GENERIC_HINT =
  "add a constraint or use a concrete type — MCP tools are wire endpoints.";
const IMPORT_HINT =
  "run the generator inside the project's tsconfig (with node_modules installed) so the import resolves, or use a concrete local type.";
const SERIALIZE_HINT =
  "MCP tool inputs cross a JSON wire — use a JSON-native type (string, number, boolean, array, or plain object).";
const RECURSION_HINT =
  "recursive types can't be inlined as JSON Schema yet ($ref/$defs unsupported); flatten or bound the type's depth.";
const FALLBACK_HINT = "this type has no JSON Schema representation; use a JSON-serializable type.";

// ---------------------------------------------------------------------------
// Raw type inspection (for the --debug report)
// ---------------------------------------------------------------------------

function flagNames(flags: number, flagEnum: Record<string, string | number>): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(flagEnum)) {
    if (typeof value === "number" && value !== 0 && (flags & value) === value) {
      names.push(name);
    }
  }
  return names;
}

export function describeTypeRaw(type: Type, location: Node): Record<string, unknown> {
  const compilerType = type.compilerType;
  const info: Record<string, unknown> = {
    text: type.getText(location),
    typeFlags: flagNames(compilerType.flags, ts.TypeFlags as unknown as Record<string, number>),
  };
  const objectFlags = (compilerType as ts.ObjectType).objectFlags;
  if (type.isObject() && objectFlags !== undefined) {
    info.objectFlags = flagNames(objectFlags, ts.ObjectFlags as unknown as Record<string, number>);
  }
  const symbol = type.getSymbol();
  if (symbol) {
    info.symbol = {
      name: symbol.getName(),
      declaredIn: symbol.getDeclarations().map((d) => {
        const sf = d.getSourceFile();
        return `${sf.getBaseName()}:${d.getStartLineNumber()} (${d.getKindName()})`;
      }),
    };
  }
  const apparent = type.getApparentType();
  if (apparent.getText(location) !== type.getText(location)) {
    info.apparentType = apparent.getText(location);
  }
  if (type.isUnion()) {
    info.unionMembers = type.getUnionTypes().map((t) => t.getText(location));
  }
  const typeArgs = type.getTypeArguments();
  if (typeArgs.length > 0) {
    info.typeArguments = typeArgs.map((t) => t.getText(location));
  }
  return info;
}

// ---------------------------------------------------------------------------
// Failure / warning collection
// ---------------------------------------------------------------------------

function recordFailure(
  ctx: Ctx,
  path: string,
  typeText: string,
  reason: string,
  hint: string,
): void {
  ctx.failures.push({ parameterPath: path, typeText, reason, hint });
}

function pushWarning(ctx: Ctx, message: string): void {
  ctx.pendingWarnings.push(message);
}

/**
 * A non-JSON-serializable type. In an input position this is a hard failure;
 * in a return position it degrades to a note (return types don't block a tool).
 */
function nonSerializable(
  ctx: Ctx,
  type: Type,
  location: Node,
  path: string,
  what: string,
): Record<string, unknown> {
  if (ctx.position === "return") {
    return { $comment: `UNRESOLVED: ${what} '${type.getText(location)}' is not JSON-serializable` };
  }
  recordFailure(ctx, path, type.getText(location), `${what} is not JSON-serializable`, SERIALIZE_HINT);
  return {};
}

function parseModuleDiagnostics(diags: Diagnostic[]): ModuleDiag[] {
  const out: ModuleDiag[] = [];
  for (const d of diags) {
    const m = d.getMessageText();
    const text = typeof m === "string" ? m : m.getMessageText();
    const match = text.match(
      /Cannot find module '([^']+)'|Could not find a declaration file for module '([^']+)'/,
    );
    if (match) out.push({ module: match[1] ?? match[2], text });
  }
  return out;
}

/**
 * Distinguish a module-resolution `any` (a named type that silently collapsed to
 * `any` because its import couldn't resolve) from an author-written `any`.
 *
 * The signal is the syntactic annotation, NOT `type.getText()` (which lies: the
 * unresolved `WidgetConfig` still renders as "WidgetConfig" — REPORT case 5b).
 * A type that resolves to `any` whose annotation is a *type reference* tied to an
 * import with a "Cannot find module" diagnostic is a resolution failure; an
 * annotation that is the literal `any`/`unknown` keyword is author-written.
 */
function matchModuleDiagnosticForAnnotation(
  ctx: Ctx,
  annotation: Node | undefined,
  sourceFile: SourceFile,
): ModuleDiag | undefined {
  if (ctx.moduleDiagnostics.length === 0) return undefined;
  if (!annotation || !Node.isTypeReference(annotation)) return undefined;

  const rootName = annotation.getTypeName().getText().split(".")[0];
  for (const imp of sourceFile.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    const diag = ctx.moduleDiagnostics.find((d) => d.module === spec);
    if (!diag) continue;
    const named = imp
      .getNamedImports()
      .some((n) => (n.getAliasNode()?.getText() ?? n.getName()) === rootName);
    const def = imp.getDefaultImport()?.getText() === rootName;
    const ns = imp.getNamespaceImport()?.getText() === rootName;
    if (named || def || ns) return diag;
  }
  // No import binds this type reference to a module with a resolution failure.
  // It is NOT a module-resolution `any` — a typo'd or otherwise-unresolvable
  // local name resolves to `any` too, but it has no "Cannot find module"
  // diagnostic to match, so it falls through to the permissive `{}` outcome
  // rather than being misattributed to an unrelated missing import.
  return undefined;
}

// ---------------------------------------------------------------------------
// Type -> JSON Schema conversion
// ---------------------------------------------------------------------------

const MAX_DEPTH = 8;

function typeToJsonSchema(
  ctx: Ctx,
  type: Type,
  location: Node,
  path: string,
  depth = 0,
): Record<string, unknown> {
  if (depth > MAX_DEPTH) {
    if (ctx.position === "return") {
      return { $comment: `UNRESOLVED: max depth at ${type.getText(location)}` };
    }
    recordFailure(
      ctx,
      path,
      type.getText(location),
      `exceeds the maximum nesting depth (${MAX_DEPTH}) — likely a recursive or self-referential type`,
      RECURSION_HINT,
    );
    return {};
  }

  // --- primitives ---
  if (type.isString()) return { type: "string" };
  if (type.isNumber()) return { type: "number" };
  if (type.isBoolean()) return { type: "boolean" };
  if (type.isNull()) return { type: "null" };
  if (type.isUndefined()) {
    if (ctx.position === "return") {
      return { $comment: "UNRESOLVED: undefined has no JSON Schema equivalent" };
    }
    recordFailure(
      ctx,
      path,
      type.getText(location),
      "the 'undefined' type has no JSON Schema representation",
      FALLBACK_HINT,
    );
    return {};
  }

  // --- non-JSON-serializable scalars: symbol / bigint ---
  const flags = type.compilerType.flags;
  if ((flags & ts.TypeFlags.ESSymbol) !== 0 || (flags & ts.TypeFlags.UniqueESSymbol) !== 0) {
    return nonSerializable(ctx, type, location, path, "symbol");
  }
  if ((flags & ts.TypeFlags.BigInt) !== 0 || (flags & ts.TypeFlags.BigIntLiteral) !== 0) {
    return nonSerializable(ctx, type, location, path, "bigint");
  }

  // --- literals ---
  if (type.isStringLiteral()) return { type: "string", const: type.getLiteralValue() };
  if (type.isNumberLiteral()) return { type: "number", const: type.getLiteralValue() };
  if (type.isBooleanLiteral()) return { type: "boolean", const: type.getText(location) === "true" };

  // --- enums (TS enum) ---
  if (type.isEnum() || type.isEnumLiteral()) {
    const members = type.isEnum()
      ? type.getUnionTypes().map((t) => t.getLiteralValue())
      : [type.getLiteralValue()];
    return { enum: members };
  }

  // --- any / unknown ---
  if (type.isAny() || type.isUnknown()) {
    if (ctx.position === "return") {
      return { $comment: `UNRESOLVED: type is '${type.getText(location)}'` };
    }
    // Module-resolution `any`: a named reference that collapsed to `any` because
    // its import couldn't resolve. Hard error (with the diagnostic text).
    if (type.isAny()) {
      const annotation =
        depth === 0 && Node.isParameterDeclaration(location) ? location.getTypeNode() : undefined;
      if (annotation && Node.isTypeReference(annotation)) {
        const diag = matchModuleDiagnosticForAnnotation(ctx, annotation, location.getSourceFile());
        if (diag) {
          recordFailure(
            ctx,
            path,
            annotation.getText(),
            `type resolved to 'any' because module '${diag.module}' could not be resolved (${diag.text})`,
            IMPORT_HINT,
          );
          return {};
        }
      }
    }
    // Author-written `any`/`unknown` (or an `any` with no resolution evidence):
    // permissive `{}` + warning. Emitted.
    pushWarning(
      ctx,
      `${path}: '${type.getText(location)}' accepts any value — emitting an unconstrained schema ({}).`,
    );
    return {};
  }

  // --- generics: bare type parameter like T ---
  if (type.isTypeParameter()) {
    const constraint = type.getConstraint();
    if (ctx.position === "return") {
      return {
        $comment: `UNRESOLVED: generic type parameter '${type.getText(location)}'${
          constraint ? ` extends ${constraint.getText(location)}` : ""
        }`,
      };
    }
    // Constrained `T extends X`: widen to X's schema + warning. Emitted.
    if (constraint) {
      pushWarning(
        ctx,
        `${path}: generic '${type.getText(location)}' widened to its constraint '${constraint.getText(
          location,
        )}'.`,
      );
      return typeToJsonSchema(ctx, constraint, location, path, depth + 1);
    }
    // Unbound `T`: no concrete type exists. Hard error.
    recordFailure(
      ctx,
      path,
      type.getText(location),
      "unbound generic type parameter — no concrete type exists to convert",
      UNBOUND_GENERIC_HINT,
    );
    return {};
  }

  // --- unions ---
  if (type.isUnion()) {
    const members = type.getUnionTypes().filter((t) => !t.isUndefined());
    if (members.length === 0) {
      if (ctx.position === "return") {
        return { $comment: "UNRESOLVED: union of only undefined" };
      }
      recordFailure(
        ctx,
        path,
        type.getText(location),
        "the 'undefined' type has no JSON Schema representation",
        FALLBACK_HINT,
      );
      return {};
    }
    // All string literals -> enum
    if (members.every((t) => t.isStringLiteral())) {
      return { type: "string", enum: members.map((t) => t.getLiteralValue()) };
    }
    // All number literals -> enum
    if (members.every((t) => t.isNumberLiteral())) {
      return { type: "number", enum: members.map((t) => t.getLiteralValue()) };
    }
    if (members.length === 1) {
      return typeToJsonSchema(ctx, members[0], location, path, depth + 1);
    }
    return {
      anyOf: members.map((t, i) => typeToJsonSchema(ctx, t, location, `${path}|union[${i}]`, depth + 1)),
    };
  }

  // --- intersections: merge object members via apparent properties ---
  if (type.isIntersection()) {
    return objectTypeToSchema(ctx, type, location, path, depth);
  }

  // --- arrays / tuples ---
  if (type.isArray()) {
    return {
      type: "array",
      items: typeToJsonSchema(ctx, type.getArrayElementTypeOrThrow(), location, `${path}[]`, depth + 1),
    };
  }
  if (type.isTuple()) {
    return {
      type: "array",
      prefixItems: type
        .getTupleElements()
        .map((t, i) => typeToJsonSchema(ctx, t, location, `${path}[${i}]`, depth + 1)),
    };
  }

  // --- objects ---
  if (type.isObject()) {
    const symbolName = type.getSymbol()?.getName();

    // Date is the one non-plain object we map onto a JSON type.
    if (symbolName === "Date") return { type: "string", format: "date-time" };
    // Other built-in object types are not JSON-serializable.
    if (symbolName === "Promise") return nonSerializable(ctx, type, location, path, "Promise");
    if (symbolName && ["Map", "WeakMap", "Set", "WeakSet"].includes(symbolName)) {
      return nonSerializable(ctx, type, location, path, symbolName);
    }
    if (type.getCallSignatures().length > 0) {
      return nonSerializable(ctx, type, location, path, "function type");
    }

    return objectTypeToSchema(ctx, type, location, path, depth);
  }

  // --- no rule matched: fail loud in input position ---
  if (ctx.position === "return") {
    return { $comment: `UNRESOLVED: ${type.getText(location)}` };
  }
  recordFailure(
    ctx,
    path,
    type.getText(location),
    "no JSON Schema conversion rule matched this type",
    FALLBACK_HINT,
  );
  return {};
}

function objectTypeToSchema(
  ctx: Ctx,
  type: Type,
  location: Node,
  path: string,
  depth: number,
): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: "object" };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const prop of type.getProperties()) {
    const name = prop.getName();
    const propType = prop.getTypeAtLocation(location);
    properties[name] = typeToJsonSchema(ctx, propType, location, `${path}.${name}`, depth + 1);
    if (!prop.hasFlags(ts.SymbolFlags.Optional)) {
      required.push(name);
    }
  }

  // Index signatures -> additionalProperties
  const stringIndexType = type.getStringIndexType();
  if (stringIndexType) {
    schema.additionalProperties = typeToJsonSchema(ctx, stringIndexType, location, `${path}[string]`, depth + 1);
  }

  if (Object.keys(properties).length > 0) schema.properties = properties;
  if (required.length > 0) schema.required = required;

  // An object that resolves to zero properties is permissive, not a failure —
  // a bare `{ type: "object" }` is a valid schema (no UNRESOLVED placeholder).
  return schema;
}

// ---------------------------------------------------------------------------
// Collecting exported functions (all supported export styles)
// ---------------------------------------------------------------------------

/** Any node JSDoc can attach to for our purposes (declaration or variable statement). */
interface DocSource {
  getJsDocs(): JSDoc[];
}

/**
 * Uniform view over an exported function regardless of export style.
 * `fn` carries parameters/return type; `docSource` is the node JSDoc attaches
 * to — for `export const d = () => ...` that is the VariableStatement, not the
 * arrow function.
 */
interface ToolFunction {
  name: string;
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression;
  docSource: DocSource;
}

const STABLE_NAME_HINT = "MCP tools need stable names; export a named function.";

function collectToolFunctions(
  sourceFile: SourceFile,
  errors: ToolError[],
): { toolFunctions: ToolFunction[]; handled: Set<Node> } {
  const toolFunctions: ToolFunction[] = [];
  // Nodes we either converted or already reported an error for — used by the
  // skipped-export cross-check so nothing gets double-reported.
  const handled = new Set<Node>();

  for (const func of sourceFile.getFunctions()) {
    if (!func.isExported()) continue;
    handled.add(func);
    const name = func.getName();
    if (!name) {
      errors.push({ function: null, message: `Anonymous default-exported function: ${STABLE_NAME_HINT}` });
      continue;
    }
    toolFunctions.push({ name, fn: func, docSource: func });
  }

  for (const stmt of sourceFile.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        handled.add(init);
        handled.add(decl);
        toolFunctions.push({ name: decl.getName(), fn: init, docSource: stmt });
      }
    }
  }

  for (const exportAssignment of sourceFile.getExportAssignments()) {
    if (exportAssignment.isExportEquals()) continue;
    const expr = exportAssignment.getExpression();
    if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
      handled.add(expr);
      errors.push({ function: null, message: `Anonymous default export: ${STABLE_NAME_HINT}` });
    }
  }

  return { toolFunctions, handled };
}

/** Out-of-scope export styles (aliases, re-exports) get a warning, not silence. */
function warnOnSkippedFunctionExports(
  sourceFile: SourceFile,
  handled: Set<Node>,
  warnings: string[],
): void {
  for (const [exportName, decls] of sourceFile.getExportedDeclarations()) {
    for (const decl of decls) {
      const fnNode = unwrapFunctionLike(decl);
      if (!fnNode) continue;
      if (handled.has(fnNode) || handled.has(decl)) continue;
      const origin =
        decl.getSourceFile() === sourceFile ? "aliased export" : "re-export from another file";
      warnings.push(
        `Export '${exportName}' points at a function that was not converted (${origin} — out of scope).`,
      );
    }
  }
}

function unwrapFunctionLike(decl: Node): Node | undefined {
  if (Node.isFunctionDeclaration(decl)) return decl;
  if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) return decl;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// JSDoc extraction
// ---------------------------------------------------------------------------

function getJsDocInfo(docSource: DocSource): {
  description?: string;
  paramDocs: Map<string, string>;
} {
  const paramDocs = new Map<string, string>();
  let description: string | undefined;

  for (const doc of docSource.getJsDocs()) {
    const desc = doc.getDescription().trim();
    if (desc) description = desc;
    for (const tag of doc.getTags()) {
      if (Node.isJSDocParameterTag(tag)) {
        const name = tag.getName();
        const comment = (tag.getCommentText() ?? "").replace(/^[-\s]+/, "").trim();
        if (name && comment) paramDocs.set(name, comment);
      }
    }
  }
  return { description, paramDocs };
}

// ---------------------------------------------------------------------------
// Project resolution context
// ---------------------------------------------------------------------------

/**
 * Find the tsconfig.json that governs the entry file's module resolution.
 *
 * An explicit override wins (validated to exist — a bad path is a file-level
 * failure, surfaced as a throw the CLI maps to exit 2). Otherwise walk up from
 * the entry file's directory to the filesystem root for the nearest
 * tsconfig.json (`ts.findConfigFile`, which checks `<dir>/tsconfig.json` then
 * each ancestor). Returns an absolute native path, or null when the entry sits
 * under no project — the caller then falls back to inline default compiler
 * options so a standalone file still works.
 */
function discoverTsConfig(entryFile: string, override?: string): string | null {
  if (override !== undefined) {
    const abs = path.resolve(override);
    if (!ts.sys.fileExists(abs)) {
      throw new Error(`--tsconfig file not found: ${override}`);
    }
    return abs;
  }
  const startDir = path.dirname(path.resolve(entryFile));
  const found = ts.findConfigFile(startDir, (f) => ts.sys.fileExists(f));
  return found ? path.resolve(found) : null;
}

// ---------------------------------------------------------------------------
// Main entry: build MCP tool definitions for one file
// ---------------------------------------------------------------------------

export function generateTools(filePath: string, options: GenerateOptions = {}): GenerateResult {
  const debug = options.debug ?? false;

  // Resolve the project context. A discovered (or explicitly overridden)
  // tsconfig contributes its compiler options + module resolution so imported
  // and external types resolve against the user's real project (REPORT case 5b
  // false positives disappear). `skipAddingFilesFromTsConfig` keeps the Project
  // from slurping every file the tsconfig's `include` matches — we add only the
  // entry file (below) and let dependency resolution pull its real closure.
  // No tsconfig → the original inline defaults, so a standalone file with no
  // project still works.
  const tsconfigPath = discoverTsConfig(filePath, options.tsconfig);

  const project = tsconfigPath
    ? new Project({ tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: true })
    : new Project({
        compilerOptions: {
          strict: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
        },
      });

  const sourceFile = project.addSourceFileAtPath(filePath);
  // Pull in files reachable via imports so cross-file types resolve when they
  // exist on disk. This adds the entry's real import closure only — NOT every
  // file the tsconfig `include` matches.
  project.resolveSourceFileDependencies();

  const preEmit = sourceFile.getPreEmitDiagnostics();
  const ctx: Ctx = {
    position: "input",
    failures: [],
    pendingWarnings: [],
    moduleDiagnostics: parseModuleDiagnostics(preEmit),
  };

  const tools: McpToolDefinition[] = [];
  const errors: ToolError[] = [];
  const warnings: string[] = [];
  const debugDump: Record<string, unknown>[] = [];

  const { toolFunctions, handled } = collectToolFunctions(sourceFile, errors);
  warnOnSkippedFunctionExports(sourceFile, handled, warnings);

  for (const { name, fn, docSource } of toolFunctions) {
    const { description, paramDocs } = getJsDocInfo(docSource);

    // Reset per-function collectors. Failures here exclude the function from
    // `tools`; pendingWarnings are committed only if the function emits.
    ctx.failures = [];
    ctx.pendingWarnings = [];

    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const paramDebug: Record<string, unknown>[] = [];

    ctx.position = "input";
    for (const param of fn.getParameters()) {
      const paramName = param.getName();
      const paramType = param.getType();
      const schema = typeToJsonSchema(ctx, paramType, param, `${name}(${paramName})`);
      const doc = paramDocs.get(paramName);
      if (doc && typeof schema === "object") schema.description = doc;
      properties[paramName] = schema;
      if (!param.isOptional()) required.push(paramName);

      if (debug) {
        paramDebug.push({ param: paramName, optional: param.isOptional(), raw: describeTypeRaw(paramType, param) });
      }
    }

    // Return position never blocks a function — failures degrade to a note.
    ctx.position = "return";
    const returnType = fn.getReturnType();
    const awaited = returnType.getSymbol()?.getName() === "Promise"
      ? returnType.getTypeArguments()[0] ?? returnType
      : returnType;
    const returnSchema =
      awaited.getText(fn) === "void"
        ? { $comment: "void" }
        : typeToJsonSchema(ctx, awaited, fn, `${name}(): return`);

    if (ctx.failures.length > 0) {
      const n = ctx.failures.length;
      errors.push({
        function: name,
        message: `excluded from tools: ${n} input parameter type${n > 1 ? "s" : ""} could not be converted to a JSON Schema`,
        failures: ctx.failures,
      });
      continue;
    }

    warnings.push(...ctx.pendingWarnings);
    tools.push({
      name,
      description: description ?? "",
      inputSchema: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
      _returnType: { text: returnType.getText(fn), awaitedSchema: returnSchema },
    });

    if (debug) {
      debugDump.push({
        function: name,
        params: paramDebug,
        returnTypeRaw: describeTypeRaw(returnType, fn),
      });
    }
  }

  const compilerDiagnostics = preEmit.map((d) => {
    const msg = d.getMessageText();
    return typeof msg === "string" ? msg : msg.getMessageText();
  });

  return {
    tools,
    errors,
    warnings,
    rawTypeDebug: debugDump,
    compilerDiagnostics,
    // After generation: entry + its real import closure only (generation adds
    // no files). The deterministic proof that the tsconfig's `include` was not
    // slurped in.
    project: { tsconfigPath, sourceFileCount: project.getSourceFiles().length },
  };
}
