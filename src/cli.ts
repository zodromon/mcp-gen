/**
 * CLI wrapper around generateTools() — the WI-2 fail-loud contract.
 *
 * Exit codes:
 *   0 — every exported function converted cleanly.
 *   1 — one or more functions failed. Clean functions are still emitted in
 *       `tools`; failed ones are excluded and listed in `errors`.
 *   2 — file-level failure (file not found / unparseable).
 *
 * stdout is machine-readable JSON (always carries `tools`; carries `errors`
 * when any function failed). Human-readable errors and warnings go to stderr.
 *
 * Subcommand routing lives in `dispatch()`: `mcp-gen serve <file.ts>` starts a
 * live MCP server (async, never exits on success); `mcp-gen check <file.ts>`
 * snapshots/diffs the tool surface as a CI contract guardrail; everything else
 * is the unchanged schema-generation path below.
 */
import * as fs from "node:fs";
import { generateTools, ToolError } from "./generate";
import {
  diffToolSurfaces,
  formatChangesHuman,
  parseSnapshot,
  serializeSnapshot,
  surfaceFromTools,
} from "./check";

const DEFAULT_SERVE_PORT = 3000;
const DEFAULT_DEV_PORT = 4000;

/**
 * Top-level argv dispatch. `serve` → the live MCP server (async). `check` → the
 * tool-surface contract guardrail (sync). Anything else → the schema-generation
 * path, whose behavior is byte-for-byte unchanged (same stdout JSON, same exit
 * codes). Returns a number for the sync paths and a Promise for the async serve
 * path; the bin entry handles both.
 */
export function dispatch(argv: string[]): number | Promise<number> {
  if (argv[0] === "serve") return runServe(argv.slice(1));
  if (argv[0] === "dev") return runDev(argv.slice(1));
  if (argv[0] === "check") return runCheck(argv.slice(1));
  return runCli(argv);
}

export function runCli(argv: string[]): number {
  const debug = argv.includes("--debug");
  const { tsconfig, positional } = parseGenerateArgs(argv);
  const filePath = positional[0];

  if (!filePath) {
    console.error("Usage: mcp-gen <file.ts> [--debug] [--tsconfig <path>]");
    return 2;
  }

  let result;
  try {
    result = generateTools(filePath, { debug, tsconfig });
  } catch (err) {
    // File not found, unparseable, or any other file-level failure.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: cannot read or parse ${filePath}: ${msg}`);
    return 2;
  }

  const { tools, errors, warnings, rawTypeDebug, compilerDiagnostics } = result;

  // --- human-readable -> stderr ---
  if (tools.length === 0 && errors.length === 0 && warnings.length === 0) {
    console.error(`No exported functions found in ${filePath}`);
  }
  for (const e of errors) {
    console.error(formatError(e));
  }
  for (const w of warnings) {
    console.error(`warning: ${w}`);
  }

  // --- machine-readable JSON -> stdout ---
  const out: Record<string, unknown> = { tools };
  if (errors.length > 0) out.errors = errors;
  if (warnings.length > 0) out.warnings = warnings;
  if (debug) out.rawTypeDebug = rawTypeDebug;
  if (compilerDiagnostics.length > 0) out.compilerDiagnostics = compilerDiagnostics;
  console.log(JSON.stringify(out, null, 2));

  return errors.length > 0 ? 1 : 0;
}

/**
 * The serve subcommand: `mcp-gen serve <file.ts> [--port N] [--host <addr>]`.
 *
 * Binds 127.0.0.1 (loopback) by default — the served runtime executes local code
 * on request, so it stays off-network unless `--host` opts in (e.g. 0.0.0.0 for
 * LAN exposure, which logs a loud warning). `dev` has no `--host` and is always
 * loopback.
 *
 * Returns an exit code; on a successful start it returns 0 but the process
 * stays alive because the HTTP server keeps the event loop busy. The serve
 * runtime (and its SDK/loader deps) is loaded dynamically so the
 * schema-generation path never pays for importing it.
 *
 *   exit 0 — server started (and is now running).
 *   exit 2 — bad usage, nothing servable, or a file-level failure.
 *   exit 1 — the serve runtime could not be loaded.
 */
export async function runServe(argv: string[]): Promise<number> {
  const parsed = parseServerArgs(argv, DEFAULT_SERVE_PORT, { acceptHost: true });
  if (parsed.error) {
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  if (!parsed.file) {
    console.error(
      "Usage: mcp-gen serve <file.ts> [--port N] [--host <addr>] [--tsconfig <path>]\n" +
        "       Binds 127.0.0.1 (loopback) by default; pass --host 0.0.0.0 to expose on the network.",
    );
    return 2;
  }

  let startServer: typeof import("./serve.js").startServer;
  let NoServableToolsError: typeof import("./serve.js").NoServableToolsError;
  try {
    ({ startServer, NoServableToolsError } = await import("./serve.js"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: failed to load the serve runtime: ${msg}`);
    return 1;
  }

  try {
    await startServer({
      file: parsed.file,
      port: parsed.port,
      host: parsed.host,
      tsconfig: parsed.tsconfig,
    });
    return 0;
  } catch (err) {
    if (err instanceof NoServableToolsError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    // generateTools throwing (file not found / unparseable) or any other
    // startup failure — a file-level failure, same exit code as the generator.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: cannot serve ${parsed.file}: ${msg}`);
    return 2;
  }
}

/**
 * The dev subcommand: `mcp-gen dev <file.ts> [--port N] [--tsconfig <path>]`.
 *
 * Starts the live playground (a localhost web UI over the same callable seam as
 * serve). Mirrors serve's exit-code discipline and dynamic-loading strategy: the
 * dev runtime (HTTP server, watcher, jiti loader) is imported lazily so the
 * schema-generation path never pays for it.
 *
 *   exit 0 — playground started (and is now running).
 *   exit 2 — bad usage, nothing servable, or a file-level failure.
 *   exit 1 — the dev runtime could not be loaded.
 */
export async function runDev(argv: string[]): Promise<number> {
  const parsed = parseServerArgs(argv, DEFAULT_DEV_PORT);
  if (parsed.error) {
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  if (!parsed.file) {
    console.error("Usage: mcp-gen dev <file.ts> [--port N] [--tsconfig <path>]");
    return 2;
  }

  let startDevServer: typeof import("./dev.js").startDevServer;
  let NoServableToolsError: typeof import("./serve.js").NoServableToolsError;
  try {
    ({ startDevServer } = await import("./dev.js"));
    ({ NoServableToolsError } = await import("./serve.js"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: failed to load the dev runtime: ${msg}`);
    return 1;
  }

  try {
    await startDevServer({ file: parsed.file, port: parsed.port, tsconfig: parsed.tsconfig });
    return 0;
  } catch (err) {
    if (err instanceof NoServableToolsError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: cannot serve ${parsed.file}: ${msg}`);
    return 2;
  }
}

/**
 * The check subcommand: `mcp-gen check <file.ts> [--update] [--snapshot <path>]
 * [--tsconfig <path>]` — a contract guardrail for the generated tool surface.
 * It's tsc for the tool surface: a committed snapshot teams put in CI so an
 * agent-facing tool can't silently break.
 *
 *   --update → generate the current surface, write the normalized snapshot,
 *              exit 0 (the `jest -u` of tool contracts).
 *   check    → generate current, load snapshot, diff. Machine-readable JSON of
 *              ALL changes goes to stdout (consistent with the generate path);
 *              human-readable changes go to stderr.
 *
 *   exit 0 — no BREAKING changes (SAFE/NOTICE are reported but never fail).
 *   exit 1 — at least one BREAKING change (a tool removed/renamed, a property
 *            removed, a new required param, optional→required, a type change, an
 *            enum value removed, or a nested sub-schema change).
 *   exit 2 — file-level failure, bad usage, or a missing snapshot (never
 *            silently created — prints the create-baseline hint).
 *
 * Per-function generation errors are NOT file-level: a tool that now fails to
 * convert drops out of the surface and the diff reports it as a BREAKING
 * removal (exit 1) — fail-loud carries straight through to the contract.
 */
export function runCheck(argv: string[]): number {
  const parsed = parseCheckArgs(argv);
  if (parsed.error) {
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  if (!parsed.file) {
    console.error(
      "Usage: mcp-gen check <file.ts> [--update] [--snapshot <path>] [--tsconfig <path>]",
    );
    return 2;
  }
  const snapshotPath = parsed.snapshot ?? defaultSnapshotPath(parsed.file);

  // 1. Generate the current surface. A throw is a file-level failure (file not
  //    found / unparseable) → exit 2, exactly like the generate path.
  let result;
  try {
    result = generateTools(parsed.file, { tsconfig: parsed.tsconfig });
  } catch (err) {
    console.error(`error: cannot read or parse ${parsed.file}: ${errMessage(err)}`);
    return 2;
  }

  // Per-function failures are context, not a file-level failure: surface them on
  // stderr (the dropped tools show up as BREAKING removals in the diff below).
  for (const e of result.errors) console.error(formatError(e));
  for (const w of result.warnings) console.error(`warning: ${w}`);

  const currentSurface = surfaceFromTools(result.tools);

  // 2a. --update: write the normalized snapshot and exit 0.
  if (parsed.update) {
    try {
      fs.writeFileSync(snapshotPath, serializeSnapshot(currentSurface));
    } catch (err) {
      console.error(`error: cannot write snapshot ${snapshotPath}: ${errMessage(err)}`);
      return 2;
    }
    const n = currentSurface.length;
    console.error(`wrote tool-surface snapshot to ${snapshotPath} (${n} tool${n === 1 ? "" : "s"})`);
    console.log(
      JSON.stringify(
        { action: "update", snapshot: snapshotPath, tools: currentSurface.map((t) => t.name) },
        null,
        2,
      ),
    );
    return 0;
  }

  // 2b. check: load the snapshot. A missing snapshot is exit 2 — never silently
  //     created in CI — with the explicit create-baseline hint.
  if (!fs.existsSync(snapshotPath)) {
    console.error(
      `error: no tool-surface snapshot at ${snapshotPath}\n` +
        `       run "mcp-gen check ${parsed.file} --update" to create a baseline.`,
    );
    return 2;
  }
  let oldSurface;
  try {
    oldSurface = parseSnapshot(fs.readFileSync(snapshotPath, "utf8"));
  } catch (err) {
    console.error(`error: cannot read snapshot ${snapshotPath}: ${errMessage(err)}`);
    return 2;
  }

  // 3. Diff and classify. check fails iff any BREAKING change exists.
  const changes = diffToolSurfaces(oldSurface, currentSurface);
  const summary = {
    breaking: changes.filter((c) => c.severity === "BREAKING").length,
    safe: changes.filter((c) => c.severity === "SAFE").length,
    notice: changes.filter((c) => c.severity === "NOTICE").length,
  };

  // stdout: machine-readable JSON of ALL changes (consistent with generate).
  console.log(
    JSON.stringify(
      { file: parsed.file, snapshot: snapshotPath, ok: summary.breaking === 0, summary, changes },
      null,
      2,
    ),
  );

  // stderr: human-readable.
  if (changes.length > 0) console.error(formatChangesHuman(changes));
  if (summary.breaking > 0) {
    console.error(
      `check FAILED: ${summary.breaking} breaking change${summary.breaking === 1 ? "" : "s"} to the tool surface ` +
        `(run "mcp-gen check ${parsed.file} --update" to accept the new contract).`,
    );
    return 1;
  }
  console.error(`check OK: no breaking changes (${summary.safe} safe, ${summary.notice} notice).`);
  return 0;
}

/** Default snapshot path: a `.mcp-snapshot.json` sibling of the entry file. */
function defaultSnapshotPath(file: string): string {
  return `${file}.mcp-snapshot.json`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface CheckArgs {
  file?: string;
  update: boolean;
  snapshot?: string;
  tsconfig?: string;
  error?: string;
}

/**
 * Parse the check path's argv: the positional file, `--update`, and the
 * value-taking `--snapshot` / `--tsconfig` (both `--flag value` and
 * `--flag=value`). Their values are consumed here so a path is never mistaken
 * for the input file. Unknown flags are ignored, matching the generate path.
 */
function parseCheckArgs(argv: string[]): CheckArgs {
  let file: string | undefined;
  let snapshot: string | undefined;
  let tsconfig: string | undefined;
  let update = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update") {
      update = true;
    } else if (a === "--snapshot") {
      snapshot = argv[++i];
      if (snapshot === undefined) return { update, error: "--snapshot requires a path" };
    } else if (a.startsWith("--snapshot=")) {
      snapshot = a.slice("--snapshot=".length);
    } else if (a === "--tsconfig") {
      tsconfig = argv[++i];
      if (tsconfig === undefined) return { update, error: "--tsconfig requires a path" };
    } else if (a.startsWith("--tsconfig=")) {
      tsconfig = a.slice("--tsconfig=".length);
    } else if (!a.startsWith("--") && file === undefined) {
      file = a;
    }
  }
  return { file, update, snapshot, tsconfig };
}

/**
 * Parse the generate path's argv: `--tsconfig <path>` (or `--tsconfig=<path>`)
 * plus the positional file argument. `--tsconfig`'s value is consumed here so a
 * relative path is never mistaken for the input file; `--debug` is read
 * separately by the caller and ignored as a positional. Behavior with no
 * `--tsconfig` is unchanged: positional[0] is the first non-flag argument.
 */
function parseGenerateArgs(argv: string[]): { tsconfig?: string; positional: string[] } {
  let tsconfig: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tsconfig") {
      tsconfig = argv[++i];
    } else if (a.startsWith("--tsconfig=")) {
      tsconfig = a.slice("--tsconfig=".length);
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
  }
  return { tsconfig, positional };
}

interface ServerArgs {
  file?: string;
  port: number;
  /** Explicit bind address; only ever set on the serve path (see acceptHost). */
  host?: string;
  tsconfig?: string;
  error?: string;
}

interface ServerArgsOptions {
  /**
   * Whether `--host <addr>` is a valid flag. ONLY serve sets this. dev is
   * hard-bound to 127.0.0.1 for safety (loopback + the Host/Origin/JSON guard),
   * so it rejects `--host` outright rather than letting the flag weaken its
   * binding — dev's behavior is otherwise unchanged.
   */
  acceptHost?: boolean;
}

/**
 * Parse the argv shared by the `serve` and `dev` runtimes: a positional file,
 * `--port N` (or `--port=N`, validated 0-65535), and `--tsconfig <path>` (whose
 * value is consumed here so a path is never mistaken for the input file).
 * `defaultPort` differs per subcommand (serve 3000, dev 4000).
 *
 * `--host <addr>` (or `--host=<addr>`) is serve-only and gated by
 * `opts.acceptHost`. When serve enables it, its value is consumed here (so an
 * address is never mistaken for the input file) and surfaced as `host`. When dev
 * leaves it disabled, `--host` is REJECTED with an error — dev never binds
 * anything but 127.0.0.1. Exported for unit tests.
 */
export function parseServerArgs(
  argv: string[],
  defaultPort: number,
  opts: ServerArgsOptions = {},
): ServerArgs {
  const acceptHost = opts.acceptHost ?? false;
  let port = defaultPort;
  let file: string | undefined;
  let host: string | undefined;
  let tsconfig: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const raw = argv[++i];
      const v = Number(raw);
      if (raw === undefined || !Number.isInteger(v) || v < 0 || v > 65535) {
        return { file, port, host, error: "--port requires an integer in 0-65535" };
      }
      port = v;
    } else if (a.startsWith("--port=")) {
      const v = Number(a.slice("--port=".length));
      if (!Number.isInteger(v) || v < 0 || v > 65535) {
        return { file, port, host, error: "--port requires an integer in 0-65535" };
      }
      port = v;
    } else if (a === "--host" || a.startsWith("--host=")) {
      if (!acceptHost) {
        return {
          file,
          port,
          error: "--host is not supported for dev (the playground always binds 127.0.0.1)",
        };
      }
      if (a === "--host") {
        host = argv[++i];
        if (host === undefined) return { file, port, error: "--host requires an address" };
      } else {
        host = a.slice("--host=".length);
        if (host === "") return { file, port, error: "--host requires an address" };
      }
    } else if (a === "--tsconfig") {
      tsconfig = argv[++i];
    } else if (a.startsWith("--tsconfig=")) {
      tsconfig = a.slice("--tsconfig=".length);
    } else if (!a.startsWith("--") && file === undefined) {
      file = a;
    }
  }
  return { file, port, host, tsconfig };
}

/** Render one function-level failure as human-readable stderr lines. */
export function formatError(e: ToolError): string {
  const lines = [`error: ${e.function ?? "<anonymous>"}: ${e.message}`];
  for (const f of e.failures ?? []) {
    lines.push(`  at ${f.parameterPath}: type '${f.typeText}' — ${f.reason}`);
    lines.push(`  fix: ${f.hint}`);
  }
  return lines.join("\n");
}
