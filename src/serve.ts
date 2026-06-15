/**
 * `mcp-gen serve <file.ts> [--port N]` — a runtime, not a code generator.
 *
 * Starts a live MCP server that exposes a TypeScript file's exported functions
 * as callable tools. No emitted artifacts, no build step:
 *
 *   - Schema bridge: the finished JSON Schema from generateTools() is fed
 *     straight into the SDK's LOW-LEVEL Server (ListTools/CallTool request
 *     handlers). The tools/list handler returns the generated tool objects
 *     verbatim — no zod conversion, no McpServer.registerTool.
 *   - Module loading + dispatch: delegated to the shared `loadCallableTools`
 *     seam (src/callable.ts), so `serve` and the `dev` playground run a tool
 *     through THE SAME code — same jiti loader, same named→positional bridge,
 *     same validate→await→throw→isError handling. serve only maps the seam's
 *     neutral InvokeOutcome onto the MCP wire (McpError vs. CallToolResult).
 *
 * Fail-loud carries over from the generator: functions generateTools excluded
 * (its `errors`) are not served and are logged to stderr with the reason; a
 * tool whose export is missing is skipped; and if nothing is servable we refuse
 * to start an empty server.
 *
 * Security: serve binds 127.0.0.1 (loopback) by DEFAULT — this server executes
 * local code when its tools are called, so it must not be reachable off-machine
 * unless the operator explicitly asks. `--host <addr>` opts into a different
 * interface (e.g. 0.0.0.0 for LAN exposure); choosing a non-loopback host prints
 * a loud one-line stderr warning, so the dangerous mode is never silent.
 */
import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { loadCallableTools, NoServableToolsError } from "./callable";
import { formatError } from "./cli";

// Re-exported so the CLI's `import { NoServableToolsError } from "./serve.js"`
// keeps working unchanged; the class itself now lives in the shared seam.
export { NoServableToolsError };

export interface ServeOptions {
  /** Path to the .ts file whose exported functions become tools. */
  file: string;
  /** Port to listen on. 0 selects an ephemeral port (used by the E2E test). */
  port?: number;
  /**
   * Bind address. Defaults to 127.0.0.1 (loopback only) — this server runs local
   * code on request, so it stays off the network unless the operator opts in.
   * Pass a non-loopback host (e.g. "0.0.0.0") to expose it; doing so logs a loud
   * stderr warning (see isLoopbackHost).
   */
  host?: string;
  /**
   * Explicit tsconfig.json path forwarded to generateTools. When omitted, the
   * generator discovers the nearest tsconfig by walking up from the file.
   */
  tsconfig?: string;
}

export interface ServeHandle {
  /** The full /mcp endpoint URL clients connect to. */
  url: string;
  /** The actual bound port (resolved when port 0 is requested). */
  port: number;
  /** The address the server bound to (e.g. "127.0.0.1" by default). */
  host: string;
  /** Names of the tools actually being served. */
  toolNames: string[];
  /** Shut the server down with no orphaned handles. */
  close: () => Promise<void>;
}

const DEFAULT_PORT = 3000;
/** Loopback-only by default: the served runtime executes local code on request. */
const DEFAULT_HOST = "127.0.0.1";

/**
 * Is `host` a loopback address — reachable only from this machine? Loopback is
 * "localhost", the IPv6 loopback "::1", and the entire IPv4 127.0.0.0/8 block.
 * Everything else (0.0.0.0 / :: wildcards, a specific LAN/WAN interface) is
 * off-machine reachable and triggers serve's exposure warning. Exported so the
 * CLI and tests share one definition of "safe to bind silently".
 */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export async function startServer(options: ServeOptions): Promise<ServeHandle> {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;

  // 1-3. Generate schemas, load the user's module, and build the callable
  //       registry — all through the shared seam, so serve and dev execute tools
  //       identically. May throw on a file-level failure (not found /
  //       unparseable); the CLI maps that to exit 2.
  const bundle = await loadCallableTools(options.file, { tsconfig: options.tsconfig });

  // Fail-loud carries over: functions generateTools excluded are not served.
  // Log them with the same human-readable formatting the schema CLI uses.
  for (const e of bundle.errors) console.error(formatError(e));
  for (const w of bundle.warnings) console.error(`warning: ${w}`);
  // A generated tool with no matching runtime export is skipped (logged here).
  for (const s of bundle.skipped) {
    console.error(
      `error: ${s.name}: no matching export in ${options.file} ` +
        `(expected an exported function named '${s.name}') — skipping.`,
    );
  }

  // 4. Never start an empty server (serve-only policy; the seam stays neutral).
  if (bundle.tools.length === 0) {
    throw new NoServableToolsError(
      `No servable tools in ${options.file}: every exported function was excluded ` +
        `by the generator or had no matching runtime export.`,
    );
  }

  // 5. Low-level SDK Server. tools/list returns the generated tool objects
  //    verbatim — the raw JSON Schema flows through untouched.
  const server = new Server(
    { name: "mcp-gen", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: bundle.tools.map(
      (t): Tool => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Tool["inputSchema"],
      }),
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = req.params;

    // Dispatch through the shared seam, then map its neutral outcome onto the MCP
    // wire. unknownTool / invalidParams are malformed call shapes → JSON-RPC
    // PROTOCOL errors (MethodNotFound -32601 / InvalidParams -32602). A tool that
    // runs and throws is a business error → isError:true (NOT a protocol error).
    const outcome = await bundle.invoke(name, (rawArgs ?? {}) as Record<string, unknown>);
    switch (outcome.kind) {
      case "unknownTool":
        throw new McpError(ErrorCode.MethodNotFound, outcome.message);
      case "invalidParams":
        throw new McpError(ErrorCode.InvalidParams, outcome.message);
      case "toolError":
        return { content: [{ type: "text", text: outcome.message }], isError: true };
      case "ok":
        return { content: [{ type: "text", text: outcome.text }] };
    }
  });

  // 6. Stateful Streamable HTTP transport over a node:http server.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (reqUrl.pathname === "/mcp") {
      transport.handleRequest(req, res).catch((err: unknown) => {
        console.error(
          `error handling /mcp request: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (!res.headersSent) res.writeHead(500).end();
      });
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
    }
  });

  // 7. Loopback by default. A non-loopback host means this arbitrary-code
  //    endpoint is reachable off-machine with NO authentication — make that loud
  //    and deliberate by warning BEFORE we bind, never silent.
  if (!isLoopbackHost(host)) {
    console.error(
      `warning: serve is binding ${host} — this server executes local code when its tools are ` +
        `called and is now reachable from other machines on the network with NO authentication; ` +
        `omit --host (or pass --host 127.0.0.1) to keep it loopback-only.`,
    );
  }

  const actualPort = await listen(httpServer, port, host);
  const url = `http://${displayHost(host)}:${actualPort}/mcp`;
  const toolNames = bundle.toolNames;

  // 8. On startup, log the listening URL and the served tool names to stderr.
  console.error(`mcp-gen serve listening on ${url}`);
  console.error(
    `serving ${toolNames.length} tool${toolNames.length === 1 ? "" : "s"}: ${toolNames.join(", ")}`,
  );

  const close = async (): Promise<void> => {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return { url, port: actualPort, host, toolNames, close };
}

/**
 * The address a local client uses in the printed URL. A wildcard bind (0.0.0.0 /
 * ::) isn't itself connectable, so show "localhost"; the loopback default is also
 * shown as "localhost" (unchanged from before). An explicit interface is shown
 * verbatim (IPv6 literals bracketed) so the printed URL is actually reachable.
 */
function displayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "127.0.0.1" || host === "localhost") {
    return "localhost";
  }
  return host.includes(":") ? `[${host}]` : host;
}

function listen(httpServer: HttpServer, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", onError);
      const addr = httpServer.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("could not determine the listening port"));
    });
  });
}
