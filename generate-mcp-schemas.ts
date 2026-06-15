#!/usr/bin/env node
/**
 * CLI entry point: generate MCP tool definitions from exported functions in a .ts file.
 *
 * Distributed as the `mcp-gen` executable. After `npm run build`, runs as plain
 * `node dist/generate-mcp-schemas.js <file.ts>` (no tsx) or via the `mcp-gen` bin.
 * The shebang above is preserved by tsc into the emitted JS so the built file is
 * directly executable.
 *
 * Usage:
 *   mcp-gen <file.ts> [--debug]
 *   node dist/generate-mcp-schemas.js <file.ts> [--debug]
 *   npx tsx generate-mcp-schemas.ts <file.ts> [--debug]   # dev (TS source, no build)
 *
 * --debug dumps raw compiler-level type info (type flags, symbol info, apparent
 * type) for every parameter/return type alongside the generated schema, so
 * failures can be inspected.
 *
 * `mcp-gen serve <file.ts> [--port N]` instead starts a live MCP server that
 * exposes the file's exported functions as callable tools (a runtime, not a
 * code generator). That path is async and keeps the process alive.
 *
 * Implementation lives in src/generate.ts (library) and src/cli.ts (CLI shell).
 */
import { dispatch } from "./src/cli";

const result = dispatch(process.argv.slice(2));
if (typeof result === "number") {
  // Schema-generation path: synchronous, sets the exit code and returns.
  process.exitCode = result;
} else {
  // Serve path: async. On a clean start the server keeps running (the listening
  // socket holds the event loop open); only a non-zero code forces an exit.
  result.then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
